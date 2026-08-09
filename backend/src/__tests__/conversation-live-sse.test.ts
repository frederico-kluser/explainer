import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { ToolOutcome } from "../services/tool-executor.js";
import type {
  ClientSecret,
  RealtimeSessionConfig,
  TextCompletion,
} from "../services/openai.js";
import type { ResolvedSource } from "../types/index.js";

const tmpHome = mkdtempSync(join(tmpdir(), "explainer-live-sse-"));
process.env.HOME = tmpHome;
delete process.env.OPENAI_API_KEY;

// ---------------------------------------------------------------------------
// Everything that could reach the model is a counting stub
// ---------------------------------------------------------------------------
//
// Not only so this file never opens a socket. The counter is the evidence for
// the invariant at the bottom of the file: a whole `/live` lifecycle — connect,
// receive, reconnect with `Last-Event-ID`, disconnect — must leave it empty.

let modelCalls: string[] = [];
let minted: RealtimeSessionConfig | null = null;

function completion(text: string): TextCompletion {
  return {
    text,
    usage: { input_tokens: 1, output_tokens: 1 },
    model: "gpt-5.2-mini",
    status: "completed",
    truncated: false,
  };
}

vi.mock("../services/openai.js", async () => {
  const actual = await vi.importActual<typeof import("../services/openai.js")>(
    "../services/openai.js",
  );
  return {
    ...actual,
    mintRealtimeClientSecret: async (
      session: RealtimeSessionConfig,
    ): Promise<ClientSecret> => {
      modelCalls.push("mintRealtimeClientSecret");
      minted = session;
      return { value: "ek_test", expires_at: 0, session: {} };
    },
    completeText: async (): Promise<TextCompletion> => {
      modelCalls.push("completeText");
      return completion("resumo");
    },
  };
});

let outcome: () => Promise<ToolOutcome> = async () => ({ output: "ok" });

vi.mock("../services/tool-executor.js", async () => {
  const actual = await vi.importActual<typeof import("../services/tool-executor.js")>(
    "../services/tool-executor.js",
  );
  return {
    ...actual,
    executeTool: () => {
      modelCalls.push("executeTool");
      return outcome();
    },
  };
});

const material: ResolvedSource = {
  id: "src-1",
  kind: "repo",
  label: "explainer",
  root: "/srv/explainer",
  origin: "/srv/explainer",
  resolved_at: new Date().toISOString(),
};

vi.mock("../services/source-store.js", async () => {
  const actual = await vi.importActual<typeof import("../services/source-store.js")>(
    "../services/source-store.js",
  );
  return { ...actual, listSources: async () => [material] };
});

const express = (await import("express")).default;
const conversationsRouter = (await import("../routes/conversations.js")).default;
const liveRouter = (await import("../routes/live.js")).default;
const realtimeRouter = (await import("../routes/realtime.js")).default;
const { errorHandler } = await import("../middleware/error-handler.js");
const storage = await import("../services/storage.js");
const bus = await import("../services/conversation-bus.js");
const floor = await import("../services/floor.js");

const app = express();
app.use(express.json());
app.use("/api/conversations", conversationsRouter);
app.use("/api/conversations", liveRouter);
app.use("/api/realtime", realtimeRouter);
app.use(errorHandler);

const server: Server = app.listen(0);
const port = (server.address() as AddressInfo).port;
const conversations = `http://127.0.0.1:${port}/api/conversations`;
const realtime = `http://127.0.0.1:${port}/api/realtime`;

let conversationId = "";
const open: LiveClient[] = [];

beforeEach(async () => {
  conversationId = (await storage.createConversation("Conversa compartilhada")).id;
  modelCalls = [];
  minted = null;
  outcome = async () => ({ output: "ok" });
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((client) => client.close()));
  floor.forgetFloor(conversationId);
  bus.forgetConversation(conversationId);
});

