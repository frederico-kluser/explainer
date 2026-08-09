import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as api from "@/lib/api";
import {
  CLIENT_ID_KEY,
  NO_PRESENCE,
  applyPresenceEvent,
  browserClientId,
  entriesFromMessages,
  entryFromToolFinished,
  liveStreamHandler,
  mergeRemoteEntries,
  parseFloorSnapshot,
  parseLiveEvent,
  summarizeToolOutput,
  type LiveStreamDeps,
} from "@/lib/conversation-stream";
import {
  fetchArchivedTranscript,
  floorFromRefusal,
  persistTurn,
} from "@/hooks/useRealtimeSession";
import type { Conversation, LiveMessage, TranscriptEntry } from "@/types";

const CONV = "3f1e2d4c-5b6a-4789-9abc-0123456789ab";

afterEach(() => {
  vi.unstubAllGlobals();
});

function frame(event: object): string {
  return JSON.stringify(event);
}

/**
 * A `LiveStreamDeps` that also carries the two calls the live stream is never
 * allowed to make, so a test can watch them stay untouched.
 *
 * They are attached through a cast because the interface has no room for them —
 * which is the structural half of the guarantee. This is the behavioural half.
 */
function liveDeps(): {
  deps: LiveStreamDeps;
  messages: LiveMessage[][];
  tools: unknown[];
  memory: number[];
  presence: unknown[];
  resets: number[];
  send: ReturnType<typeof vi.fn>;
  requestResponse: ReturnType<typeof vi.fn>;
} {
  const messages: LiveMessage[][] = [];
  const tools: unknown[] = [];
  const memory: number[] = [];
  const presence: unknown[] = [];
  const resets: number[] = [];
  const send = vi.fn();
  const requestResponse = vi.fn();

  const deps = {
    onMessages: (batch: LiveMessage[]) => messages.push(batch),
    onToolFinished: (event: unknown) => tools.push(event),
    onMemoryChanged: (count: number) => memory.push(count),
    onPresence: (event: unknown) => presence.push(event),
    onReset: (since: number) => resets.push(since),
    send,
    requestResponse,
  } as unknown as LiveStreamDeps;

  return { deps, messages, tools, memory, presence, resets, send, requestResponse };
}

// ---------------------------------------------------------------------------
// PROOF 1 — the echo of one's own turn does not land twice
// ---------------------------------------------------------------------------
//
// The bug this whole id business exists for: `POST /:id/messages` mints a
// `uuidv4()` for a message that arrives without one, then broadcasts it. The
// screen that just spoke gets its own sentence back under an id it has never
// seen, and draws it a second time directly underneath itself.

