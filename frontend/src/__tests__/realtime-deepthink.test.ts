import { describe, it, expect, afterEach, vi } from "vitest";

import {
  MAX_DEEP_THINK_JOBS,
  MAX_DIAGRAMS,
  appendDiagram,
  applyAgentJobEvent,
  applyDeepThinkEvent,
  diagramFromMeta,
  executeToolCalls,
  isDeepThinkEvent,
  isReplay,
  mergeConversationItems,
  openRealtimeSession,
  seedDiagrams,
  sessionStreamHandler,
  type SessionStreamDeps,
} from "@/hooks/useRealtimeSession";
import type {
  AgentJob,
  DeepThinkJob,
  MermaidDiagram,
  RealtimeSessionToken,
  ThinkerResult,
  TranscriptEntry,
} from "@/types";

// The suite has no jsdom, so a React hook cannot be rendered here. Everything
// the hook decides therefore lives in the exported functions below, and the hook
// is the wiring that hands them `setJobs`/`setDeepThinkJobs`/`send`. These tests
// drive those functions with the same folds React would apply, so what passes
// here is what runs in the browser.

const CONV = "550e8400-e29b-41d4-a716-446655440000";
const AT = "2026-08-08T12:00:00.000Z";

afterEach(() => {
  vi.unstubAllGlobals();
});

interface Recorded {
  deps: SessionStreamDeps;
  jobs: () => AgentJob[];
  deepThinkJobs: () => DeepThinkJob[];
  sent: object[];
  entries: Array<{ id: string; role: TranscriptEntry["role"]; text: string; final?: boolean }>;
  persisted: Array<{ role: string; content: string }>;
  responses: () => number;
}

/** A stand-in for the hook: plain variables where React would hold state. */
function record(): Recorded {
  let jobs: AgentJob[] = [];
  let deepThinkJobs: DeepThinkJob[] = [];
  let responses = 0;
  const sent: object[] = [];
  const entries: Recorded["entries"] = [];
  const persisted: Recorded["persisted"] = [];

  const deps: SessionStreamDeps = {
    conversationId: CONV,
    setJobs: (update) => {
      jobs = update(jobs);
    },
    setDeepThinkJobs: (update) => {
      deepThinkJobs = update(deepThinkJobs);
    },
    upsertEntry: (id, role, mutate, final) => {
      entries.push({ id, role, text: mutate(""), final });
    },
    persist: (role, content) => {
      persisted.push({ role, content });
    },
    send: (event) => {
      sent.push(event);
    },
    requestResponse: () => {
      responses += 1;
    },
  };

  return {
    deps,
    jobs: () => jobs,
    deepThinkJobs: () => deepThinkJobs,
    sent,
    entries,
    persisted,
    responses: () => responses,
  };
}

const THINKERS: ThinkerResult[] = [
  { id: "t1", angle: "riscos", status: "done", thinking: "Pode dar errado assim." },
  { id: "t2", angle: "custo", status: "running" },
];

const SYNTHESIS =
  "Os pensadores convergiram: o caminho mais barato tambem e o mais arriscado.";

// ---------------------------------------------------------------------------
// The bug this file exists for
// ---------------------------------------------------------------------------

