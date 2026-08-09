import { describe, it, expect, afterAll, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { LiveEvent } from "../services/conversation-bus.js";

// Nothing here writes a memory file, but the module graph reaches `storage.ts`,
// which freezes `homedir()`-derived roots at import. Pointing HOME at a temp dir
// first is the house rule and costs nothing.
const tmpHome = mkdtempSync(join(tmpdir(), "explainer-floor-"));
process.env.HOME = tmpHome;

// Both windows are read at call time, so the whole grace/TTL behaviour can be
// exercised in milliseconds instead of forty-five real seconds.
process.env.EXPLAINER_FLOOR_GRACE_MS = "80";
process.env.EXPLAINER_FLOOR_REQUEST_TTL_MS = "120";

const floor = await import("../services/floor.js");
const bus = await import("../services/conversation-bus.js");

afterAll(() => {
  delete process.env.EXPLAINER_FLOOR_GRACE_MS;
  delete process.env.EXPLAINER_FLOOR_REQUEST_TTL_MS;
  rmSync(tmpHome, { recursive: true, force: true });
});

let conversationId = randomUUID();
let seen: LiveEvent[] = [];
let stop: (() => void) | null = null;

beforeEach(() => {
  conversationId = randomUUID();
  seen = [];
  stop = bus.subscribe(conversationId, ({ event }) => {
    seen.push(event);
  });
});

afterEach(() => {
  stop?.();
  stop = null;
  floor.forgetFloor(conversationId);
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function floorEvents(): Extract<LiveEvent, { type: "floor.changed" }>[] {
  return seen.filter(
    (event): event is Extract<LiveEvent, { type: "floor.changed" }> =>
      event.type === "floor.changed",
  );
}

describe("claiming the floor", () => {
  it("hands a free microphone to whoever asks first", () => {
    const result = floor.claimFloor(conversationId, "client-a", "Rodrigo");

    expect(result.ok).toBe(true);
    expect(floor.getFloor(conversationId)).toMatchObject({
      client_id: "client-a",
      name: "Rodrigo",
    });
    expect(floorEvents()).toEqual([
      { type: "floor.changed", holder: "client-a", name: "Rodrigo" },
    ]);
  });

  it("refuses the second claimant and names who has it", () => {
    floor.claimFloor(conversationId, "client-a", "Rodrigo");
    const result = floor.claimFloor(conversationId, "client-b", "Ana");

    expect(result.ok).toBe(false);
    // A bare "busy" leaves the caller with no way to decide between waiting and
    // asking, which is the whole choice this refusal exists to offer.
    expect(result.floor).toMatchObject({ client_id: "client-a", name: "Rodrigo" });
    expect(floorEvents()).toHaveLength(1);
  });

  it("lets the holder re-claim without redrawing every other screen", () => {
    floor.claimFloor(conversationId, "client-a", "Rodrigo");
    const again = floor.claimFloor(conversationId, "client-a", "Rodrigo");

    expect(again).toMatchObject({ ok: true, alreadyMine: true });
    expect(floorEvents()).toHaveLength(1);
  });

  it("only lets the holder release it", () => {
    floor.claimFloor(conversationId, "client-a", "Rodrigo");

    expect(floor.releaseFloor(conversationId, "client-b")).toBe(false);
    expect(floor.getFloor(conversationId)).not.toBeNull();

    expect(floor.releaseFloor(conversationId, "client-a")).toBe(true);
    expect(floor.getFloor(conversationId)).toBeNull();
    expect(floorEvents().at(-1)).toEqual({
      type: "floor.changed",
      holder: null,
      name: null,
    });
  });

  it("answers holdsFloor only for the holder, and never for an anonymous caller", () => {
    floor.claimFloor(conversationId, "client-a", "Rodrigo");

    expect(floor.holdsFloor(conversationId, "client-a")).toBe(true);
    expect(floor.holdsFloor(conversationId, "client-b")).toBe(false);
    // The gate in `POST /api/realtime/session` leans on this: a caller that does
    // not say who it is cannot be the holder.
    expect(floor.holdsFloor(conversationId, null)).toBe(false);
  });
});

describe("the /live connection as the heartbeat", () => {
  it("releases a floor whose client never opened a stream", async () => {
    floor.claimFloor(conversationId, "client-a", "Rodrigo");

    await sleep(160);

    expect(floor.getFloor(conversationId)).toBeNull();
    expect(floorEvents().at(-1)).toMatchObject({ holder: null });
  });

  it("holds the floor for as long as a stream is open", async () => {
    floor.claimFloor(conversationId, "client-a", "Rodrigo");
    floor.connectionOpened(conversationId, "client-a");

    await sleep(160);

    expect(floor.getFloor(conversationId)).toMatchObject({ client_id: "client-a" });
  });

  it("releases it once the last stream has been gone for the grace window", async () => {
    floor.claimFloor(conversationId, "client-a", "Rodrigo");
    floor.connectionOpened(conversationId, "client-a");
    floor.connectionClosed(conversationId, "client-a");

    await sleep(160);

    expect(floor.getFloor(conversationId)).toBeNull();
  });

  it("survives a reconnect inside the grace window", async () => {
    floor.claimFloor(conversationId, "client-a", "Rodrigo");
    floor.connectionOpened(conversationId, "client-a");
    floor.connectionClosed(conversationId, "client-a");

    await sleep(40);
    floor.connectionOpened(conversationId, "client-a");
    await sleep(160);

    // A tunnel, a lock screen or a wifi handover must not cost the microphone.
    expect(floor.getFloor(conversationId)).toMatchObject({ client_id: "client-a" });
  });

  it("survives closing one of two tabs", async () => {
    floor.claimFloor(conversationId, "client-a", "Rodrigo");
    floor.connectionOpened(conversationId, "client-a");
    floor.connectionOpened(conversationId, "client-a");
    floor.connectionClosed(conversationId, "client-a");

    await sleep(160);

    expect(floor.getFloor(conversationId)).toMatchObject({ client_id: "client-a" });
  });

  it("ignores a spectator's stream closing", async () => {
    floor.claimFloor(conversationId, "client-a", "Rodrigo");
    floor.connectionOpened(conversationId, "client-a");
    floor.connectionOpened(conversationId, "client-b");
    floor.connectionClosed(conversationId, "client-b");

    await sleep(160);

    expect(floor.getFloor(conversationId)).toMatchObject({ client_id: "client-a" });
  });
});

describe("asking for the floor", () => {
  it("announces the request instead of taking anything", () => {
    floor.claimFloor(conversationId, "client-a", "Rodrigo");
    floor.requestFloor(conversationId, "client-b", "Ana");

    // No forced take-over: the holder is still the holder, and the only thing
    // that happened is that they were asked.
    expect(floor.getFloor(conversationId)).toMatchObject({ client_id: "client-a" });
    expect(seen.at(-1)).toEqual({
      type: "floor.requested",
      client_id: "client-b",
      name: "Ana",
    });
  });

  it("keeps one slot, and the last asker wins it", () => {
    floor.claimFloor(conversationId, "client-a", "Rodrigo");
    floor.requestFloor(conversationId, "client-b", "Ana");
    floor.requestFloor(conversationId, "client-c", "Bruno");

    expect(floor.getFloorRequest(conversationId)).toEqual({
      client_id: "client-c",
      name: "Bruno",
    });
  });

  it("forgets a request nobody answered", async () => {
    floor.claimFloor(conversationId, "client-a", "Rodrigo");
    floor.requestFloor(conversationId, "client-b", "Ana");

    await sleep(180);

    expect(floor.getFloorRequest(conversationId)).toBeNull();
  });

  it("drops the pending request when the microphone changes hands", () => {
    floor.claimFloor(conversationId, "client-a", "Rodrigo");
    floor.requestFloor(conversationId, "client-b", "Ana");
    floor.releaseFloor(conversationId, "client-a");
    floor.claimFloor(conversationId, "client-b", "Ana");

    expect(floor.getFloorRequest(conversationId)).toBeNull();
  });
});

describe("names and ids off the wire", () => {
  it("collapses whitespace and caps a name", () => {
    expect(floor.normalizeName("  Ana   Maria \n")).toBe("Ana Maria");
    expect(floor.normalizeName("x".repeat(200))).toHaveLength(60);
  });

  it("falls back rather than showing an empty speaker", () => {
    expect(floor.normalizeName("   ")).toBe("Alguém");
    expect(floor.normalizeName(42)).toBe("Alguém");
  });

  it("rejects a client id that is not a non-empty string", () => {
    expect(floor.normalizeClientId("")).toBeNull();
    expect(floor.normalizeClientId("  ")).toBeNull();
    expect(floor.normalizeClientId(undefined)).toBeNull();
    // Express hands a repeated query parameter over as an array.
    expect(floor.normalizeClientId(["client-a", "client-b"])).toBe("client-a");
  });
});