afterAll(() => {
  server.close();
  rmSync(tmpHome, { recursive: true, force: true });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// A real SSE client, over a real socket
// ---------------------------------------------------------------------------

interface Frame {
  id: string | null;
  data: Record<string, unknown>;
}

interface LiveClient {
  frames: Frame[];
  lastEventId(): string | null;
  of(type: string): Frame[];
  waitFor(type: string): Promise<Frame>;
  close(): Promise<void>;
}

async function openLive(
  options: { clientId?: string; lastEventId?: string | null; since?: number } = {},
): Promise<LiveClient> {
  const params = new URLSearchParams();
  if (options.clientId) params.set("client_id", options.clientId);
  if (options.since !== undefined) params.set("since", String(options.since));

  const controller = new AbortController();
  const headers: Record<string, string> = {};
  if (options.lastEventId) headers["Last-Event-ID"] = options.lastEventId;

  const res = await fetch(`${conversations}/${conversationId}/live?${params}`, {
    headers,
    signal: controller.signal,
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  expect(res.headers.get("x-accel-buffering")).toBe("no");

  const frames: Frame[] = [];
  let cursor: string | null = null;

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const pump = (async () => {
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() ?? "";
        for (const chunk of chunks) {
          let id: string | null = null;
          let payload: string | null = null;
          for (const line of chunk.split("\n")) {
            if (line.startsWith("id:")) id = line.slice(3).trim();
            else if (line.startsWith("data:")) payload = line.slice(5).trim();
          }
          // `retry:` and the keep-alive comment carry no data and are not events.
          if (payload === null) continue;
          if (id !== null) cursor = id;
          frames.push({ id, data: JSON.parse(payload) as Record<string, unknown> });
        }
      }
    } catch {
      // The abort below is how a client leaves.
    }
  })();

  const client: LiveClient = {
    frames,
    lastEventId: () => cursor,
    of: (type) => frames.filter((frame) => frame.data.type === type),
    waitFor: async (type) => {
      const deadline = Date.now() + 2_000;
      for (;;) {
        const hit = frames.find((frame) => frame.data.type === type);
        if (hit) return hit;
        if (Date.now() > deadline) {
          throw new Error(`no "${type}" arrived; saw ${JSON.stringify(frames)}`);
        }
        await sleep(5);
      }
    },
    close: async () => {
      controller.abort();
      await pump;
      // Let the server's `close` handler run before the next assertion reads
      // the viewer count it maintains.
      await sleep(20);
    },
  };

  open.push(client);
  return client;
}

async function postTurn(content: string, role = "user"): Promise<Response> {
  return fetch(`${conversations}/${conversationId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role, content }] }),
  });
}

async function mint(body: Record<string, unknown> = {}): Promise<Response> {
  return fetch(`${realtime}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversation_id: conversationId, ...body }),
  });
}

// ---------------------------------------------------------------------------

describe("GET /api/conversations/:id/live", () => {
  it("rejects an id that is not a conversation", async () => {
    const res = await fetch(`${conversations}/not-a-uuid/live`);
    expect(res.status).toBe(400);
  });

  it("delivers to the second person the turn the first one persisted", async () => {
    const spectator = await openLive({ clientId: "client-b" });
    await spectator.waitFor("presence.changed");

    const res = await postTurn("Como o sandbox contém os caminhos?");
    expect(res.status).toBe(201);

    const frame = await spectator.waitFor("message.appended");
    expect(frame.data.messages).toMatchObject([
      { role: "user", content: "Como o sandbox contém os caminhos?" },
    ]);
    // Announced only once the turn is durable, so a client that reacts by
    // refetching the conversation finds it there.
    const stored = await storage.getConversation(conversationId);
    expect(stored?.messages?.at(-1)?.content).toBe("Como o sandbox contém os caminhos?");
  });

  it("stamps every event with an id, which is what makes a reconnect possible", async () => {
    const client = await openLive({ clientId: "client-a" });
    await postTurn("primeiro");
    await client.waitFor("message.appended");

    const ids = client.frames.map((frame) => frame.id);
    expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
    const seqs = ids.map((id) => Number(id!.split(".")[1]));
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });

  it("counts the people watching, and says so on both screens", async () => {
    const first = await openLive({ clientId: "client-a" });
    await first.waitFor("presence.changed");

    const second = await openLive({ clientId: "client-b" });
    await second.waitFor("presence.changed");

    const seen = first.of("presence.changed").at(-1);
    expect(seen?.data).toMatchObject({ viewers: 2 });

    await second.close();
    expect(first.of("presence.changed").at(-1)?.data).toMatchObject({ viewers: 1 });
  });

  it("carries a tool result to the screen that did not make the call", async () => {
    const spectator = await openLive({ clientId: "client-b" });
    await spectator.waitFor("presence.changed");

    outcome = async () => ({
      output: "Desenhei o fluxo.",
      meta: { diagram: { id: "d1", kind: "flowchart", caption: "Fluxo" } },
    });

    await fetch(`${realtime}/tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversation_id: conversationId,
        call_id: "call_1",
        name: "draw_diagram",
        arguments: "{}",
      }),
    });

    const frame = await spectator.waitFor("tool.finished");
    expect(frame.data).toMatchObject({
      call_id: "call_1",
      name: "draw_diagram",
      output: "Desenhei o fluxo.",
    });
    // The diagram rides on the tool result rather than getting an event of its
    // own: one producer, one event, nothing to disagree about.
    expect(frame.data.meta).toMatchObject({ diagram: { id: "d1" } });
  });

  it("broadcasts a tool failure too, so the other screen stops waiting", async () => {
    const spectator = await openLive({ clientId: "client-b" });
    await spectator.waitFor("presence.changed");

    outcome = async () => {
      throw new Error("o repositório sumiu");
    };

    await fetch(`${realtime}/tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversation_id: conversationId,
        name: "search_source",
        arguments: "{}",
      }),
    });

    const frame = await spectator.waitFor("tool.finished");
    expect(frame.data.output).toContain("A ferramenta falhou");
    expect(frame.data.call_id).toBeNull();
  });
});