describe("a deep_think event never becomes a failed agent job", () => {
  it("routes by discriminant instead of falling into the error branch", () => {
    expect(isDeepThinkEvent({ type: "deep_think_done", job_id: "j", synthesis: "", thinkers: [] })).toBe(true);
    expect(isDeepThinkEvent({ type: "deep_think_activity", job_id: "j", activity: "", thinkers: [] })).toBe(true);
    expect(isDeepThinkEvent({ type: "deep_think_error", job_id: "j", error: "x" })).toBe(true);
    expect(isDeepThinkEvent({ type: "done", job_id: "j", result: "r" })).toBe(false);
    expect(isDeepThinkEvent({ type: "activity", job_id: "j", activity: "a" })).toBe(false);
  });

  it("creates no phantom pi job card when a round finishes", () => {
    const harness = record();
    const handle = sessionStreamHandler(harness.deps);

    handle(
      JSON.stringify({
        type: "deep_think_done",
        job_id: "round_1",
        synthesis: SYNTHESIS,
        thinkers: THINKERS,
        cost_usd: 0.12,
      }),
    );

    // The old ternary produced exactly this: status "error", activity "falhou",
    // error undefined — a card for a job that never failed and never existed.
    expect(harness.jobs()).toEqual([]);

    const round = harness.deepThinkJobs()[0];
    expect(round?.status).toBe("done");
    expect(round?.error).toBeUndefined();
    expect(round?.synthesis).toBe(SYNTHESIS);
    expect(round?.cost_usd).toBe(0.12);
    expect(round?.thinkers).toHaveLength(2);
  });

  it("ignores an event type it does not know rather than inventing a job", () => {
    const harness = record();
    const handle = sessionStreamHandler(harness.deps);

    handle(JSON.stringify({ type: "quantum_think_done", job_id: "x" }));
    handle("not json at all");

    expect(harness.jobs()).toEqual([]);
    expect(harness.deepThinkJobs()).toEqual([]);
    expect(harness.sent).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A frame with no job in it
// ---------------------------------------------------------------------------

describe("an event that names no job", () => {
  it("is dropped instead of opening a card and making the model speak", () => {
    const harness = record();

    // Verbatim what backend/src/middleware/error-handler.ts writes *into this
    // stream* when something throws after res.flushHeaders(). It has the shape
    // of a pi job failure and none of the substance: folded in, it produced a
    // card with `id: undefined` and had the assistant read an English internal
    // error out loud, in a Portuguese conversation.
    sessionStreamHandler(harness.deps)(
      JSON.stringify({ type: "error", error: "Internal server error" }),
    );

    expect(harness.jobs()).toEqual([]);
    expect(harness.entries).toEqual([]);
    expect(harness.sent).toEqual([]);
    expect(harness.responses()).toBe(0);
    expect(harness.persisted).toEqual([]);
  });

  it("drops the deliberation half by the same rule", () => {
    const harness = record();
    sessionStreamHandler(harness.deps)(
      JSON.stringify({ type: "deep_think_done", synthesis: SYNTHESIS, thinkers: [] }),
    );

    expect(harness.deepThinkJobs()).toEqual([]);
    expect(harness.sent).toEqual([]);
    expect(harness.responses()).toBe(0);
  });

  it("refuses an empty job_id too — it would key every card to the same card", () => {
    const harness = record();
    sessionStreamHandler(harness.deps)(
      JSON.stringify({ type: "done", job_id: "", result: "achei o bug" }),
    );

    expect(harness.jobs()).toEqual([]);
    expect(harness.sent).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The replay rule
// ---------------------------------------------------------------------------

describe("the replay rule", () => {
  it("injects the synthesis and asks for a response when the round just finished", () => {
    const harness = record();
    const handle = sessionStreamHandler(harness.deps);

    handle(
      JSON.stringify({
        type: "deep_think_done",
        job_id: "round_1",
        synthesis: SYNTHESIS,
        thinkers: THINKERS,
      }),
    );

    expect(harness.sent).toHaveLength(1);
    expect(JSON.stringify(harness.sent[0])).toContain(SYNTHESIS);
    expect(harness.responses()).toBe(1);
    expect(harness.persisted[0]?.content).toContain(SYNTHESIS);
  });

  it("renders but stays silent when the same event carries replay: true", () => {
    const harness = record();
    const handle = sessionStreamHandler(harness.deps);

    handle(
      JSON.stringify({
        type: "deep_think_done",
        job_id: "round_1",
        synthesis: SYNTHESIS,
        thinkers: THINKERS,
        replay: true,
      }),
    );

    // Rendered: the card and the transcript line are both there.
    expect(harness.deepThinkJobs()[0]?.synthesis).toBe(SYNTHESIS);
    expect(harness.entries.map((entry) => entry.text)).toContain(SYNTHESIS);

    // Not spoken: no conversation item, no response.create, nothing persisted.
    // A reconnect must not make the model narrate — and bill for — a synthesis
    // from an hour ago.
    expect(harness.sent).toEqual([]);
    expect(harness.responses()).toBe(0);
    expect(harness.persisted).toEqual([]);
  });

  it("applies the same rule to a failed round", () => {
    const live = record();
    sessionStreamHandler(live.deps)(
      JSON.stringify({ type: "deep_think_error", job_id: "r", error: "sem credito" }),
    );
    expect(live.sent).toHaveLength(1);
    expect(live.responses()).toBe(1);

    const replayed = record();
    sessionStreamHandler(replayed.deps)(
      JSON.stringify({
        type: "deep_think_error",
        job_id: "r",
        error: "sem credito",
        replay: true,
      }),
    );
    expect(replayed.deepThinkJobs()[0]?.status).toBe("error");
    expect(replayed.sent).toEqual([]);
    expect(replayed.responses()).toBe(0);
  });

  it("still guards the pi agent jobs it always guarded", () => {
    const live = record();
    sessionStreamHandler(live.deps)(
      JSON.stringify({ type: "done", job_id: "job_1", result: "achei o bug" }),
    );
    expect(live.sent).toHaveLength(1);
    expect(live.jobs()[0]?.status).toBe("done");

    const replayed = record();
    sessionStreamHandler(replayed.deps)(
      JSON.stringify({ type: "done", job_id: "job_1", result: "achei o bug", replay: true }),
    );
    expect(replayed.jobs()[0]?.result).toBe("achei o bug");
    expect(replayed.sent).toEqual([]);
  });

  it("guards a failed pi job as well as a finished one", () => {
    const live = record();
    sessionStreamHandler(live.deps)(
      JSON.stringify({ type: "error", job_id: "job_2", error: "timeout" }),
    );
    expect(live.sent).toHaveLength(1);
    expect(live.responses()).toBe(1);

    const replayed = record();
    sessionStreamHandler(replayed.deps)(
      JSON.stringify({ type: "error", job_id: "job_2", error: "timeout", replay: true }),
    );

    // Rendered — the card and its transcript line are the point of a replay.
    expect(replayed.jobs()[0]?.status).toBe("error");
    expect(replayed.entries).toHaveLength(1);

    // Not spoken: reconnecting must not make the model announce an hour-old
    // failure, once per reconnect, for as long as the job is retained.
    expect(replayed.sent).toEqual([]);
    expect(replayed.responses()).toBe(0);
  });

  it("never treats an activity event as replayable — it carries no such flag", () => {
    expect(isReplay({ type: "activity", job_id: "j", activity: "lendo" })).toBe(false);
    expect(
      isReplay({ type: "deep_think_activity", job_id: "j", activity: "lendo", thinkers: [] }),
    ).toBe(false);
    expect(isReplay({ type: "deep_think_done", job_id: "j", synthesis: "", thinkers: [] })).toBe(
      false,
    );
    expect(
      isReplay({
        type: "deep_think_done",
        job_id: "j",
        synthesis: "",
        thinkers: [],
        replay: true,
      }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

describe("deep_think_activity", () => {
  it("updates the card and says nothing out loud", () => {
    const harness = record();
    const handle = sessionStreamHandler(harness.deps);

    handle(
      JSON.stringify({
        type: "deep_think_activity",
        job_id: "round_1",
        activity: "3 de 5 pensadores terminaram",
        thinkers: THINKERS,
      }),
    );

    const round = harness.deepThinkJobs()[0];
    expect(round?.activity).toBe("3 de 5 pensadores terminaram");
    expect(round?.status).toBe("running");
    expect(round?.thinkers).toEqual(THINKERS);

    expect(harness.sent).toEqual([]);
    expect(harness.responses()).toBe(0);
  });

  it("keeps folding into the same card, then closes it", () => {
    const harness = record();
    const handle = sessionStreamHandler(harness.deps);

    handle(
      JSON.stringify({
        type: "deep_think_activity",
        job_id: "round_1",
        activity: "pensando",
        thinkers: [THINKERS[0]!],
      }),
    );
    handle(
      JSON.stringify({
        type: "deep_think_activity",
        job_id: "round_1",
        activity: "sintetizando",
        thinkers: THINKERS,
      }),
    );
    handle(
      JSON.stringify({
        type: "deep_think_done",
        job_id: "round_1",
        synthesis: SYNTHESIS,
        thinkers: THINKERS,
      }),
    );

    expect(harness.deepThinkJobs()).toHaveLength(1);
    expect(harness.deepThinkJobs()[0]?.status).toBe("done");
    expect(harness.deepThinkJobs()[0]?.started_at).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// meta survives the tool call
// ---------------------------------------------------------------------------

const DIAGRAM: MermaidDiagram = {
  id: "diagram_1",
  kind: "flowchart",
  title: "Fluxo do login",
  source: "flowchart TD\n  A[Usuario] --> B[Token]",
  caption: "Desenhei o fluxo do login em quatro passos.",
  created_at: "2026-08-08T12:00:00.000Z",
};

describe("meta.diagram reaches the state", () => {
  it("survives runTool and lands in the diagram list", async () => {
    // The real `api.runTool` against a stubbed backend response: this is the
    // whole path the diagram takes, and the line that used to drop it
    // (`return { call, output: result.output }`) sat right in the middle of it.
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              call_id: "call_1",
              name: "generate_diagram",
              output: DIAGRAM.caption,
              meta: { diagram: DIAGRAM },
            }),
        }),
      ),
    );

    const outcomes = await executeToolCalls(CONV, [
      { name: "generate_diagram", call_id: "call_1", arguments: '{"instructions":"o login"}' },
    ]);

    // What the model hears is the caption alone — no mermaid, ever.
    expect(outcomes[0]?.output).toBe(DIAGRAM.caption);
    expect(outcomes[0]?.output).not.toContain("flowchart TD");

    // What the screen gets is the drawing, folded exactly as the hook folds it.
    const diagrams = outcomes
      .map((outcome) => outcome.diagram)
      .filter((diagram): diagram is MermaidDiagram => diagram !== null)
      .reduce(appendDiagram, [] as MermaidDiagram[]);

    expect(diagrams).toEqual([DIAGRAM]);
    expect(diagrams[0]?.source).toContain("flowchart TD");
  });

  it("turns a failed tool into an output the model can answer, not a rejection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 500,
          text: () => Promise.resolve(JSON.stringify({ error: "sem chave" })),
        }),
      ),
    );

    const outcomes = await executeToolCalls(CONV, [
      { name: "generate_diagram", call_id: "call_1", arguments: "{}" },
    ]);

    expect(outcomes[0]?.output).toContain("A ferramenta falhou");
    expect(outcomes[0]?.diagram).toBeNull();
  });

  it("reads nothing out of a meta that has no diagram in it", () => {
    expect(diagramFromMeta(null)).toBeNull();
    expect(diagramFromMeta({})).toBeNull();
    expect(diagramFromMeta({ job_id: "j", status: "running" })).toBeNull();
    // A kind mermaid never supported renders as an error box, so it is refused
    // at the boundary rather than handed to the renderer.
    expect(diagramFromMeta({ diagram: { ...DIAGRAM, kind: "venn" } })).toBeNull();
    expect(diagramFromMeta({ diagram: { ...DIAGRAM, source: 42 } })).toBeNull();
  });

  it("replaces a redrawn diagram instead of stacking it", () => {
    const redrawn: MermaidDiagram = { ...DIAGRAM, source: "flowchart LR\n  A --> C" };
    const list = appendDiagram(appendDiagram([], DIAGRAM), redrawn);

    expect(list).toHaveLength(1);
    expect(list[0]?.source).toContain("LR");
  });
});

// ---------------------------------------------------------------------------
// The folds themselves
// ---------------------------------------------------------------------------

describe("applyDeepThinkEvent", () => {
  it("seeds a card from an event that arrives before any other", () => {
    const jobs = applyDeepThinkEvent(
      [],
      { type: "deep_think_activity", job_id: "r", activity: "abrindo", thinkers: [] },
      CONV,
      AT,
    );

    expect(jobs[0]).toMatchObject({
      id: "r",
      conversation_id: CONV,
      scenario: "",
      status: "running",
      started_at: AT,
    });
  });

  it("leaves the list alone for an unknown discriminant", () => {
    const before: DeepThinkJob[] = [];
    const after = applyDeepThinkEvent(
      before,
      { type: "deep_think_unknown" } as unknown as Parameters<typeof applyDeepThinkEvent>[1],
      CONV,
      AT,
    );
    expect(after).toBe(before);
  });
});

describe("applyAgentJobEvent", () => {
  it("still folds the three pi events it always folded", () => {
    let jobs = applyAgentJobEvent([], { type: "activity", job_id: "j", activity: "lendo" }, CONV, AT);
    expect(jobs[0]?.activity).toBe("lendo");

    jobs = applyAgentJobEvent(jobs, { type: "done", job_id: "j", result: "pronto" }, CONV, AT);
    expect(jobs[0]).toMatchObject({ status: "done", result: "pronto" });

    jobs = applyAgentJobEvent(jobs, { type: "error", job_id: "k", error: "timeout" }, CONV, AT);
    expect(jobs).toHaveLength(2);
    expect(jobs[1]).toMatchObject({ status: "error", error: "timeout" });
  });
});

// ---------------------------------------------------------------------------
// A round that ended without a conclusion
// ---------------------------------------------------------------------------

describe("a deep_think_done with nothing in it", () => {
  it("injects nothing rather than the string 'undefined'", () => {
    const harness = record();

    // `synthesis` is declared on the wire and not guaranteed on it. Templated
    // straight into the turn, an absent one became the literal word
    // "undefined" — which the model would then read out loud as the
    // conclusion of a deliberation the user paid for.
    sessionStreamHandler(harness.deps)(
      JSON.stringify({ type: "deep_think_done", job_id: "r", thinkers: [] }),
    );

    expect(harness.deepThinkJobs()[0]?.status).toBe("done");
    expect(harness.deepThinkJobs()[0]?.synthesis).toBe("");
    expect(harness.sent).toEqual([]);
    expect(harness.responses()).toBe(0);
    expect(harness.persisted).toEqual([]);
    expect(harness.entries).toEqual([]);
    expect(JSON.stringify(harness.deepThinkJobs())).not.toContain("undefined");
  });

  it("treats a synthesis that is not a string as no synthesis", () => {
    const harness = record();
    sessionStreamHandler(harness.deps)(
      JSON.stringify({ type: "deep_think_done", job_id: "r", synthesis: 42, thinkers: [] }),
    );

    expect(harness.deepThinkJobs()[0]?.synthesis).toBe("");
    expect(harness.sent).toEqual([]);
  });

  it("still speaks a round that did conclude", () => {
    const harness = record();
    sessionStreamHandler(harness.deps)(
      JSON.stringify({
        type: "deep_think_done",
        job_id: "r",
        synthesis: SYNTHESIS,
        thinkers: THINKERS,
      }),
    );

    expect(harness.sent).toHaveLength(1);
    expect(harness.responses()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Order of arrival
// ---------------------------------------------------------------------------

describe("a round ends exactly once", () => {
  it("does not let a late activity drag a finished round back to running", () => {
    const harness = record();
    const handle = sessionStreamHandler(harness.deps);

    handle(
      JSON.stringify({
        type: "deep_think_done",
        job_id: "r",
        synthesis: SYNTHESIS,
        thinkers: THINKERS,
      }),
    );
    handle(
      JSON.stringify({
        type: "deep_think_activity",
        job_id: "r",
        activity: "4 de 5 pensadores terminaram",
        thinkers: [],
      }),
    );

    const round = harness.deepThinkJobs()[0];
    expect(round?.status).toBe("done");
    expect(round?.activity).toBe("concluido");
    expect(round?.thinkers).toHaveLength(2);
    expect(round?.synthesis).toBe(SYNTHESIS);
  });

  it("never lets one card carry both an error and a synthesis", () => {
    const harness = record();
    const handle = sessionStreamHandler(harness.deps);

    handle(JSON.stringify({ type: "deep_think_error", job_id: "r", error: "sem credito" }));
    handle(
      JSON.stringify({
        type: "deep_think_done",
        job_id: "r",
        synthesis: SYNTHESIS,
        thinkers: THINKERS,
      }),
    );

    const round = harness.deepThinkJobs()[0];
    expect(round?.status).toBe("error");
    expect(round?.error).toBe("sem credito");
    expect(round?.synthesis).toBeUndefined();

    // And the model hears about the failure once, not about both.
    expect(harness.sent).toHaveLength(1);
    expect(JSON.stringify(harness.sent[0])).toContain("sem credito");
    expect(harness.responses()).toBe(1);
  });

  it("refuses the same reversal at the fold, where the card actually lives", () => {
    const ended = applyDeepThinkEvent(
      [],
      { type: "deep_think_error", job_id: "r", error: "sem credito" },
      CONV,
      AT,
    );
    const after = applyDeepThinkEvent(
      ended,
      { type: "deep_think_done", job_id: "r", synthesis: SYNTHESIS, thinkers: [] },
      CONV,
      AT,
    );

    expect(after).toBe(ended);
  });
});

// ---------------------------------------------------------------------------
// Ceilings
// ---------------------------------------------------------------------------

describe("neither list grows without bound", () => {
  it("keeps the newest diagrams and drops the rest", () => {
    let list: MermaidDiagram[] = [];
    for (let i = 0; i < MAX_DIAGRAMS + 10; i += 1) {
      list = appendDiagram(list, { ...DIAGRAM, id: `d${i}` });
    }

    expect(list).toHaveLength(MAX_DIAGRAMS);
    expect(list[0]?.id).toBe("d10");
    expect(list.at(-1)?.id).toBe(`d${MAX_DIAGRAMS + 9}`);
  });

  it("keeps the newest rounds and drops the rest", () => {
    let rounds: DeepThinkJob[] = [];
    for (let i = 0; i < MAX_DEEP_THINK_JOBS + 5; i += 1) {
      rounds = applyDeepThinkEvent(
        rounds,
        { type: "deep_think_activity", job_id: `r${i}`, activity: "pensando", thinkers: [] },
        CONV,
        AT,
      );
    }

    expect(rounds).toHaveLength(MAX_DEEP_THINK_JOBS);
    expect(rounds[0]?.id).toBe("r5");
    expect(rounds.at(-1)?.id).toBe(`r${MAX_DEEP_THINK_JOBS + 4}`);
  });

  it("does not evict when an existing entry is merely updated", () => {
    let list: MermaidDiagram[] = [];
    for (let i = 0; i < MAX_DIAGRAMS; i += 1) {
      list = appendDiagram(list, { ...DIAGRAM, id: `d${i}` });
    }
    list = appendDiagram(list, { ...DIAGRAM, id: "d0", caption: "redesenhado" });

    expect(list).toHaveLength(MAX_DIAGRAMS);
    expect(list[0]?.caption).toBe("redesenhado");
  });
});

// ---------------------------------------------------------------------------
// The handshake belongs to one conversation
// ---------------------------------------------------------------------------

const OTHER_CONV = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

const TOKEN: RealtimeSessionToken = {
  value: "ek_test",
  expires_at: 1,
  model: "gpt-realtime-2.1",
  voice: "cedar",
  speed: 1,
  materials: [],
  tools: [],
  resumed: false,
  memory_events: 0,
};

/** Enough of an `RTCPeerConnection` to watch what the handshake does to it. */
function fakePeer() {
  const dc = { addEventListener: vi.fn(), close: vi.fn() };
  const peer = {
    ontrack: null,
    connectionState: "new",
    addTrack: vi.fn(),
    createDataChannel: vi.fn(() => dc),
    createOffer: vi.fn(() => Promise.resolve({ type: "offer", sdp: "v=0 offer" })),
    setLocalDescription: vi.fn(() => Promise.resolve()),
    setRemoteDescription: vi.fn(() => Promise.resolve()),
    addEventListener: vi.fn(),
    close: vi.fn(),
  };
  return { peer, dc, asPeer: peer as unknown as RTCPeerConnection };
}

/** A microphone whose light is `track.stop` not having been called. */
function fakeMic() {
  const track = { stop: vi.fn() };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  return { track, asStream: stream as unknown as MediaStream };
}

/** Let every pending microtask run, so the handshake reaches its next await. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("openRealtimeSession", () => {
  it("hands the mint the attempt's signal instead of leaving it unusable", async () => {
    const { peer, asPeer } = fakePeer();
    const { asStream } = fakeMic();
    const controller = new AbortController();
    const mint = vi.fn(() => Promise.resolve(TOKEN));

    const session = await openRealtimeSession({
      conversationId: CONV,
      signal: controller.signal,
      currentConversation: () => CONV,
      onServerEvent: () => {},
      onChannelOpen: () => {},
      onConnectionLost: () => {},
      browser: {
        mint,
        createPeerConnection: () => asPeer,
        createAudioSink: () => null,
        getMicrophone: () => Promise.resolve(asStream),
        exchangeSdp: () => Promise.resolve("v=0 answer"),
      },
    });

    // A signal the mint is never given is a cancellation nothing can perform.
    expect(mint).toHaveBeenCalledWith(CONV, { signal: controller.signal });

    expect(session?.token).toBe(TOKEN);
    expect(session?.pc).toBe(asPeer);
    expect(peer.addTrack).toHaveBeenCalledTimes(1);
    expect(peer.setRemoteDescription).toHaveBeenCalledWith({
      type: "answer",
      sdp: "v=0 answer",
    });
  });

  it("mounts nothing for a conversation the user left during the mint", async () => {
    const { peer, asPeer } = fakePeer();
    const { asStream } = fakeMic();
    const getMicrophone = vi.fn(() => Promise.resolve(asStream));
    let releaseMint!: (token: RealtimeSessionToken) => void;
    let current: string | null = CONV;

    const pending = openRealtimeSession({
      conversationId: CONV,
      signal: new AbortController().signal,
      currentConversation: () => current,
      onServerEvent: () => {},
      onChannelOpen: () => {},
      onConnectionLost: () => {},
      browser: {
        mint: () =>
          new Promise<RealtimeSessionToken>((resolve) => {
            releaseMint = resolve;
          }),
        createPeerConnection: () => asPeer,
        createAudioSink: () => null,
        getMicrophone,
        exchangeSdp: () => Promise.resolve("v=0 answer"),
      },
    });

    // The mint is still hanging — it can take the full 20 s deadline when the
    // conversation has memory to compress — and the user opens another one.
    current = OTHER_CONV;
    releaseMint(TOKEN);

    await expect(pending).resolves.toBeNull();
    expect(getMicrophone).not.toHaveBeenCalled();
    expect(peer.createDataChannel).not.toHaveBeenCalled();
    expect(peer.setRemoteDescription).not.toHaveBeenCalled();
  });

  it("gives the microphone back when the attempt is called off during the prompt", async () => {
    const { peer, asPeer } = fakePeer();
    const { track, asStream } = fakeMic();
    const controller = new AbortController();
    let grant!: (stream: MediaStream) => void;
    const microphone = new Promise<MediaStream>((resolve) => {
      grant = resolve;
    });
    const getMicrophone = vi.fn(() => microphone);

    const pending = openRealtimeSession({
      conversationId: CONV,
      signal: controller.signal,
      currentConversation: () => CONV,
      onServerEvent: () => {},
      onChannelOpen: () => {},
      onConnectionLost: () => {},
      browser: {
        mint: () => Promise.resolve(TOKEN),
        createPeerConnection: () => asPeer,
        createAudioSink: () => null,
        getMicrophone,
        exchangeSdp: () => Promise.resolve("v=0 answer"),
      },
    });

    await settle();
    expect(getMicrophone).toHaveBeenCalledTimes(1);

    controller.abort();
    grant(asStream);

    await expect(pending).resolves.toBeNull();
    // Stopping the track is what actually turns the light off; a stream taken
    // and then dropped on the floor keeps the microphone open for nobody.
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(peer.close).toHaveBeenCalledTimes(1);
    expect(peer.createDataChannel).not.toHaveBeenCalled();
  });

  it("does not finish a handshake abandoned during the SDP exchange", async () => {
    const { peer, asPeer } = fakePeer();
    const { track, asStream } = fakeMic();
    let current: string | null = CONV;
    let answer!: (sdp: string) => void;
    const exchange = new Promise<string>((resolve) => {
      answer = resolve;
    });

    const pending = openRealtimeSession({
      conversationId: CONV,
      signal: new AbortController().signal,
      currentConversation: () => current,
      onServerEvent: () => {},
      onChannelOpen: () => {},
      onConnectionLost: () => {},
      browser: {
        mint: () => Promise.resolve(TOKEN),
        createPeerConnection: () => asPeer,
        createAudioSink: () => null,
        getMicrophone: () => Promise.resolve(asStream),
        exchangeSdp: () => exchange,
      },
    });

    await settle();
    current = OTHER_CONV;
    answer("v=0 answer");

    await expect(pending).resolves.toBeNull();
    expect(peer.setRemoteDescription).not.toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(peer.close).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// The stream is a network boundary, and every field on it is optional in
// practice. Each case below is a frame the server should never send, and the
// assertion is that the browser survives it — the cards render these values
// straight into `.map`, `.toFixed` and a spoken sentence.
// ---------------------------------------------------------------------------

describe("a deliberation event with no thinkers in it", () => {
  it("folds an absent list into an empty one instead of undefined", () => {
    const jobs = applyDeepThinkEvent(
      [],
      { type: "deep_think_activity", job_id: "d1", activity: "pensando" } as never,
      CONV,
      AT,
    );

    // The card does `job.thinkers.filter(...)` before it renders anything.
    expect(jobs[0]?.thinkers).toEqual([]);
    expect(() => jobs[0]!.thinkers.map((t) => t.id)).not.toThrow();
  });

  it("refuses a thinkers field that is not a list at all", () => {
    const jobs = applyDeepThinkEvent(
      [],
      {
        type: "deep_think_done",
        job_id: "d1",
        synthesis: SYNTHESIS,
        thinkers: "dois pensadores",
      } as never,
      CONV,
      AT,
    );

    expect(jobs[0]?.thinkers).toEqual([]);
    expect(jobs[0]?.synthesis).toBe(SYNTHESIS);
  });

  it("drops a poisoned entry rather than letting the row throw on it", () => {
    const jobs = applyDeepThinkEvent(
      [],
      {
        type: "deep_think_activity",
        job_id: "d1",
        activity: "pensando",
        thinkers: [null, "nao e um pensador", { id: "t1", angle: "riscos", status: "done" }],
      } as never,
      CONV,
      AT,
    );

    expect(jobs[0]?.thinkers).toHaveLength(1);
    expect(jobs[0]?.thinkers[0]?.id).toBe("t1");
  });

  it("gives a thinker with no id one, so two of them are not the same row", () => {
    const jobs = applyDeepThinkEvent(
      [],
      {
        type: "deep_think_activity",
        job_id: "d1",
        activity: "pensando",
        thinkers: [{ angle: "riscos" }, { angle: "custo" }],
      } as never,
      CONV,
      AT,
    );

    const ids = jobs[0]!.thinkers.map((thinker) => thinker.id);
    expect(new Set(ids).size).toBe(2);
    // Unknown state reads as "not started yet", the one status that promises
    // nothing about what the thinker found.
    expect(jobs[0]?.thinkers.every((thinker) => thinker.status === "pending")).toBe(true);
  });

  it("keeps a number out of the fields both cards call .toFixed on", () => {
    const jobs = applyDeepThinkEvent(
      [],
      {
        type: "deep_think_done",
        job_id: "d1",
        synthesis: SYNTHESIS,
        thinkers: [{ id: "t1", angle: "riscos", status: "done", usd: "0.02", searches: null }],
        cost_usd: "1.50",
      } as never,
      CONV,
      AT,
    );

    expect(jobs[0]?.cost_usd).toBeUndefined();
    expect(jobs[0]?.thinkers[0]?.usd).toBeUndefined();
    expect(jobs[0]?.thinkers[0]?.searches).toBeUndefined();
  });

  it("keeps a citation only when it can be linked to and named", () => {
    const jobs = applyDeepThinkEvent(
      [],
      {
        type: "deep_think_done",
        job_id: "d1",
        synthesis: SYNTHESIS,
        thinkers: [
          {
            id: "t1",
            angle: "riscos",
            status: "done",
            citations: [{ url: "https://a.example", title: "A" }, { snippet: "sem url" }, null],
          },
        ],
      } as never,
      CONV,
      AT,
    );

    expect(jobs[0]?.thinkers[0]?.citations).toEqual([
      { url: "https://a.example", title: "A" },
    ]);
  });
});

describe("a failure the server described in no words", () => {
  it("never speaks the string 'undefined' for a round", () => {
    const r = record();
    sessionStreamHandler(r.deps)(JSON.stringify({ type: "deep_think_error", job_id: "d1" }));

    expect(r.deepThinkJobs()[0]?.status).toBe("error");
    expect(r.deepThinkJobs()[0]?.error).toBe("");

    const spoken = JSON.stringify(r.sent) + JSON.stringify(r.entries);
    expect(spoken).not.toContain("undefined");
    expect(spoken).toContain("o servidor nao disse o motivo");
  });

  it("never speaks the string 'undefined' for a pi agent either", () => {
    const r = record();
    sessionStreamHandler(r.deps)(JSON.stringify({ type: "error", job_id: "a1" }));

    expect(r.jobs()[0]?.status).toBe("error");
    expect(r.jobs()[0]?.error).toBe("");

    const spoken = JSON.stringify(r.sent) + JSON.stringify(r.entries);
    expect(spoken).not.toContain("undefined");
  });

  it("says nothing at all about an agent that finished with no result", () => {
    const r = record();
    sessionStreamHandler(r.deps)(JSON.stringify({ type: "done", job_id: "a1" }));

    // The card still closes; it is only the spoken turn that is withheld, the
    // same rule a round with an empty synthesis follows.
    expect(r.jobs()[0]?.status).toBe("done");
    expect(r.jobs()[0]?.result).toBe("");
    expect(r.entries).toHaveLength(0);
    expect(r.sent).toHaveLength(0);
    expect(r.responses()).toBe(0);
  });

  it("keeps a non-string result out of the sentence handed to the model", () => {
    const r = record();
    sessionStreamHandler(r.deps)(
      JSON.stringify({ type: "done", job_id: "a1", result: { text: "achei" } }),
    );

    expect(r.jobs()[0]?.result).toBe("");
    expect(r.sent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// A pi job ends exactly once, for the same reason a round does
// ---------------------------------------------------------------------------

describe("applyAgentJobEvent is monotonic too", () => {
  it("does not let a late activity drag a finished agent back to running", () => {
    const done = applyAgentJobEvent(
      [],
      { type: "done", job_id: "a1", result: "achei o bug" },
      CONV,
      AT,
    );
    const late = applyAgentJobEvent(
      done,
      { type: "activity", job_id: "a1", activity: "lendo o repositorio" },
      CONV,
      AT,
    );

    expect(late).toBe(done);
    expect(late[0]?.status).toBe("done");
    expect(late[0]?.activity).toBe("concluido");
  });

  it("never lets one card carry both an error and a result", () => {
    const failed = applyAgentJobEvent(
      [],
      { type: "error", job_id: "a1", error: "o agente estourou o tempo" },
      CONV,
      AT,
    );
    const late = applyAgentJobEvent(
      failed,
      { type: "done", job_id: "a1", result: "achei o bug" },
      CONV,
      AT,
    );

    expect(late[0]?.status).toBe("error");
    expect(late[0]?.result).toBeUndefined();
  });

  it("leaves a job the user cancelled cancelled", () => {
    const cancelled: AgentJob[] = [
      {
        id: "a1",
        conversation_id: CONV,
        prompt: "",
        cwd: "",
        status: "cancelled",
        activity: "cancelado",
        started_at: AT,
      },
    ];

    const late = applyAgentJobEvent(
      cancelled,
      { type: "activity", job_id: "a1", activity: "lendo o repositorio" },
      CONV,
      AT,
    );

    expect(late).toBe(cancelled);
  });

  it("still folds the three events in the order they normally arrive", () => {
    let jobs = applyAgentJobEvent(
      [],
      { type: "activity", job_id: "a1", activity: "lendo o repositorio" },
      CONV,
      AT,
    );
    expect(jobs[0]?.status).toBe("running");

    jobs = applyAgentJobEvent(
      jobs,
      { type: "done", job_id: "a1", result: "achei o bug", cost_usd: 0.02 },
      CONV,
      AT,
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.result).toBe("achei o bug");
    expect(jobs[0]?.cost_usd).toBe(0.02);
  });
});

// ---------------------------------------------------------------------------
// The gallery survives a reload
// ---------------------------------------------------------------------------

function diagram(id: string, createdAt: string): MermaidDiagram {
  return {
    id,
    kind: "flowchart",
    source: "flowchart TD\n  A --> B",
    caption: `desenho ${id}`,
    created_at: createdAt,
  };
}

describe("seedDiagrams", () => {
  it("puts what the conversation remembered in front of what it just drew", () => {
    const live = [diagram("novo", "2026-08-08T12:00:00.000Z")];
    const seeded = seedDiagrams(live, [
      diagram("antigo-1", "2026-08-01T10:00:00.000Z"),
      diagram("antigo-2", "2026-08-01T11:00:00.000Z"),
    ]);

    expect(seeded.map((d) => d.id)).toEqual(["antigo-1", "antigo-2", "novo"]);
  });

  it("lets the live redraw win over the remembered version of the same id", () => {
    const live = [{ ...diagram("d1", "2026-08-08T12:00:00.000Z"), caption: "redesenhado" }];
    const seeded = seedDiagrams(live, [diagram("d1", "2026-08-01T10:00:00.000Z")]);

    expect(seeded).toHaveLength(1);
    expect(seeded[0]?.caption).toBe("redesenhado");
  });

  it("does not touch the list when the file has nothing new to add", () => {
    const live = [diagram("d1", "2026-08-08T12:00:00.000Z")];
    expect(seedDiagrams(live, [])).toBe(live);
    expect(seedDiagrams(live, [diagram("d1", "2026-08-01T10:00:00.000Z")])).toBe(live);
  });

  it("respects the same ceiling the live gallery has, keeping the newest", () => {
    const live = [diagram("novo", "2026-08-08T12:00:00.000Z")];
    const remembered = Array.from({ length: MAX_DIAGRAMS + 10 }, (_, i) =>
      diagram(`antigo-${i}`, "2026-08-01T10:00:00.000Z"),
    );

    const seeded = seedDiagrams(live, remembered);
    expect(seeded).toHaveLength(MAX_DIAGRAMS);
    expect(seeded[seeded.length - 1]?.id).toBe("novo");
  });
});

describe("mergeConversationItems", () => {
  const entry = (id: string, timestamp: string): TranscriptEntry => ({
    id,
    role: "assistant",
    text: id,
    final: true,
    timestamp,
  });

  it("puts a diagram after the turn that asked for it", () => {
    const items = mergeConversationItems(
      [entry("pergunta", "2026-08-08T12:00:00.000Z"), entry("resposta", "2026-08-08T12:00:10.000Z")],
      [diagram("d1", "2026-08-08T12:00:05.000Z")],
    );

    expect(items.map((item) => item.key)).toEqual([
      "pergunta",
      "diagram-d1",
      "resposta",
    ]);
  });

  it("puts a resumed conversation's old drawings above today's first sentence", () => {
    const items = mergeConversationItems(
      [entry("hoje", "2026-08-08T12:00:00.000Z")],
      [diagram("semana-passada", "2026-08-01T09:00:00.000Z")],
    );

    expect(items[0]?.kind).toBe("diagram");
    expect(items[1]?.key).toBe("hoje");
  });

  it("keeps a drawing that arrives after the last turn at the end", () => {
    const items = mergeConversationItems(
      [entry("pergunta", "2026-08-08T12:00:00.000Z")],
      [diagram("d1", "2026-08-08T12:00:30.000Z")],
    );

    expect(items.map((item) => item.key)).toEqual(["pergunta", "diagram-d1"]);
  });

  it("renders each list on its own when the other one is empty", () => {
    expect(mergeConversationItems([], [diagram("d1", "2026-08-08T12:00:00.000Z")])).toHaveLength(1);
    expect(mergeConversationItems([entry("a", "2026-08-08T12:00:00.000Z")], [])).toHaveLength(1);
    expect(mergeConversationItems([], [])).toEqual([]);
  });

  it("does not lose a diagram whose timestamp cannot be read", () => {
    const items = mergeConversationItems(
      [entry("pergunta", "2026-08-08T12:00:00.000Z")],
      [diagram("quebrado", "nao e uma data")],
    );

    expect(items).toHaveLength(2);
    expect(items.map((item) => item.key)).toContain("diagram-quebrado");
  });
});