describe("a turn this screen just said, echoed back off /live", () => {
  const ITEM_ID = "item_ABC123";
  const SPOKEN = "O repositorio usa Express 5.";

  /** What the transcript already holds, drawn from the data channel. */
  function localTranscript(): TranscriptEntry[] {
    return [
      {
        id: ITEM_ID,
        role: "assistant",
        text: SPOKEN,
        final: true,
        timestamp: "2026-08-08T12:00:00.000Z",
      },
    ];
  }

  it("is archived under the id the transcript already draws it with", () => {
    const append = vi.fn(() => Promise.resolve());
    persistTurn(CONV, ITEM_ID, "assistant", SPOKEN, append);

    expect(append).toHaveBeenCalledWith(CONV, [
      { id: ITEM_ID, role: "assistant", content: SPOKEN },
    ]);
  });

  it("merges into the line already on screen instead of appearing beneath it", () => {
    const harness = liveDeps();
    const handle = liveStreamHandler(harness.deps);

    handle(
      frame({
        type: "message.appended",
        messages: [
          {
            id: ITEM_ID,
            role: "assistant",
            content: SPOKEN,
            timestamp: "2026-08-08T12:00:00.000Z",
          },
        ],
      }),
    );

    const echoed = entriesFromMessages(harness.messages[0]!, "2026-08-08T12:00:01.000Z");
    const after = mergeRemoteEntries(localTranscript(), echoed);

    expect(after).toHaveLength(1);
    expect(after[0]?.text).toBe(SPOKEN);
    // Identity, not just length: nothing was rebuilt, so React redraws nothing.
    expect(after).toEqual(localTranscript());
  });

  it("would land twice under the uuid the server mints for an id-less turn", () => {
    // The old behaviour, kept as a test so the regression is visible rather than
    // remembered: same sentence, same conversation, an id nobody on this screen
    // has ever seen.
    const echoed = entriesFromMessages(
      [
        {
          id: "9c1f8f7e-0000-4000-8000-000000000000",
          role: "assistant",
          content: SPOKEN,
          timestamp: "2026-08-08T12:00:00.000Z",
        },
      ],
      "2026-08-08T12:00:01.000Z",
    );

    expect(mergeRemoteEntries(localTranscript(), echoed)).toHaveLength(2);
  });

  it("is a new line on the screen that did not say it", () => {
    const echoed = entriesFromMessages(
      [
        {
          id: ITEM_ID,
          role: "assistant",
          content: SPOKEN,
          timestamp: "2026-08-08T12:00:00.000Z",
        },
      ],
      "2026-08-08T12:00:01.000Z",
    );

    const spectator = mergeRemoteEntries([], echoed);
    expect(spectator).toHaveLength(1);
    expect(spectator[0]).toMatchObject({ id: ITEM_ID, role: "assistant", final: true });
  });

  it("folds a tool result onto the card the calling screen already drew", () => {
    const local: TranscriptEntry[] = [
      {
        id: "tool-call_7",
        role: "tool",
        text: "search_source — executando…",
        final: false,
        timestamp: "2026-08-08T12:00:00.000Z",
      },
    ];

    const entry = entryFromToolFinished(
      {
        type: "tool.finished",
        call_id: "call_7",
        name: "search_source",
        output: "12 ocorrencias",
        meta: null,
      },
      "2026-08-08T12:00:02.000Z",
    );

    expect(entry?.id).toBe("tool-call_7");
    expect(mergeRemoteEntries(local, [entry!])).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// PROOF 2 — the live stream never feeds the model
// ---------------------------------------------------------------------------

describe("the live stream never feeds the model", () => {
  const SOURCES = [
    "../lib/conversation-stream.ts",
    "../hooks/useConversationStream.ts",
  ] as const;

  /** The source with every comment removed — comments name what code must not do. */
  function code(relative: string): string {
    const path = fileURLToPath(new URL(relative, import.meta.url));
    return readFileSync(path, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
  }

  it("is reading the files it claims to be reading", () => {
    // A `not.toContain` against an empty string passes. This is what stops the
    // two cases below from becoming decoration the day a path changes.
    expect(code(SOURCES[0])).toContain("export function liveStreamHandler");
    expect(code(SOURCES[1])).toContain("export function useConversationStream");
  });

  it("imports nothing that can build an event for it, in source", () => {
    for (const relative of SOURCES) {
      // `lib/realtime.ts` holds every client event the model understands —
      // `RESPONSE_CREATE`, `userTextEvent`, `functionOutputEvent`. A file that
      // cannot reach it cannot make the assistant speak.
      expect(code(relative)).not.toContain("@/lib/realtime");
    }
  });

  it("names none of the calls that reach it, in source", () => {
    for (const relative of SOURCES) {
      const source = code(relative);
      for (const forbidden of [
        "requestResponse",
        "userTextEvent",
        "RESPONSE_CREATE",
        "response.create",
        "dcRef",
        "dataChannel",
      ]) {
        expect(source).not.toContain(forbidden);
      }
      // `send` on its own is too common a word to grep for; the call is not.
      expect(source).not.toMatch(/\bsend\s*\(/);
    }
  });

  it("calls neither of them for any event the stream can deliver", () => {
    const harness = liveDeps();
    const handle = liveStreamHandler(harness.deps);

    const everything = [
      {
        type: "message.appended",
        messages: [
          { id: "m1", role: "user", content: "e o cache?", timestamp: "2026-08-08T12:00:00.000Z" },
        ],
      },
      {
        type: "tool.finished",
        call_id: "call_1",
        name: "generate_diagram",
        output: "desenhei o fluxo",
        meta: { diagram: { id: "d1", kind: "flowchart", source: "flowchart TD", caption: "" } },
      },
      { type: "memory.changed", event_count: 12 },
      {
        type: "presence.changed",
        viewers: 2,
        floor: { client_id: "c1", name: "Rodrigo", since: "2026-08-08T12:00:00.000Z" },
      },
      { type: "floor.changed", holder: "c2", name: "Ana" },
      { type: "floor.requested", client_id: "c3", name: "Bruno" },
      { type: "history.reset", since: 41 },
      // The frames a deploy skew or a proxy can produce, too.
      { type: "deep_think_done", job_id: "j1", synthesis: "fale isto em voz alta" },
      { type: "error", error: "Internal server error" },
    ];

    for (const event of everything) handle(frame(event));
    handle("not json at all");

    expect(harness.send).not.toHaveBeenCalled();
    expect(harness.requestResponse).not.toHaveBeenCalled();

    // And the screen still got everything it was supposed to.
    expect(harness.messages).toHaveLength(1);
    expect(harness.tools).toHaveLength(1);
    expect(harness.memory).toEqual([12]);
    expect(harness.presence).toHaveLength(3);
    expect(harness.resets).toEqual([41]);
  });

  it("drops a deep_think_done rather than treating it as a turn", () => {
    // The other stream — `/api/agents/events` — really does inject one of these
    // and ask the model to narrate it. Confusing the two is the failure mode
    // this case exists to catch.
    expect(
      parseLiveEvent(frame({ type: "deep_think_done", job_id: "j1", synthesis: "…" })),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PROOF 3 — history.reset makes the client read the conversation again
// ---------------------------------------------------------------------------

describe("history.reset", () => {
  it("arrives with no id line and reaches onReset alone", () => {
    const harness = liveDeps();
    liveStreamHandler(harness.deps)(frame({ type: "history.reset", since: 118 }));

    expect(harness.resets).toEqual([118]);
    expect(harness.messages).toEqual([]);
    expect(harness.tools).toEqual([]);
    expect(harness.presence).toEqual([]);
  });

  it("makes the refetch read the conversation the reset was about", async () => {
    const stored: Conversation = {
      id: CONV,
      title: "Explainer",
      created_at: "2026-08-08T11:00:00.000Z",
      updated_at: "2026-08-08T12:00:00.000Z",
      messages: [
        { id: "m1", role: "user", content: "o que mudou?", timestamp: "2026-08-08T11:59:00.000Z" },
        { id: "m2", role: "assistant", content: "o gate do microfone", timestamp: "2026-08-08T11:59:30.000Z" },
      ],
    };

    const get = vi.fn(() => Promise.resolve(stored));
    const archived = await fetchArchivedTranscript(CONV, "2026-08-08T12:00:00.000Z", get);

    expect(get).toHaveBeenCalledWith(CONV);
    expect(archived.map((entry) => entry.id)).toEqual(["m1", "m2"]);
  });

  it("puts the recovered turns back in order, keeping what is already on screen", async () => {
    const onScreen: TranscriptEntry[] = [
      {
        id: "m2",
        role: "assistant",
        text: "o gate do microfone",
        final: true,
        timestamp: "2026-08-08T11:59:30.000Z",
      },
      {
        id: "m3",
        role: "user",
        text: "e agora?",
        final: true,
        timestamp: "2026-08-08T12:05:00.000Z",
      },
    ];

    const get = vi.fn(() =>
      Promise.resolve({
        id: CONV,
        title: "Explainer",
        created_at: "2026-08-08T11:00:00.000Z",
        updated_at: "2026-08-08T12:00:00.000Z",
        messages: [
          // The turn this screen missed while it was in a tunnel — older than
          // both lines above, so appending it blindly would put it last.
          { id: "m1", role: "user", content: "o que mudou?", timestamp: "2026-08-08T11:59:00.000Z" },
          { id: "m2", role: "assistant", content: "o gate do microfone", timestamp: "2026-08-08T11:59:30.000Z" },
        ],
      } satisfies Conversation),
    );

    const archived = await fetchArchivedTranscript(CONV, "2026-08-08T12:10:00.000Z", get);
    const merged = mergeRemoteEntries(onScreen, archived);

    expect(merged.map((entry) => entry.id)).toEqual(["m1", "m2", "m3"]);
  });

  it("answers with nothing when the conversation has no stored turns", async () => {
    const get = vi.fn(() =>
      Promise.resolve({
        id: CONV,
        title: "Nova",
        created_at: "2026-08-08T11:00:00.000Z",
        updated_at: "2026-08-08T11:00:00.000Z",
      } satisfies Conversation),
    );

    await expect(fetchArchivedTranscript(CONV, "2026-08-08T12:00:00.000Z", get)).resolves.toEqual(
      [],
    );
  });
});

// ---------------------------------------------------------------------------
// Reading the wire
// ---------------------------------------------------------------------------

describe("parseLiveEvent", () => {
  it("reads each frame the server can send", () => {
    expect(
      parseLiveEvent(
        frame({
          type: "message.appended",
          messages: [{ id: "m1", role: "user", content: "oi", timestamp: "t" }],
        }),
      ),
    ).toEqual({
      type: "message.appended",
      messages: [{ id: "m1", role: "user", content: "oi", timestamp: "t" }],
    });

    expect(
      parseLiveEvent(
        frame({ type: "tool.finished", call_id: null, name: "web_search", output: "3 hits" }),
      ),
    ).toEqual({
      type: "tool.finished",
      call_id: null,
      name: "web_search",
      output: "3 hits",
      meta: null,
    });

    expect(parseLiveEvent(frame({ type: "memory.changed", event_count: 7 }))).toEqual({
      type: "memory.changed",
      event_count: 7,
    });

    expect(parseLiveEvent(frame({ type: "floor.changed", holder: null, name: null }))).toEqual({
      type: "floor.changed",
      holder: null,
      name: null,
    });

    expect(parseLiveEvent(frame({ type: "history.reset", since: 3 }))).toEqual({
      type: "history.reset",
      since: 3,
    });
  });

  it("answers null for anything it cannot use", () => {
    expect(parseLiveEvent("{oops")).toBeNull();
    expect(parseLiveEvent("[]")).toBeNull();
    expect(parseLiveEvent(frame({ type: "something.new" }))).toBeNull();
    // A tool frame with no name would draw a card labelled "undefined".
    expect(parseLiveEvent(frame({ type: "tool.finished", output: "x" }))).toBeNull();
    // A batch whose every message is malformed is not a batch.
    expect(parseLiveEvent(frame({ type: "message.appended", messages: [null, 7] }))).toBeNull();
  });

  it("rebuilds a message batch field by field, dropping what it cannot key", () => {
    const event = parseLiveEvent(
      frame({
        type: "message.appended",
        messages: [
          { role: "user", content: "sem id" },
          { id: "m2", role: "assistant", content: null },
        ],
      }),
    );

    expect(event).toEqual({
      type: "message.appended",
      messages: [{ id: "m2", role: "assistant", content: null, timestamp: "" }],
    });
  });

  it("keeps a viewer count sane rather than trusting it", () => {
    expect(parseLiveEvent(frame({ type: "presence.changed", viewers: -4, floor: null }))).toEqual({
      type: "presence.changed",
      viewers: 0,
      floor: null,
    });
    expect(
      parseLiveEvent(frame({ type: "presence.changed", viewers: "muitos", floor: {} })),
    ).toEqual({ type: "presence.changed", viewers: 0, floor: null });
  });
});

describe("parseFloorSnapshot", () => {
  it("needs a client id and nothing else", () => {
    expect(parseFloorSnapshot({ client_id: "c1" })).toEqual({
      client_id: "c1",
      name: "Alguém",
      since: "",
    });
    expect(parseFloorSnapshot({ name: "Ana" })).toBeNull();
    expect(parseFloorSnapshot(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Presence and the floor
// ---------------------------------------------------------------------------

describe("applyPresenceEvent", () => {
  const AT = "2026-08-08T12:00:00.000Z";
  const HOLDER = { client_id: "c1", name: "Rodrigo", since: "2026-08-08T11:00:00.000Z" };

  it("takes viewers and holder from presence.changed", () => {
    expect(
      applyPresenceEvent(NO_PRESENCE, { type: "presence.changed", viewers: 3, floor: HOLDER }, AT),
    ).toEqual({ viewers: 3, floor: HOLDER, request: null });
  });

  it("keeps the clock running when the same holder re-claims", () => {
    // A reconnect re-claims the floor it already had. Restamping `since` would
    // make the UI say the microphone was just taken, every three seconds.
    const next = applyPresenceEvent(
      { viewers: 2, floor: HOLDER, request: null },
      { type: "floor.changed", holder: "c1", name: "Rodrigo" },
      AT,
    );
    expect(next.floor?.since).toBe(HOLDER.since);
  });

  it("stamps a new holder with the moment it heard about them", () => {
    const next = applyPresenceEvent(
      { viewers: 2, floor: HOLDER, request: null },
      { type: "floor.changed", holder: "c2", name: "Ana" },
      AT,
    );
    expect(next.floor).toEqual({ client_id: "c2", name: "Ana", since: AT });
  });

  it("clears a pending request when the microphone is let go", () => {
    const asked = applyPresenceEvent(
      { viewers: 2, floor: HOLDER, request: null },
      { type: "floor.requested", client_id: "c2", name: "Ana" },
      AT,
    );
    expect(asked.request).toEqual({ client_id: "c2", name: "Ana" });

    const released = applyPresenceEvent(
      asked,
      { type: "floor.changed", holder: null, name: null },
      AT,
    );
    expect(released.floor).toBeNull();
    expect(released.request).toBeNull();
  });
});

describe("floorFromRefusal", () => {
  it("names the holder behind the mint's floor 409", () => {
    const err = new api.ApiError(409, "Ana está com o microfone nesta conversa.", {
      error: "Ana está com o microfone nesta conversa.",
      floor: { client_id: "c2", name: "Ana", since: "2026-08-08T12:00:00.000Z" },
    });
    expect(floorFromRefusal(err)?.name).toBe("Ana");
  });

  it("leaves the other 409 alone, because that one really is an error", () => {
    // "Nenhum material adicionado" shares the status code and carries no floor.
    const err = new api.ApiError(409, "Nenhum material adicionado.", {
      error: "Nenhum material adicionado.",
    });
    expect(floorFromRefusal(err)).toBeNull();
    expect(floorFromRefusal(new api.ApiError(500, "boom", null))).toBeNull();
    expect(floorFromRefusal(new Error("offline"))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Transcript lines
// ---------------------------------------------------------------------------

describe("entryFromMessage", () => {
  it("drops a role it cannot draw rather than guessing one", () => {
    const entries = entriesFromMessages(
      [
        { id: "m1", role: "system", content: "instrucoes", timestamp: "t" },
        { id: "m2", role: "assistant", content: "ok", timestamp: "t" },
      ],
      "t",
    );
    expect(entries.map((entry) => entry.id)).toEqual(["m2"]);
  });

  it("drops a turn with nothing in it", () => {
    expect(
      entriesFromMessages(
        [
          { id: "m1", role: "user", content: null, timestamp: "t" },
          { id: "m2", role: "user", content: "   ", timestamp: "t" },
        ],
        "t",
      ),
    ).toEqual([]);
  });

  it("falls back to now when the server sent no stamp", () => {
    const [entry] = entriesFromMessages(
      [{ id: "m1", role: "user", content: "oi", timestamp: "" }],
      "2026-08-08T12:00:00.000Z",
    );
    expect(entry?.timestamp).toBe("2026-08-08T12:00:00.000Z");
  });
});

describe("entryFromToolFinished", () => {
  it("has nothing to key on without a call id", () => {
    expect(
      entryFromToolFinished(
        { type: "tool.finished", call_id: null, name: "web_search", output: "x", meta: null },
        "t",
      ),
    ).toBeNull();
  });

  it("shows the first useful line, clipped", () => {
    expect(summarizeToolOutput("\n\n" + "a".repeat(200))).toHaveLength(121);
    expect(summarizeToolOutput("primeira\nsegunda")).toBe("primeira");
  });
});

describe("mergeRemoteEntries", () => {
  function entry(id: string, timestamp: string): TranscriptEntry {
    return { id, role: "user", text: id, final: true, timestamp };
  }

  it("returns the very same array when there is nothing to add", () => {
    const live = [entry("a", "2026-08-08T12:00:00.000Z")];
    expect(mergeRemoteEntries(live, [entry("a", "2026-08-08T13:00:00.000Z")])).toBe(live);
  });

  it("keeps a line whose stamp cannot be read next to its neighbours", () => {
    const merged = mergeRemoteEntries(
      [entry("a", "2026-08-08T12:00:00.000Z"), entry("b", "nao e uma data")],
      [entry("c", "2026-08-08T11:00:00.000Z")],
    );
    expect(merged.map((item) => item.id)).toEqual(["c", "a", "b"]);
  });
});

// ---------------------------------------------------------------------------
// Who this browser is
// ---------------------------------------------------------------------------

describe("browserClientId", () => {
  function fakeStorage(seed: Record<string, string> = {}) {
    const store = new Map(Object.entries(seed));
    return {
      store,
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };
  }

  it("mints one and keeps it, so a reload comes back as the same holder", () => {
    const storage = fakeStorage();
    vi.stubGlobal("localStorage", storage);

    const first = browserClientId();
    expect(first).toBeTruthy();
    expect(storage.store.get(CLIENT_ID_KEY)).toBe(first);
    expect(browserClientId()).toBe(first);
  });

  it("uses the one already stored rather than minting a second", () => {
    vi.stubGlobal("localStorage", fakeStorage({ [CLIENT_ID_KEY]: "kept" }));
    expect(browserClientId()).toBe("kept");
  });

  it("still answers when the store refuses to be read", () => {
    // Safari in private mode throws on access instead of answering null.
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("SecurityError");
      },
    });
    expect(browserClientId()).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// The HTTP half
// ---------------------------------------------------------------------------

describe("conversationStreamUrl", () => {
  it("carries the client id and nothing secret", () => {
    const url = api.conversationStreamUrl(CONV, "c/1");
    expect(url).toBe(`/api/conversations/${CONV}/live?client_id=c%2F1`);
    // The access key is a cookie. EventSource sends it by itself, and a key in
    // the query string of a stream that stays open for a whole call is a key in
    // every proxy log.
    expect(url).not.toContain("key");
  });
});

describe("the floor routes", () => {
  function stubFetch(body: unknown, status = 200) {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(JSON.stringify(body)),
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("claims with the client id in the body", async () => {
    const fetchMock = stubFetch({ floor: { client_id: "c1", name: "Ana", since: "t" }, already_mine: false });
    await api.claimFloor(CONV, "c1", "Ana");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/conversations/${CONV}/floor`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ client_id: "c1", name: "Ana" });
  });

  it("releases with the client id in the query, where a DELETE keeps it", async () => {
    const fetchMock = stubFetch({ released: true, floor: null });
    await api.releaseFloor(CONV, "c1");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/conversations/${CONV}/floor?client_id=c1`);
    expect(init.method).toBe("DELETE");
  });

  it("treats the 202 from a request to speak as an answer", async () => {
    stubFetch({ requested: { client_id: "c2", name: "Ana" }, floor: null }, 202);
    await expect(api.requestFloor(CONV, "c2", "Ana")).resolves.toMatchObject({
      requested: { client_id: "c2", name: "Ana" },
    });
  });

  it("keeps the whole refusal body, not only its sentence", async () => {
    const floor = { client_id: "c1", name: "Rodrigo", since: "t" };
    stubFetch({ error: "Rodrigo está com o microfone nesta conversa.", floor }, 409);

    await expect(api.claimFloor(CONV, "c2", "Ana")).rejects.toMatchObject({
      status: 409,
      body: { floor },
    });
  });
});