describe("reconnecting with Last-Event-ID", () => {
  it("delivers the gap and not one event twice", async () => {
    const client = await openLive({ clientId: "client-a" });
    await postTurn("turno um");
    await client.waitFor("message.appended");

    const cursor = client.lastEventId();
    expect(cursor).toBeTruthy();
    await client.close();

    // Said while nobody was listening. This is the whole point of the buffer.
    await postTurn("turno dois");

    const again = await openLive({ clientId: "client-a", lastEventId: cursor });
    await again.waitFor("message.appended");

    const appended = again.of("message.appended");
    expect(appended).toHaveLength(1);
    expect(appended[0]!.data.messages).toMatchObject([{ content: "turno dois" }]);
    expect(again.of("history.reset")).toHaveLength(0);
  });

  it("replays nothing for a first connection", async () => {
    await postTurn("dito antes de qualquer um abrir a conversa");

    const client = await openLive({ clientId: "client-a" });
    await client.waitFor("presence.changed");
    await sleep(50);

    // A client that has just fetched the conversation over REST already holds
    // this turn; replaying the buffer on top would duplicate every message in it.
    expect(client.of("message.appended")).toHaveLength(0);
  });

  it("asks for a refetch when the gap fell out of the buffer", async () => {
    // Deterministic rather than relying on where the process-wide counter
    // happens to be: burn a few sequence numbers elsewhere, then this
    // conversation's buffer starts well above the cursor claimed below.
    const elsewhere = randomUUID();
    for (let i = 0; i < 5; i += 1) {
      bus.publish(elsewhere, { type: "presence.changed", viewers: 0, floor: null });
    }
    bus.forgetConversation(elsewhere);
    const first = bus.publish(conversationId, {
      type: "presence.changed",
      viewers: 0,
      floor: null,
    });

    const client = await openLive({ clientId: "client-a", since: first.seq - 3 });
    const reset = await client.waitFor("history.reset");

    // Carries no id: this frame is addressed to one client and must not move
    // anybody's cursor.
    expect(reset.id).toBeNull();
    expect(client.of("presence.changed").every((f) => f.id !== null)).toBe(true);
  });

  it("asks for a refetch when the cursor came from a previous process", async () => {
    const client = await openLive({
      clientId: "client-a",
      lastEventId: "deadbeef.7",
    });

    // A restart hands out sequence numbers that were already used. Without the
    // epoch this cursor would be stitched onto an unrelated history.
    await client.waitFor("history.reset");
  });
});

