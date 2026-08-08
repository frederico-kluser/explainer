import { useCallback, useEffect, useRef, useState } from "react";

import * as api from "@/lib/api";
import {
  CLEAR_OUTPUT_AUDIO,
  DATA_CHANNEL_NAME,
  ITEM_ACK_EVENTS,
  REALTIME_CALLS_URL,
  RESPONSE_CREATE,
  functionCallsFrom,
  functionOutputEvent,
  userTextEvent,
  type RealtimeFunctionCall,
  type RealtimeServerEvent,
} from "@/lib/realtime";
import type {
  AgentJob,
  AgentJobEvent,
  BraveResult,
  DeepThinkEvent,
  DeepThinkJob,
  MermaidDiagram,
  MermaidDiagramKind,
  RealtimeSessionToken,
  SessionStreamEvent,
  ThinkerResult,
  ThinkerStatus,
  TranscriptEntry,
} from "@/types";

export type SessionStatus = "idle" | "connecting" | "live" | "error";

export interface RealtimeSessionState {
  status: SessionStatus;
  error: string | null;
  transcript: TranscriptEntry[];
  userSpeaking: boolean;
  assistantSpeaking: boolean;
  /** Name of the tool the model is waiting on right now, if any. */
  activeTool: string | null;
  jobs: AgentJob[];
  /** Deliberation rounds, newest last, for the fan of thinkers on screen. */
  deepThinkJobs: DeepThinkJob[];
  /**
   * Every diagram this session drew, in order.
   *
   * The mermaid source only ever exists here: it travels in the tool result's
   * `meta`, never in `output`, because anything in `output` is read out loud.
   */
  diagrams: MermaidDiagram[];
  /** This session picked a previous conversation back up. */
  resumed: boolean;
  /** How many recorded events that resume was built from. */
  memoryEvents: number;
  /** What this session has spent so far, in USD, priced by the server. */
  sessionUsd: number;
  connect: () => Promise<void>;
  disconnect: () => void;
  sendText: (text: string) => void;
  cancelJob: (jobId: string) => void;
  /**
   * Re-read the stored memory and re-seed the gallery from it.
   *
   * For the caller that lets the user import or erase a memory file: an import
   * replaces the whole file, drawings included, so the gallery on screen is
   * stale the moment it lands.
   */
  reloadMemory: () => void;
  /** Playback speed, pushable mid-call (unlike the voice, which is frozen). */
  setSpeed: (speed: number) => void;
}

/** How long to wait for the server to acknowledge our items before asking for a response. */
const ACK_TIMEOUT_MS = 2_500;

/**
 * How many diagrams the gallery keeps, newest last.
 *
 * The same number as `MEMORY_MAX_DIAGRAMS_DEFAULT` in
 * `backend/src/services/memory.ts`: the file the user can reload from keeps 50,
 * so anything beyond that is a card no reload could ever bring back. Each entry
 * is mermaid source that gets re-rendered on every state change, which is why
 * this list gets a ceiling and the transcript does not.
 */
export const MAX_DIAGRAMS = 50;

/**
 * How many deliberation rounds the fan keeps, newest last.
 *
 * Mirrors `MAX_JOBS_RETAINED` in `backend/src/services/deep-think.ts`. The
 * server forgets round 51, so holding it here would only ever show a card that
 * nothing can refresh — and a round carries every thinker's full reasoning.
 */
export const MAX_DEEP_THINK_JOBS = 50;