describe("the floor, over HTTP", () => {
  it("gives the microphone to the first claimant and refuses the second by name", async () => {
    const first = await fetch(`${conversations}/${conversationId}/floor`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: "client-a", name: "Rodrigo" }),
    });
    expect(first.status).toBe(200);

    const second = await fetch(`${conversations}/${conversationId}/floor`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: "client-b", name: "Ana" }),
    });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: string; floor: { name: string } };
    expect(body.error).toContain("Rodrigo");
    expect(body.floor.name).toBe("Rodrigo");
  });

  it("tells both screens when the microphone changes hands", async () => {
    const spectator = await openLive({ clientId: "client-b" });
    await spectator.waitFor("presence.changed");

    await fetch(`${conversations}/${conversationId}/floor`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: "client-a", name: "Rodrigo" }),
    });

    const frame = await spectator.waitFor("floor.changed");
    expect(frame.data).toMatchObject({ holder: "client-a", name: "Rodrigo" });
  });

  it("delivers a request to speak without taking anything", async () => {
    await fetch(`${conversations}/${conversationId}/floor`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: "client-a", name: "Rodrigo" }),
    });

    const holder = await openLive({ clientId: "client-a" });
    await holder.waitFor("presence.changed");

    const asked = await fetch(`${conversations}/${conversationId}/floor/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: "client-b", name: "Ana" }),
    });
    expect(asked.status).toBe(202);

    const frame = await holder.waitFor("floor.requested");
    expect(frame.data).toMatchObject({ client_id: "client-b", name: "Ana" });
    // Asking is not taking: Rodrigo is still holding it.
    const state = await fetch(`${conversations}/${conversationId}/floor`);
    expect(await state.json()).toMatchObject({
      floor: { client_id: "client-a" },
      request: { client_id: "client-b" },
    });
  });

  it("refuses a request when there is nobody to ask", async () => {
    const res = await fetch(`${conversations}/${conversationId}/floor/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: "client-b", name: "Ana" }),
    });
    expect(res.status).toBe(409);
  });

  it("lets the holder hand it back", async () => {
    await fetch(`${conversations}/${conversationId}/floor`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: "client-a", name: "Rodrigo" }),
    });

    const res = await fetch(
      `${conversations}/${conversationId}/floor?client_id=client-a`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ released: true, floor: null });
  });

  it("demands a client id", async () => {
    const res = await fetch(`${conversations}/${conversationId}/floor`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Anônimo" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/realtime/session — the gate that makes the floor real", () => {
  it("refuses to mint a second session while somebody holds the microphone", async () => {
    const first = await mint({ client_id: "client-a", client_name: "Rodrigo" });
    expect(first.status).toBe(200);
    const opened = (await first.json()) as { floor: { client_id: string } | null };
    expect(opened.floor).toMatchObject({ client_id: "client-a" });

    const second = await mint({ client_id: "client-b", client_name: "Ana" });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: string; floor: { name: string } };
    expect(body.error).toContain("Rodrigo");
    expect(body.floor).toMatchObject({ client_id: "client-a" });

    // The refusal is what keeps the Realtime API from being asked for a second
    // response on a conversation that already has one, so nothing may have been
    // minted on B's behalf.
    expect(modelCalls.filter((call) => call === "mintRealtimeClientSecret")).toHaveLength(1);
  });

  it("refuses an unidentified caller too, once the floor is taken", async () => {
    await mint({ client_id: "client-a", client_name: "Rodrigo" });

    const anonymous = await mint();
    expect(anonymous.status).toBe(409);
  });

  it("lets the holder mint again, which is what a reconnect is", async () => {
    await mint({ client_id: "client-a", client_name: "Rodrigo" });
    const again = await mint({ client_id: "client-a", client_name: "Rodrigo" });

    expect(again.status).toBe(200);
    expect(minted).not.toBeNull();
  });

  it("leaves the floor alone for a caller that does not identify itself", async () => {
    const res = await mint();
    expect(res.status).toBe(200);
    // Every caller that predates the floor looks like this. Claiming on their
    // behalf would lock a conversation to whichever tab connected first.
    expect(floor.getFloor(conversationId)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The invariant
// ---------------------------------------------------------------------------

describe("the live stream never feeds the model", () => {
  it("holds no channel to it, in source", async () => {
    const files = ["../routes/live.ts", "../services/conversation-bus.ts", "../services/floor.ts"];
    for (const file of files) {
      const source = await readFile(new URL(file, import.meta.url), "utf8");
      // Comments discuss the model on purpose; what must not exist is code that
      // reaches it.
      const code = source
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
        .join("\n");

      // `/api/agents/events` needs a `replay: true` flag because its client
      // *does* inject what arrives into the live session. This stream needs no
      // such flag, and the reason is structural rather than careful: there is
      // nothing here to inject with.
      expect(code, `${file} must not reach the model`).not.toMatch(
        /services\/(openai|tool-executor|memory-recorder)\.js/,
      );
      expect(code, `${file} must not ask for a response`).not.toContain("response.create");
    }
  });

  it("calls nothing that talks to it, across a whole session", async () => {
    const holder = await openLive({ clientId: "client-a" });
    const spectator = await openLive({ clientId: "client-b" });
    await spectator.waitFor("presence.changed");

    await postTurn("uma pergunta");
    await spectator.waitFor("message.appended");

    const cursor = spectator.lastEventId();
    await spectator.close();
    await postTurn("uma resposta", "assistant");

    const back = await openLive({ clientId: "client-b", lastEventId: cursor });
    await back.waitFor("message.appended");
    await holder.close();

    // Connect, receive, reconnect, replay, disconnect — and not one call to the
    // Realtime API, the summariser or the tool executor. A spectator cannot make
    // the assistant speak, and a reconnect cannot make it narrate an old turn.
    expect(modelCalls).toEqual([]);
  });
});