function nowISO(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Diagrams
// ---------------------------------------------------------------------------

const DIAGRAM_KINDS: ReadonlySet<string> = new Set<MermaidDiagramKind>([
  "flowchart",
  "sequenceDiagram",
  "classDiagram",
  "stateDiagram-v2",
  "erDiagram",
  "journey",
  "gantt",
  "pie",
  "mindmap",
  "timeline",
]);

/**
 * Pull the diagram out of a tool result's `meta`, if there is one.
 *
 * `meta` is `Record<string, unknown>` on the wire, so this is the boundary where
 * it becomes a type. The kind is checked against the closed list rather than
 * cast: a kind mermaid never supported renders as an error box, and the server's
 * validator is one deploy away from ours.
 */
export function diagramFromMeta(meta: api.ToolMeta | null | undefined): MermaidDiagram | null {
  const candidate = meta?.diagram;
  if (!candidate || typeof candidate !== "object") return null;

  const draft = candidate as Partial<MermaidDiagram>;
  if (typeof draft.id !== "string" || typeof draft.source !== "string") return null;
  if (typeof draft.kind !== "string" || !DIAGRAM_KINDS.has(draft.kind)) return null;

  return {
    id: draft.id,
    kind: draft.kind,
    source: draft.source,
    caption: typeof draft.caption === "string" ? draft.caption : "",
    created_at: typeof draft.created_at === "string" ? draft.created_at : nowISO(),
    ...(typeof draft.title === "string" ? { title: draft.title } : {}),
  };
}

/**
 * Add a diagram to the gallery, replacing any earlier one with the same id.
 *
 * The model regenerates a drawing it is unhappy with, and the server reuses the
 * id when it does; appending blindly would leave the rejected version on screen
 * next to its replacement.
 */
export function appendDiagram(
  diagrams: MermaidDiagram[],
  diagram: MermaidDiagram,
): MermaidDiagram[] {
  const index = diagrams.findIndex((existing) => existing.id === diagram.id);
  if (index === -1) return [...diagrams, diagram].slice(-MAX_DIAGRAMS);
  const next = [...diagrams];
  next[index] = diagram;
  return next;
}

/**
 * Put the diagrams a conversation already had back in front of the live ones.
 *
 * Without this the gallery dies with the tab: `MemoryFile.diagrams` persists
 * every drawing and `GET …/memory` hands them all back, but nothing was reading
 * them, so reloading the page left the model referring out loud to pictures that
 * no longer existed.
 *
 * Remembered first, because they are older, and a live redraw of the same id
 * wins — it is the version the user is looking at. The ceiling is the same
 * `MAX_DIAGRAMS`, applied from the end so that what survives is the newest.
 */
export function seedDiagrams(
  live: MermaidDiagram[],
  remembered: readonly MermaidDiagram[],
): MermaidDiagram[] {
  const known = new Set(live.map((diagram) => diagram.id));
  const restored = remembered.filter((diagram) => !known.has(diagram.id));
  if (restored.length === 0) return live;
  return [...restored, ...live].slice(-MAX_DIAGRAMS);
}

/**
 * The transcript and the gallery as one column, in the order things happened.
 *
 * A diagram is not an aside to the conversation — it is the answer to the turn
 * that asked for it, and the model says its caption out loud while it appears.
 * Appending the gallery after the transcript reads fine until a conversation is
 * resumed, at which point every drawing from last week sits underneath today's
 * first sentence.
 *
 * Both lists are already ordered by their own clock, so this is a merge, not a
 * sort: a diagram goes ahead of the first transcript line stamped later than it.
 * Ties go to the transcript, so a drawing lands after the turn that asked for it
 * rather than before it.
 */
export type ConversationItem =
  | { kind: "entry"; key: string; entry: TranscriptEntry }
  | { kind: "diagram"; key: string; diagram: MermaidDiagram };

export function mergeConversationItems(
  transcript: readonly TranscriptEntry[],
  diagrams: readonly MermaidDiagram[],
): ConversationItem[] {
  const items: ConversationItem[] = [];
  let next = 0;

  for (const entry of transcript) {
    const at = Date.parse(entry.timestamp);
    while (next < diagrams.length) {
      const diagram = diagrams[next]!;
      const drawn = Date.parse(diagram.created_at);
      // An unparseable stamp keeps its arrival order instead of jumping to the
      // front, which is where `NaN < at` would never put it anyway.
      if (!Number.isFinite(drawn) || !Number.isFinite(at) || drawn >= at) break;
      items.push({ kind: "diagram", key: `diagram-${diagram.id}`, diagram });
      next += 1;
    }
    items.push({ kind: "entry", key: entry.id, entry });
  }

  for (; next < diagrams.length; next += 1) {
    const diagram = diagrams[next]!;
    items.push({ kind: "diagram", key: `diagram-${diagram.id}`, diagram });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Tool bridge
// ---------------------------------------------------------------------------

export interface ToolCallOutcome {
  call: RealtimeFunctionCall;
  /** What goes back to the model. Spoken, so it never carries mermaid or a uuid. */
  output: string;
  /** What goes on screen. Dropped by every version of this file before Wave 3. */
  diagram: MermaidDiagram | null;
}

/**
 * Run the model's function calls on the server, in parallel, keeping `meta`.
 *
 * Extracted from the hook so it can be exercised without a DOM: this suite has
 * no jsdom, so a React hook cannot be rendered, and the alternative to a seam
 * like this is not testing the plumbing at all.
 *
 * A failure becomes an output rather than a rejection — the model has to be told
 * the tool failed, in a turn it can answer, or the conversation stalls waiting
 * for a `function_call_output` that never comes.
 */
export async function executeToolCalls(
  conversationId: string,
  calls: readonly RealtimeFunctionCall[],
  runTool: typeof api.runTool = api.runTool,
): Promise<ToolCallOutcome[]> {
  return Promise.all(
    calls.map(async (call): Promise<ToolCallOutcome> => {
      try {
        const result = await runTool(conversationId, call);
        return { call, output: result.output, diagram: diagramFromMeta(result.meta) };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { call, output: `A ferramenta falhou: ${message}`, diagram: null };
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// The job stream
// ---------------------------------------------------------------------------

/**
 * Which half of the stream an event belongs to.
 *
 * `GET /api/agents/events` carries pi jobs and deliberation rounds on one
 * connection. Everything downstream narrows here first, so a `deep_think_*`
 * event can never reach the agent-job fold — where, before this existed, it fell
 * through `type === "done" ? … : …` into the error branch and produced a phantom
 * job card with `status: "error"` and no error in it.
 */
export function isDeepThinkEvent(event: SessionStreamEvent): event is DeepThinkEvent {
  return (
    event.type === "deep_think_activity" ||
    event.type === "deep_think_done" ||
    event.type === "deep_think_error"
  );
}

/**
 * Whether this event is the server catching a new stream up on the past.
 *
 * Replays repopulate the cards and stop there. Injecting one makes the model
 * narrate an answer from an hour ago on every single reconnect, and bills for
 * the audio — the deliberation synthesis being both the most expensive thing
 * this app produces and the longest thing it could read out.
 */
export function isReplay(event: SessionStreamEvent): boolean {
  return event.type !== "activity" && event.type !== "deep_think_activity"
    ? event.replay === true
    : false;
}

// ---------------------------------------------------------------------------
// Reading the stream's own fields
// ---------------------------------------------------------------------------
//
// Every event below is declared in `@/types` and guaranteed by nothing: the
// stream is a network boundary, the declarations describe what the server
// *means* to send, and a field that arrives absent or as the wrong type is a
// deploy skew away at all times. Each helper turns one such field into a value
// the rest of this file — and the cards downstream of it — can use without
// checking again.

/**
 * A text field as text.
 *
 * An absent `synthesis` reached `${event.synthesis}` and injected the literal
 * string "undefined" into the conversation, which the model then read out loud
 * as if it were the conclusion. `result` and `error` sit in the same sentences.
 */
function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * A money field as money.
 *
 * Both cards render it as `cost_usd.toFixed(4)`, which throws on a string and
 * takes the whole sidebar down with it — React unmounts the tree that threw.
 */
function costOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

const THINKER_STATUSES: ReadonlySet<string> = new Set<ThinkerStatus>([
  "pending",
  "running",
  "done",
  "error",
]);

/** A citation is only useful if it can be linked to and named. */
function citationsOf(value: unknown): BraveResult[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const citations = value.filter(
    (candidate): candidate is BraveResult =>
      typeof candidate === "object" &&
      candidate !== null &&
      typeof (candidate as BraveResult).url === "string" &&
      typeof (candidate as BraveResult).title === "string",
  );
  return citations.length > 0 ? citations : undefined;
}

/**
 * The thinker list as a list of thinkers.
 *
 * `thinkers: undefined` breaks the `.map` that draws the fan, and a poisoned
 * element does the same from one step further in — `thinker.status` on a `null`
 * throws inside the render. So the entries are rebuilt field by field rather
 * than trusted, the way `sanitizeDiagrams` rebuilds the memory file's.
 */
function thinkersOf(value: unknown): ThinkerResult[] {
  if (!Array.isArray(value)) return [];

  const thinkers: ThinkerResult[] = [];
  value.forEach((candidate, index) => {
    if (typeof candidate !== "object" || candidate === null) return;
    const draft = candidate as Partial<ThinkerResult>;

    const thinker: ThinkerResult = {
      // The card keys its rows on `id`; two thinkers arriving without one would
      // collapse into a single row and React would reuse the wrong state.
      id: typeof draft.id === "string" && draft.id !== "" ? draft.id : `thinker-${index}`,
      angle: textOf(draft.angle),
      status:
        typeof draft.status === "string" && THINKER_STATUSES.has(draft.status)
          ? draft.status
          : "pending",
    };

    if (typeof draft.thinking === "string") thinker.thinking = draft.thinking;
    if (typeof draft.error === "string") thinker.error = draft.error;
    const citations = citationsOf(draft.citations);
    if (citations) thinker.citations = citations;
    const searches = costOf(draft.searches);
    if (searches !== undefined) thinker.searches = searches;
    const usd = costOf(draft.usd);
    if (usd !== undefined) thinker.usd = usd;

    thinkers.push(thinker);
  });
  return thinkers;
}

/**
 * A job in one of these has already ended, and a job ends exactly once.
 *
 * `cancelled` is in the set even though the stream never sends it: a job list
 * seeded from `GET /api/agents` can already hold one, and a late `activity`
 * frame for it would otherwise show it working again after the user stopped it.
 */
const TERMINAL_AGENT_JOB: ReadonlySet<AgentJob["status"]> = new Set<
  AgentJob["status"]
>(["done", "error", "cancelled"]);

export function applyAgentJobEvent(
  jobs: AgentJob[],
  event: AgentJobEvent,
  conversationId: string,
  at: string,
): AgentJob[] {
  const index = jobs.findIndex((job) => job.id === event.job_id);
  const base: AgentJob =
    index === -1
      ? {
          id: event.job_id,
          conversation_id: conversationId,
          prompt: "",
          cwd: "",
          status: "running",
          activity: "",
          started_at: at,
        }
      : jobs[index]!;

  // The same one-way transition `applyDeepThinkEvent` makes below, for the same
  // reason: SSE promises delivery, not order. An `activity` frame overtaking the
  // `done` it precedes used to drag a finished agent back to "rodando", and an
  // error followed by a done left one card holding both an error and a result.
  if (index !== -1 && TERMINAL_AGENT_JOB.has(base.status)) return jobs;

  let updated: AgentJob;
  switch (event.type) {
    case "activity":
      updated = { ...base, activity: textOf(event.activity) };
      break;
    case "done":
      updated = {
        ...base,
        status: "done",
        activity: "concluido",
        result: textOf(event.result),
        cost_usd: costOf(event.cost_usd),
        finished_at: at,
      };
      break;
    case "error":
      updated = {
        ...base,
        status: "error",
        activity: "falhou",
        error: textOf(event.error),
        finished_at: at,
      };
      break;
    default:
      // An event this client does not know is not a failed job. Ignoring it
      // costs a card; folding it in invents one.
      return jobs;
  }

  const next = [...jobs];
  if (index === -1) next.push(updated);
  else next[index] = updated;
  return next;
}

/** A round in one of these has already ended, and a round ends exactly once. */
const TERMINAL_DEEP_THINK: ReadonlySet<DeepThinkJob["status"]> = new Set<
  DeepThinkJob["status"]
>(["done", "error", "cancelled"]);

export function applyDeepThinkEvent(
  jobs: DeepThinkJob[],
  event: DeepThinkEvent,
  conversationId: string,
  at: string,
): DeepThinkJob[] {
  const index = jobs.findIndex((job) => job.id === event.job_id);
  const base: DeepThinkJob =
    index === -1
      ? {
          id: event.job_id,
          conversation_id: conversationId,
          // The stream never carries the scenario — only the server saw what the
          // voice model asked. Same gap `AgentJob.prompt` leaves.
          scenario: "",
          status: "running",
          activity: "",
          thinkers: [],
          started_at: at,
        }
      : jobs[index]!;

  // SSE promises delivery, not order. A `deep_think_activity` overtaking the
  // `deep_think_done` it precedes used to drag a finished round back to
  // "rodando", and an error followed by a done left one card holding both an
  // error and a synthesis. The transition is one-way instead.
  if (index !== -1 && TERMINAL_DEEP_THINK.has(base.status)) return jobs;

  let updated: DeepThinkJob;
  switch (event.type) {
    case "deep_think_activity":
      updated = {
        ...base,
        activity: textOf(event.activity),
        thinkers: thinkersOf(event.thinkers),
      };
      break;
    case "deep_think_done":
      updated = {
        ...base,
        status: "done",
        activity: "concluido",
        thinkers: thinkersOf(event.thinkers),
        synthesis: textOf(event.synthesis),
        cost_usd: costOf(event.cost_usd),
        finished_at: at,
      };
      break;
    case "deep_think_error":
      updated = {
        ...base,
        status: "error",
        activity: "falhou",
        error: textOf(event.error),
        finished_at: at,
      };
      break;
    default:
      return jobs;
  }

  const next = [...jobs];
  if (index === -1) {
    next.push(updated);
    if (next.length > MAX_DEEP_THINK_JOBS) {
      next.splice(0, next.length - MAX_DEEP_THINK_JOBS);
    }
  } else next[index] = updated;
  return next;
}

/** Everything the stream handler touches, so it can be driven without React. */
export interface SessionStreamDeps {
  conversationId: string;
  setJobs: (update: (previous: AgentJob[]) => AgentJob[]) => void;
  setDeepThinkJobs: (update: (previous: DeepThinkJob[]) => DeepThinkJob[]) => void;
  upsertEntry: (
    id: string,
    role: TranscriptEntry["role"],
    mutate: (previous: string) => string,
    final?: boolean,
  ) => void;
  persist: (role: "user" | "assistant" | "tool", content: string) => void;
  send: (event: object) => void;
  requestResponse: () => void;
}

/**
 * Fold one SSE payload into the session.
 *
 * Both unions land here and each one is rendered first and spoken second, with
 * `isReplay` standing between the two halves. Read it as: the screen always gets
 * the event; the model only gets the ones that just happened.
 */
export function sessionStreamHandler(deps: SessionStreamDeps): (raw: string) => void {
  // Which rounds already ended, for this connection. The fold refuses a late
  // frame on its own, but it is a pure function and cannot tell the handler it
  // refused — React runs the updater when it renders, not when it is called —
  // so the half that speaks needs the same rule written where it can read it.
  const settled = new Set<string>();

  return (raw: string) => {
    let event: SessionStreamEvent;
    try {
      event = JSON.parse(raw) as SessionStreamEvent;
    } catch {
      return;
    }
    if (!event || typeof event.type !== "string") return;

    // `backend/src/middleware/error-handler.ts` writes
    // `{"type":"error","error":"Internal server error"}` into this very stream
    // when something throws after `res.flushHeaders()`. Folded in, that frame
    // opened a card with `id: undefined` and made the assistant read an
    // English internal error out loud. An event with no job is not a job.
    if (typeof event.job_id !== "string" || event.job_id === "") return;

    if (isDeepThinkEvent(event)) handleDeepThinkEvent(event, deps, settled);
    else handleAgentJobEvent(event, deps);
  };
}

/**
 * What to say about a failure the server described in no words.
 *
 * `${event.error}` on an absent field is how "undefined" got spoken; an empty
 * string in its place only moves the problem, because "O agente falhou: " reads
 * as a sentence the server cut off mid-way.
 */
function reasonOf(value: unknown): string {
  return textOf(value).trim() || "o servidor nao disse o motivo";
}

function handleAgentJobEvent(event: AgentJobEvent, deps: SessionStreamDeps): void {
  const at = nowISO();
  deps.setJobs((previous) => applyAgentJobEvent(previous, event, deps.conversationId, at));

  if (event.type === "done") {
    // A finished agent with nothing to report leaves its card and stops there,
    // exactly like a round that concluded in silence below.
    const result = textOf(event.result);
    if (!result.trim()) return;

    deps.upsertEntry(`agent-${event.job_id}`, "agent", () => result, true);
    if (isReplay(event)) return;
    deps.persist("tool", `[agente pi] ${result}`);

    // Hand the answer back to the model as a user turn and ask it to speak.
    // This is the whole reason a slow tool does not block a conversation: the
    // result arrives late and is simply spoken late.
    deps.send(
      userTextEvent(
        "O agente de codigo terminou a investigacao. Resultado:\n\n" +
          `${result}\n\n` +
          "Explique isso para mim em voz alta, com suas palavras, de forma curta.",
      ),
    );
    deps.requestResponse();
    return;
  }

  if (event.type === "error") {
    const reason = reasonOf(event.error);
    deps.upsertEntry(
      `agent-${event.job_id}`,
      "agent",
      () => `O agente falhou: ${reason}`,
      true,
    );
    if (isReplay(event)) return;
    deps.send(
      userTextEvent(`O agente de codigo falhou: ${reason}. Me avise disso em uma frase.`),
    );
    deps.requestResponse();
  }
}

function handleDeepThinkEvent(
  event: DeepThinkEvent,
  deps: SessionStreamDeps,
  settled: Set<string>,
): void {
  // A round that already ended neither redraws its card nor speaks again.
  if (settled.has(event.job_id)) return;
  if (event.type !== "deep_think_activity") settled.add(event.job_id);

  const at = nowISO();
  deps.setDeepThinkJobs((previous) =>
    applyDeepThinkEvent(previous, event, deps.conversationId, at),
  );

  // A round in progress is a card, not a turn. The model already said out loud
  // that it dispatched the thinkers; narrating each stage would talk over the
  // conversation it was told to keep having.
  if (event.type === "deep_think_activity") return;

  if (event.type === "deep_think_done") {
    // A round that ended with nothing to say leaves the card and stops there.
    // Injecting an empty conclusion is how "undefined" got read out loud.
    const synthesis = textOf(event.synthesis);
    if (!synthesis.trim()) return;

    deps.upsertEntry(`deep-${event.job_id}`, "agent", () => synthesis, true);
    if (isReplay(event)) return;
    deps.persist("tool", `[deep think] ${synthesis}`);

    // The synthesis arrives without markdown, written to be spoken — so it is
    // handed over whole rather than summarised again.
    deps.send(
      userTextEvent(
        "A rodada de deliberacao terminou. Sintese dos pensadores:\n\n" +
          `${synthesis}\n\n` +
          "Explique isso para mim em voz alta, com suas palavras, de forma curta.",
      ),
    );
    deps.requestResponse();
    return;
  }

  const reason = reasonOf(event.error);
  deps.upsertEntry(
    `deep-${event.job_id}`,
    "agent",
    () => `A deliberacao falhou: ${reason}`,
    true,
  );
  if (isReplay(event)) return;
  deps.send(
    userTextEvent(
      `A rodada de deliberacao falhou: ${reason}. Me avise disso em uma frase.`,
    ),
  );
  deps.requestResponse();
}

// ---------------------------------------------------------------------------
// Bringing a session up
// ---------------------------------------------------------------------------

/**
 * Everything the handshake takes from the browser, so a test can lend it.
 *
 * This suite runs on plain Node — no jsdom, no `RTCPeerConnection`, no
 * `navigator.mediaDevices` — and the bug this seam exists for is precisely a
 * microphone being opened for the wrong conversation. Untestable in the hook,
 * it stayed unnoticed; behind this bridge it is three assertions.
 */
export interface BrowserBridge {
  mint: (
    id: string,
    options: { signal: AbortSignal },
  ) => Promise<RealtimeSessionToken>;
  createPeerConnection: () => RTCPeerConnection;
  /** The hidden element the model's voice plays through. */
  createAudioSink: () => HTMLAudioElement | null;
  getMicrophone: () => Promise<MediaStream>;
  /** POST the offer to OpenAI and hand back the answer SDP. */
  exchangeSdp: (offerSdp: string, token: string) => Promise<string>;
}

const BROWSER: BrowserBridge = {
  mint: (id, options) => api.createRealtimeSession(id, options),
  createPeerConnection: () => new RTCPeerConnection(),
  createAudioSink: () => {
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.style.display = "none";
    document.body.appendChild(audio);
    return audio;
  },
  getMicrophone: () =>
    navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    }),
  exchangeSdp: async (offerSdp, token) => {
    const response = await fetch(REALTIME_CALLS_URL, {
      method: "POST",
      body: offerSdp,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/sdp",
      },
    });
    if (!response.ok) {
      throw new Error(
        `A OpenAI recusou a conexao (${response.status}): ${(
          await response.text()
        ).slice(0, 200)}`,
      );
    }
    return response.text();
  },
};

/** What a finished handshake hands the hook to hold on to. */
export interface RealtimeHandles {
  token: RealtimeSessionToken;
  pc: RTCPeerConnection;
  dc: RTCDataChannel;
  stream: MediaStream;
  audio: HTMLAudioElement | null;
}

export interface OpenSessionDeps {
  conversationId: string;
  /** Aborted by `disconnect` — which is also what a conversation switch runs. */
  signal: AbortSignal;
  /** Which conversation the UI is on *now*, re-read after every await. */
  currentConversation: () => string | null;
  onServerEvent: (event: RealtimeServerEvent) => void;
  onChannelOpen: () => void;
  onConnectionLost: () => void;
  browser?: Partial<BrowserBridge>;
}

/**
 * Mint a token for one conversation and build the peer connection for it.
 *
 * Answers `null` — having given back whatever it had already taken — when the
 * attempt stopped being wanted while it was waiting. The mint alone may sit for
 * the full `REALTIME_MINT_TIMEOUT_MS`, because a conversation with memory pays
 * the summariser before the token exists; without this, switching conversation
 * inside that window let the mint resolve *after* `disconnect()` had run and
 * carry on building `getUserMedia` + `RTCPeerConnection` for the conversation
 * the user had already left. The microphone light came on for the wrong one.
 */
export async function openRealtimeSession(
  deps: OpenSessionDeps,
): Promise<RealtimeHandles | null> {
  const bridge: BrowserBridge = { ...BROWSER, ...deps.browser };
  const abandoned = (): boolean =>
    deps.signal.aborted || deps.currentConversation() !== deps.conversationId;

  const token = await bridge.mint(deps.conversationId, { signal: deps.signal });
  if (abandoned()) return null;

  const pc = bridge.createPeerConnection();
  const audio = bridge.createAudioSink();
  if (audio) {
    pc.ontrack = (event) => {
      audio.srcObject = event.streams[0] ?? null;
    };
  }

  /** Undo everything taken so far. Stopping the tracks is what kills the light. */
  const giveBack = (stream: MediaStream | null): null => {
    stream?.getTracks().forEach((track) => track.stop());
    pc.close();
    if (audio) {
      audio.srcObject = null;
      audio.remove();
    }
    return null;
  };

  // The model's voice arrives as a media track — no decoding, no buffering in
  // our code, no time-to-first-audio penalty.
  const stream = await bridge.getMicrophone();
  if (abandoned()) return giveBack(stream);

  const track = stream.getAudioTracks()[0];
  if (track) pc.addTrack(track, stream);

  const dc = pc.createDataChannel(DATA_CHANNEL_NAME);
  dc.addEventListener("message", (message: MessageEvent<string>) => {
    let parsed: RealtimeServerEvent;
    try {
      parsed = JSON.parse(message.data) as RealtimeServerEvent;
    } catch {
      return;
    }
    deps.onServerEvent(parsed);
  });
  dc.addEventListener("open", deps.onChannelOpen);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  const answer = await bridge.exchangeSdp(offer.sdp ?? "", token.value);
  if (abandoned()) return giveBack(stream);

  await pc.setRemoteDescription({ type: "answer", sdp: answer });

  pc.addEventListener("connectionstatechange", () => {
    if (pc.connectionState === "failed" || pc.connectionState === "closed") {
      deps.onConnectionLost();
    }
  });

  return { token, pc, dc, stream, audio };
}

/**
 * One live speech-to-speech session.
 *
 * Audio never touches our backend: the browser holds its own WebRTC peer
 * connection to OpenAI, so the model starts speaking while it is still
 * thinking. What *does* come back to us is every function call — those are run
 * on the server, where the filesystem and the keys live, and the result is
 * pushed into the conversation as a `function_call_output`.
 */
export function useRealtimeSession(
  conversationId: string | null,
): RealtimeSessionState {
  const [status, setStatus] = useState<SessionStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [userSpeaking, setUserSpeaking] = useState(false);
  const [assistantSpeaking, setAssistantSpeaking] = useState(false);
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [jobs, setJobs] = useState<AgentJob[]>([]);
  const [deepThinkJobs, setDeepThinkJobs] = useState<DeepThinkJob[]>([]);
  const [diagrams, setDiagrams] = useState<MermaidDiagram[]>([]);
  const [resumed, setResumed] = useState(false);
  const [memoryEvents, setMemoryEvents] = useState(0);
  const [sessionUsd, setSessionUsd] = useState(0);
  // Bumped to re-read the stored memory. Held here rather than taken as an
  // argument so the caller does not have to own a counter it never reads.
  const [memoryToken, setMemoryToken] = useState(0);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const eventsRef = useRef<EventSource | null>(null);
  // One controller per `connect` attempt, so the handshake can be called off
  // while it is still awaiting. Also stands for "an attempt exists": during the
  // mint there is no `pcRef` yet to test.
  const connectAbortRef = useRef<AbortController | null>(null);

  // The data channel handlers are installed once and live for the whole
  // session, so anything they need has to be reachable through a ref.
  const convRef = useRef<string | null>(conversationId);
  convRef.current = conversationId;

  const activeResponseRef = useRef(false);
  const wantResponseRef = useRef(false);
  // Read inside the event handler, where the state value would be a stale
  // closure capture.
  const assistantSpeakingRef = useRef(false);
  const pendingAcksRef = useRef<Set<string>>(new Set());
  const ackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const modelRef = useRef<string>("");

  // ── Sending ────────────────────────────────────────────────────

  const send = useCallback((event: object) => {
    const dc = dcRef.current;
    if (!dc || dc.readyState !== "open") return;
    dc.send(JSON.stringify(event));
  }, []);

  /**
   * Ask for a spoken response — but never while one is already running.
   *
   * Firing `response.create` on top of an active response is the classic way to
   * get "Conversation already has an active response" and lose the turn.
   */
  const requestResponse = useCallback(() => {
    if (activeResponseRef.current) {
      wantResponseRef.current = true;
      return;
    }
    send(RESPONSE_CREATE);
  }, [send]);

  const flushAcks = useCallback(() => {
    if (ackTimerRef.current) {
      clearTimeout(ackTimerRef.current);
      ackTimerRef.current = null;
    }
    pendingAcksRef.current.clear();
    requestResponse();
  }, [requestResponse]);

  // ── Transcript bookkeeping ─────────────────────────────────────

  const upsertEntry = useCallback(
    (
      id: string,
      role: TranscriptEntry["role"],
      mutate: (previous: string) => string,
      final = false,
    ) => {
      setTranscript((prev) => {
        const index = prev.findIndex((entry) => entry.id === id);
        if (index === -1) {
          return [
            ...prev,
            { id, role, text: mutate(""), final, timestamp: nowISO() },
          ];
        }
        const next = [...prev];
        const current = next[index]!;
        next[index] = { ...current, text: mutate(current.text), final };
        return next;
      });
    },
    [],
  );

  /** Persist a finished turn. A storage failure must never break the call. */
  const persist = useCallback(
    (role: "user" | "assistant" | "tool", content: string) => {
      const id = convRef.current;
      if (!id || !content.trim()) return;
      void api
        .appendMessages(id, [{ role, content }])
        .catch(() => {
          /* the conversation matters more than its archive */
        });
    },
    [],
  );

  // ── Tool bridge ────────────────────────────────────────────────

  const runToolCalls = useCallback(
    async (calls: ReturnType<typeof functionCallsFrom>) => {
      const id = convRef.current;
      if (!id || calls.length === 0) return;

      setActiveTool(calls[0]!.name);

      for (const call of calls) {
        upsertEntry(
          `tool-${call.call_id}`,
          "tool",
          () => `${call.name} — executando…`,
          false,
        );
      }

      const results = await executeToolCalls(id, calls);

      // On screen before the model starts talking about it: `output` carries
      // only the caption, so a caption without its drawing is the model
      // describing something nobody can see.
      const drawn = results
        .map((result) => result.diagram)
        .filter((diagram): diagram is MermaidDiagram => diagram !== null);
      if (drawn.length > 0) {
        setDiagrams((previous) => drawn.reduce(appendDiagram, previous));
      }

      // One synchronous pass, no `await` inside it: the first acknowledgement
      // would otherwise drain `pendingAcks` while later outputs are still
      // unsent, and `flushAcks` would ask for a response the model cannot answer.
      for (const { call, output } of results) {
        upsertEntry(
          `tool-${call.call_id}`,
          "tool",
          () => `${call.name} — ${summarize(output)}`,
          true,
        );
        pendingAcksRef.current.add(call.call_id);
        send(functionOutputEvent(call.call_id, output));
      }

      setActiveTool(null);

      // Wait for the server to confirm the outputs before asking for a
      // response; the timer is the escape hatch if an ack never shows up.
      if (ackTimerRef.current) clearTimeout(ackTimerRef.current);
      ackTimerRef.current = setTimeout(flushAcks, ACK_TIMEOUT_MS);
    },
    [flushAcks, send, upsertEntry],
  );

  // ── Server events ──────────────────────────────────────────────

  const handleEvent = useCallback(
    (event: RealtimeServerEvent) => {
      switch (event.type) {
        case "session.created":
          setStatus("live");
          break;

        case "response.created":
          activeResponseRef.current = true;
          break;

        case "response.done": {
          activeResponseRef.current = false;

          // Every response carries its own token usage. The server prices it,
          // so the meter in the sidebar is the real rate card and not a guess.
          const usage = (event.response as { usage?: unknown } | undefined)?.usage;
          const convId = convRef.current;
          if (usage && convId) {
            void api
              .reportRealtimeUsage(convId, usage, modelRef.current)
              .then((priced) => {
                if (priced) setSessionUsd((prev) => prev + priced.usd);
              });
          }

          const calls = functionCallsFrom(event);
          if (calls.length > 0) {
            void runToolCalls(calls);
            break;
          }

          if (wantResponseRef.current) {
            wantResponseRef.current = false;
            send(RESPONSE_CREATE);
          }
          break;
        }

        // ── the user's own words ──
        case "conversation.item.input_audio_transcription.delta": {
          const itemId = String(event.item_id ?? "user");
          const delta = String(event.delta ?? "");
          upsertEntry(itemId, "user", (prev) => prev + delta);
          break;
        }
        case "conversation.item.input_audio_transcription.completed": {
          const itemId = String(event.item_id ?? "user");
          const text = String(event.transcript ?? "");
          upsertEntry(itemId, "user", () => text, true);
          persist("user", text);
          break;
        }

        // ── what the model is saying ──
        case "response.output_audio_transcript.delta": {
          const itemId = String(event.item_id ?? event.response_id ?? "assistant");
          const delta = String(event.delta ?? "");
          upsertEntry(itemId, "assistant", (prev) => prev + delta);
          break;
        }
        case "response.output_audio_transcript.done": {
          const itemId = String(event.item_id ?? event.response_id ?? "assistant");
          const text = String(event.transcript ?? "");
          upsertEntry(itemId, "assistant", () => text, true);
          persist("assistant", text);
          break;
        }
        case "response.output_text.delta": {
          const itemId = String(event.item_id ?? "assistant-text");
          upsertEntry(itemId, "assistant", (prev) => prev + String(event.delta ?? ""));
          break;
        }

        // ── turn taking ──
        case "input_audio_buffer.speech_started":
          setUserSpeaking(true);
          // Barge-in: drop whatever the peer connection is still holding, so the
          // model stops mid-word instead of talking over the interruption.
          if (assistantSpeakingRef.current) send(CLEAR_OUTPUT_AUDIO);
          break;
        case "input_audio_buffer.speech_stopped":
          setUserSpeaking(false);
          break;
        case "output_audio_buffer.started":
          assistantSpeakingRef.current = true;
          setAssistantSpeaking(true);
          break;
        case "output_audio_buffer.stopped":
        case "output_audio_buffer.cleared":
          assistantSpeakingRef.current = false;
          setAssistantSpeaking(false);
          break;

        case "error": {
          const detail = event.error as { message?: string } | undefined;
          setError(detail?.message ?? "Erro na sessao de voz.");
          break;
        }

        default:
          if (ITEM_ACK_EVENTS.has(event.type)) {
            const item = event.item as { call_id?: string } | undefined;
            const callId = item?.call_id;
            if (callId && pendingAcksRef.current.delete(callId)) {
              if (pendingAcksRef.current.size === 0) flushAcks();
            }
          }
          break;
      }
    },
    [flushAcks, persist, runToolCalls, send, upsertEntry],
  );

  // ── Agent job stream ───────────────────────────────────────────

  const openJobStream = useCallback(
    (id: string) => {
      eventsRef.current?.close();
      // One EventSource for both subsystems. A second connection for
      // deliberation would let the browser end up subscribed to pi jobs and
      // unsubscribed from deep-think after a partial reconnect.
      const source = new EventSource(api.agentEventsUrl(id));
      eventsRef.current = source;

      const handle = sessionStreamHandler({
        conversationId: id,
        setJobs,
        setDeepThinkJobs,
        upsertEntry,
        persist,
        send,
        requestResponse,
      });

      source.onmessage = (message: MessageEvent<string>) => handle(message.data);

      source.onerror = () => {
        // EventSource reconnects on its own; a transient blip is not worth a toast.
      };
    },
    [persist, requestResponse, send, upsertEntry],
  );

  // ── Teardown ───────────────────────────────────────────────────

  const disconnect = useCallback(() => {
    // Call off a handshake still in flight. Switching conversation runs this
    // through the effect below, so a mint that resolves afterwards finds its
    // attempt aborted instead of opening a microphone nobody asked for.
    connectAbortRef.current?.abort();
    connectAbortRef.current = null;

    if (ackTimerRef.current) {
      clearTimeout(ackTimerRef.current);
      ackTimerRef.current = null;
    }
    pendingAcksRef.current.clear();
    activeResponseRef.current = false;
    wantResponseRef.current = false;
    assistantSpeakingRef.current = false;

    eventsRef.current?.close();
    eventsRef.current = null;

    dcRef.current?.close();
    dcRef.current = null;

    // Stopping the tracks is what actually turns the microphone light off.
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;

    pcRef.current?.close();
    pcRef.current = null;

    if (audioRef.current) {
      audioRef.current.srcObject = null;
      audioRef.current.remove();
      audioRef.current = null;
    }

    setStatus("idle");
    setUserSpeaking(false);
    setAssistantSpeaking(false);
    setActiveTool(null);
  }, []);

  /**
   * Change how fast the model speaks, mid-call.
   *
   * `speed` is playback rate, so it can move at any time — unlike `voice`, which
   * the API freezes as soon as the session has emitted a single sample.
   */
  const setSpeed = useCallback(
    (speed: number) => {
      send({
        type: "session.update",
        session: { type: "realtime", audio: { output: { speed } } },
      });
    },
    [send],
  );

  // ── Connect ────────────────────────────────────────────────────

  const connect = useCallback(async () => {
    const id = convRef.current;
    if (!id) return;
    // `pcRef` is only filled once the handshake is through, so a second press
    // during the mint is caught by the attempt, not by the peer connection.
    if (pcRef.current || connectAbortRef.current) disconnect();

    const attempt = new AbortController();
    connectAbortRef.current = attempt;

    setError(null);
    setStatus("connecting");

    try {
      const session = await openRealtimeSession({
        conversationId: id,
        signal: attempt.signal,
        currentConversation: () => convRef.current,
        onServerEvent: handleEvent,
        onChannelOpen: () => setStatus("live"),
        onConnectionLost: () =>
          setStatus((current) => (current === "live" ? "idle" : current)),
      });

      // Abandoned mid-handshake. Everything it took is already given back and
      // `disconnect` has already set the status; adopting it here is what used
      // to hand `pcRef` a session belonging to the previous conversation.
      if (!session) return;

      pcRef.current = session.pc;
      dcRef.current = session.dc;
      streamRef.current = session.stream;
      audioRef.current = session.audio;
      modelRef.current = session.token.model;
      // So the UI can say "retomando" instead of "conectado". The resume itself
      // is in the server-side instructions and never reaches the browser.
      setResumed(session.token.resumed === true);
      setMemoryEvents(session.token.memory_events ?? 0);

      openJobStream(id);
    } catch (err) {
      // A cancelled attempt is not a failure to report: the abort came from
      // the user leaving, and `disconnect` already put the UI back to idle.
      if (attempt.signal.aborted) return;

      const message =
        err instanceof Error ? err.message : "Nao foi possivel iniciar a sessao.";
      setError(
        /Permission denied|NotAllowedError/i.test(message)
          ? "Preciso do microfone para conversar. Libere o acesso e tente de novo."
          : message,
      );
      setStatus("error");
      disconnect();
    }
  }, [disconnect, handleEvent, openJobStream]);

  // ── Text input (same conversation, typed instead of spoken) ────

  const sendText = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || !dcRef.current) return;
      upsertEntry(`typed-${Date.now()}`, "user", () => trimmed, true);
      persist("user", trimmed);
      send(userTextEvent(trimmed));
      requestResponse();
    },
    [persist, requestResponse, send, upsertEntry],
  );

  const cancelJob = useCallback((jobId: string) => {
    void api.cancelAgentJob(jobId).catch(() => {});
  }, []);

  const reloadMemory = useCallback(() => setMemoryToken((token) => token + 1), []);

  // Switching conversations tears the session down; a live call belongs to the
  // conversation it was opened for.
  useEffect(() => {
    setTranscript([]);
    setJobs([]);
    setDeepThinkJobs([]);
    setDiagrams([]);
    setResumed(false);
    setMemoryEvents(0);
    setSessionUsd(0);
    return () => disconnect();
  }, [conversationId, disconnect]);

  // Bring the gallery back. Declared after the reset above so React runs it
  // second: opening a conversation empties the list and then refills it from the
  // file, rather than filling a list that is about to be emptied.
  useEffect(() => {
    if (!conversationId) return;

    let cancelled = false;
    void api
      .getMemory(conversationId)
      .then((file) => {
        // Re-read after the await: the user may have moved on, and seeding one
        // conversation's drawings into another is worse than seeding none.
        if (cancelled || convRef.current !== conversationId) return;
        const remembered = file?.diagrams;
        if (!Array.isArray(remembered) || remembered.length === 0) return;
        setDiagrams((live) => seedDiagrams(live, remembered));
      })
      .catch(() => {
        // A conversation with no memory answers `null`, not an error, so this is
        // a real failure — and one the memory panel is already reporting in
        // words. Making the transcript shout about it too would say nothing new.
      });

    return () => {
      cancelled = true;
    };
  }, [conversationId, memoryToken]);

  return {
    status,
    error,
    transcript,
    userSpeaking,
    assistantSpeaking,
    activeTool,
    jobs,
    deepThinkJobs,
    diagrams,
    resumed,
    memoryEvents,
    sessionUsd,
    connect,
    disconnect,
    sendText,
    cancelJob,
    reloadMemory,
    setSpeed,
  };
}

/** Tool output is for the model, not the sidebar — show just enough to trust it. */
function summarize(output: string): string {
  const firstLine = output.split("\n").find((line) => line.trim().length > 0) ?? "";
  return firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine;
}
