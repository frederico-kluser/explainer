import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import * as api from "@/lib/api";
import {
  browserClientId,
  browserClientName,
  entriesFromMessages,
  entryFromToolFinished,
  mergeRemoteEntries,
  parseFloorSnapshot,
  summarizeToolOutput,
} from "@/lib/conversation-stream";
import { useConversationStream } from "@/hooks/useConversationStream";
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
  WebSearchEvent,
  FloorRequest,
  FloorSnapshot,
  LiveMessage,
  LiveToolFinished,
  MermaidDiagram,
  MermaidDiagramKind,
  RealtimeSessionToken,
  SessionStreamEvent,
  ThinkerResult,
  ThinkerStatus,
  TranscriptEntry,
  WebSearchJob,
} from "@/types";

export type SessionStatus = "idle" | "connecting" | "live" | "error";

export interface RealtimeSessionState {
  status: SessionStatus;
  error: string | null;
  /**
   * Which microphone failure `error` is describing, when it is describing one.
   *
   * Lets the UI act on the reason instead of parsing the sentence: only
   * `"insecure-context"` has a link worth offering, and only `"denied"` is
   * worth a second attempt without changing anything first.
   */
  micFailure: MicrophoneFailure | null;
  /**
   * The browser will not start the model's voice until the user taps.
   *
   * iOS reaches this every time the unlock in the handshake did not take. The
   * call is up and the model is talking; nothing is coming out of the speaker
   * until `playAudio` runs inside a real gesture.
   */
  audioBlocked: boolean;
  /** Start the voice from inside the user's tap. Only useful while `audioBlocked`. */
  playAudio: () => void;
  /**
   * The call died while the tab was in the background, and was hung up.
   *
   * Reconnecting is left to the user on purpose: a new token pays the
   * summariser and is billed, so a phone waking up in a pocket must not spend.
   */
  callDropped: boolean;
  transcript: TranscriptEntry[];
  userSpeaking: boolean;
  assistantSpeaking: boolean;
  /** Name of the tool the model is waiting on right now, if any. */
  activeTool: string | null;
  jobs: AgentJob[];
  /** Deliberation rounds, newest last, for the fan of thinkers on screen. */
  deepThinkJobs: DeepThinkJob[];
  /** Background web searches, newest last, for the card under the same heading. */
  webSearchJobs: WebSearchJob[];
  /**
   * Every diagram this session drew, in order.
   *
   * The mermaid source only ever exists here: it travels in the tool result's
   * `meta`, never in `output`, because anything in `output` is read out loud.
   */
  diagrams: MermaidDiagram[];
  /**
   * The conversation's collaborative markdown, or null while it is still being
   * read. Kept here rather than in the panel because three writers reach it —
   * this browser, the model, and anybody else with the conversation open — and
   * the `/live` stream that carries the other two is owned by this hook.
   */
  documentContent: string | null;
  /** Adopt the text the server stored, after this browser saved it. */
  setDocumentContent: (content: string) => void;
  /** This session picked a previous conversation back up. */
  resumed: boolean;
  /** How many recorded events that resume was built from. */
  memoryEvents: number;
  /** What this session has spent so far, in USD, priced by the server. */
  sessionUsd: number;
  /**
   * How many people have this conversation open, this browser included.
   *
   * Counted from `/live` connections, which every open conversation holds —
   * so a spectator who never connects a session still shows up here.
   */
  viewers: number;
  /** Who holds the microphone on this conversation, or nobody. */
  floor: FloorSnapshot | null;
  /** Whether that is us. False while spectating, and false before connecting. */
  isFloorHolder: boolean;
  /** The last viewer who asked the holder for the microphone, or nobody. */
  floorRequest: FloorRequest | null;
  /** Ask the holder to hand it over. Posts a card on their screen; takes nothing. */
  requestFloor: () => void;
  /** Answer that request: hang up and let go, so the asker can take it. */
  grantFloor: () => void;
  /** Let go of the microphone without waiting for the grace window. */
  releaseFloor: () => void;
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

/**
 * The batch-wide failure fallback: every call becomes a spoken failure output.
 *
 * `executeToolCalls` already converts a per-call rejection into an output, so
 * reaching this means the batch itself died — a bug, or a future flow. Each
 * call still needs an answer or the turn stays open on outputs that never
 * come, so the model hears one generic sentence per call and can propose a
 * retry.
 */
export function failedToolOutcomes(
  calls: readonly RealtimeFunctionCall[],
): ToolCallOutcome[] {
  const output =
    "A ferramenta falhou por demora ou erro de conexao. Avise o usuario e proponha tentar de novo.";
  return calls.map((call) => ({ call, output, diagram: null }));
}

/** Everything the outcome fold touches, so it can be driven without React. */
export interface ToolOutcomeDeps {
  upsertEntry: (
    id: string,
    role: TranscriptEntry["role"],
    mutate: (previous: string) => string,
    final?: boolean,
  ) => void;
  setDiagrams: (update: (previous: MermaidDiagram[]) => MermaidDiagram[]) => void;
  /** Register the call_id the server must acknowledge before we ask for a response. */
  addPendingAck: (callId: string) => void;
  send: (event: object) => void;
  setActiveTool: (name: string | null) => void;
  /** Arm the escape hatch that closes the turn when an ack never arrives. */
  armAckTimer: () => void;
}

/**
 * Emit tool outcomes and close the turn.
 *
 * The ack-ordering invariant lives here: each `call_id` joins `pendingAcks`
 * before its `function_call_output` is sent, all in one synchronous pass. An
 * `await` inside the loop would let the first acknowledgement drain the pending
 * set to zero while later outputs are still unsent, and `flushAcks` would then
 * ask for a response the model cannot yet answer. The `finally` guarantees the
 * turn closes even when the loop throws mid-way: the spinner goes away and the
 * ack timer still fires, so the conversation never stays stuck on a tool.
 */
export function foldToolOutcomes(
  deps: ToolOutcomeDeps,
  results: readonly ToolCallOutcome[],
): void {
  try {
    // On screen before the model starts talking about it: `output` carries
    // only the caption, so a caption without its drawing is the model
    // describing something nobody can see.
    const drawn = results
      .map((result) => result.diagram)
      .filter((diagram): diagram is MermaidDiagram => diagram !== null);
    if (drawn.length > 0) {
      deps.setDiagrams((previous) => drawn.reduce(appendDiagram, previous));
    }

    for (const { call, output } of results) {
      deps.upsertEntry(
        `tool-${call.call_id}`,
        "tool",
        () => `${call.name} — ${summarizeToolOutput(output)}`,
        true,
      );
      deps.addPendingAck(call.call_id);
      deps.send(functionOutputEvent(call.call_id, output));
    }
  } finally {
    deps.setActiveTool(null);
    deps.armAckTimer();
  }
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
 * Which half of the stream a web-search event belongs to.
 *
 * Sibling of `isDeepThinkEvent`, for the same reason: a `web_search_*` event
 * must never reach the agent-job fold, where its unknown `type` would fall
 * through into the error branch and invent a phantom pi card.
 */
export function isWebSearchEvent(event: SessionStreamEvent): event is WebSearchEvent {
  return (
    event.type === "web_search_activity" ||
    event.type === "web_search_done" ||
    event.type === "web_search_error"
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
  return event.type !== "activity" && event.type !== "deep_think_activity" && event.type !== "web_search_activity"
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

/** A search in one of these has already ended, and it ends exactly once. */
const TERMINAL_WEB_SEARCH: ReadonlySet<WebSearchJob["status"]> = new Set<
  WebSearchJob["status"]
>(["done", "error", "cancelled"]);

export function applyWebSearchEvent(
  jobs: WebSearchJob[],
  event: WebSearchEvent,
  conversationId: string,
  at: string,
): WebSearchJob[] {
  const index = jobs.findIndex((job) => job.id === event.job_id);
  const base: WebSearchJob =
    index === -1
      ? {
          id: event.job_id,
          conversation_id: conversationId,
          // The stream never carries the query — only the server saw it. Same
          // gap `AgentJob.prompt` and `DeepThinkJob.scenario` leave.
          query: "",
          status: "running",
          activity: "",
          started_at: at,
        }
      : jobs[index]!;

  // The same one-way transition the other two folds make, for the same reason:
  // SSE promises delivery, not order. A late `web_search_activity` used to drag
  // a finished search back to "pesquisando", and an error followed by a done
  // left one card holding both.
  if (index !== -1 && TERMINAL_WEB_SEARCH.has(base.status)) return jobs;

  let updated: WebSearchJob;
  switch (event.type) {
    case "web_search_activity":
      updated = { ...base, activity: textOf(event.activity) };
      break;
    case "web_search_done":
      updated = {
        ...base,
        status: "done",
        activity: "concluido",
        result: textOf(event.result),
        cost_usd: costOf(event.cost_usd),
        finished_at: at,
      };
      break;
    case "web_search_error":
      updated = {
        ...base,
        status: "error",
        activity: "falhou",
        error: textOf(event.error),
        finished_at: at,
      };
      break;
    default:
      // An event this client does not know is not a failed search. Ignoring it
      // costs a card; folding it in invents one.
      return jobs;
  }

  const next = [...jobs];
  if (index === -1) next.push(updated);
  else next[index] = updated;
  return next;
}

// ---------------------------------------------------------------------------
// Archiving a turn
// ---------------------------------------------------------------------------

/**
 * Archive one finished turn under the id this screen already draws it with.
 *
 * The id is the whole point of this function existing. `POST /:id/messages`
 * mints a fresh `uuidv4()` for any message that arrives without one —
 * `backend/src/routes/conversations.ts` — and that message comes straight back
 * out on the `/live` stream. A turn persisted anonymously therefore returns
 * under an id this transcript has never seen and lands a second time, directly
 * beneath itself, on the screen that just said it. Sending our own id makes the
 * echo a no-op here (`mergeRemoteEntries` already has that id) and a new line on
 * every other screen, which is exactly the asymmetry the feature needs.
 *
 * `append` is injectable for the same reason `executeToolCalls` takes `runTool`:
 * there is no jsdom in this suite, so the only way to assert what gets posted is
 * to lend the caller a spy.
 */
export function persistTurn(
  conversationId: string,
  id: string,
  role: "user" | "assistant" | "tool",
  content: string,
  append: typeof api.appendMessages = api.appendMessages,
): void {
  if (!content.trim()) return;
  void append(conversationId, [{ id, role, content }]).catch(() => {
    /* the conversation matters more than its archive */
  });
}

/**
 * The conversation's archived turns, as transcript lines.
 *
 * The read `history.reset` demands, and the read a first `/live` connection
 * assumes has already happened — the server replays nothing for `since <= 0`
 * exactly because the client is expected to have made it. Injectable for the
 * same reason `persistTurn`'s `append` is: no jsdom, so the effect that calls
 * this cannot be rendered, and this is the seam where the chain can be asserted.
 */
export async function fetchArchivedTranscript(
  conversationId: string,
  at: string,
  get: typeof api.getConversation = api.getConversation,
): Promise<TranscriptEntry[]> {
  const conversation = await get(conversationId);
  const stored = conversation.messages;
  return Array.isArray(stored) ? entriesFromMessages(stored, at) : [];
}

/** Everything the stream handler touches, so it can be driven without React. */
export interface SessionStreamDeps {
  conversationId: string;
  setJobs: (update: (previous: AgentJob[]) => AgentJob[]) => void;
  setDeepThinkJobs: (update: (previous: DeepThinkJob[]) => DeepThinkJob[]) => void;
  setWebSearchJobs: (update: (previous: WebSearchJob[]) => WebSearchJob[]) => void;
  upsertEntry: (
    id: string,
    role: TranscriptEntry["role"],
    mutate: (previous: string) => string,
    final?: boolean,
  ) => void;
  /** The id comes first because it is the same id `upsertEntry` was just given. */
  persist: (
    id: string,
    role: "user" | "assistant" | "tool",
    content: string,
  ) => void;
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
    else if (isWebSearchEvent(event)) handleWebSearchEvent(event, deps, settled);
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
    deps.persist(`agent-${event.job_id}`, "tool", `[agente pi] ${result}`);

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
    deps.persist(`deep-${event.job_id}`, "tool", `[deep think] ${synthesis}`);

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

function handleWebSearchEvent(
  event: WebSearchEvent,
  deps: SessionStreamDeps,
  settled: Set<string>,
): void {
  // A search that already ended neither redraws its card nor speaks again.
  if (settled.has(event.job_id)) return;
  if (event.type !== "web_search_activity") settled.add(event.job_id);

  const at = nowISO();
  deps.setWebSearchJobs((previous) =>
    applyWebSearchEvent(previous, event, deps.conversationId, at),
  );

  // A search in progress is a card, not a turn. The model already said out loud
  // that it was going to look things up; narrating each stage would talk over
  // the conversation it was told to keep having.
  if (event.type === "web_search_activity") return;

  if (event.type === "web_search_done") {
    // A search that ended with nothing to report leaves the card and stops
    // there. Injecting an empty result is how "undefined" got read out loud.
    const result = textOf(event.result);
    if (!result.trim()) return;

    deps.upsertEntry(`web-${event.job_id}`, "agent", () => result, true);
    if (isReplay(event)) return;
    // The `[busca web]` marker is what the research context of later searches
    // reads back — without it, the context the user asked for stays blind to
    // every search that already ran in this conversation.
    deps.persist(`web-${event.job_id}`, "tool", `[busca web] ${result}`);

    // The result arrives ready to speak, so it is handed over whole rather
    // than summarised again.
    deps.send(
      userTextEvent(
        "A busca web terminou. Resultado:\n\n" +
          `${result}\n\n` +
          "Explique isso para mim em voz alta, com suas palavras, de forma curta.",
      ),
    );
    deps.requestResponse();
    return;
  }

  const reason = reasonOf(event.error);
  deps.upsertEntry(
    `web-${event.job_id}`,
    "agent",
    () => `A busca web falhou: ${reason}`,
    true,
  );
  if (isReplay(event)) return;
  deps.send(
    userTextEvent(`A busca web falhou: ${reason}. Me avise disso em uma frase.`),
  );
  deps.requestResponse();
}

// ---------------------------------------------------------------------------
// A microphone the browser will not hand over
// ---------------------------------------------------------------------------

/**
 * Where the certificate that makes a LAN address secure is served from.
 *
 * Exported so the UI can draw a link instead of a sentence with a path buried
 * in it: on a phone, a path the user has to retype is a path nobody follows.
 */
export const CERTIFICATE_URL = "/rootCA.pem";

/**
 * Which way the microphone is unavailable.
 *
 * The UI branches on this, never on the message — the wording is copy and will
 * be rewritten; the reason a tap can or cannot fix it will not.
 */
export type MicrophoneFailure =
  | "insecure-context"
  | "unsupported"
  | "denied"
  | "not-found"
  | "busy"
  | "aborted";

export interface MicrophoneProblem {
  failure: MicrophoneFailure;
  /** What to do about it. Naming the exception tells the user nothing they can act on. */
  message: string;
}

const MICROPHONE_MESSAGES: Record<MicrophoneFailure, string> = {
  "insecure-context":
    "Este endereço não é seguro, então o navegador não libera o microfone. " +
    `Instale o certificado do Explainer, em ${CERTIFICATE_URL}, e abra a página de novo. ` +
    "No iPhone, depois de instalar, ligue também o certificado em Ajustes > Geral > " +
    "Sobre > Ajustes de Confiança do Certificado.",
  unsupported:
    "Este navegador não entrega o microfone para a página. No iPhone, abra o Explainer " +
    "no Safari, e não pelo ícone da tela de início nem por um link dentro de outro " +
    "aplicativo.",
  denied:
    "Preciso do microfone para conversar. Libere o microfone para este endereço nas " +
    "configurações do navegador e toque em conectar de novo.",
  "not-found":
    "Não encontrei nenhum microfone neste aparelho. Conecte um e toque em conectar de novo.",
  busy:
    "O microfone está ocupado por outro aplicativo. Encerre a chamada ou a gravação que " +
    "está usando ele e toque em conectar de novo.",
  aborted:
    "O navegador não conseguiu abrir o microfone. Toque em conectar de novo; se insistir, " +
    "feche e abra o navegador.",
};

function microphoneProblem(failure: MicrophoneFailure): MicrophoneProblem {
  return { failure, message: MICROPHONE_MESSAGES[failure] };
}

/**
 * Whether this page can ask for a microphone at all — checked before it asks.
 *
 * `getUserMedia` is gated on a secure context, and a LAN address is not one:
 * the potentially-trustworthy set is `https`, `localhost`, `127.0.0.0/8`, `::1`
 * and `file`, so `http://192.168.1.20:5173` is on none of it. In an insecure
 * context `navigator.mediaDevices` is not a method that refuses — it is
 * `undefined`, so the handshake reached into it and threw
 * `undefined is not an object`, which is what the phone showed the user: a raw
 * TypeError, in English, about a property.
 *
 * The two answers are kept apart because the remedy is not the same. An
 * insecure address needs the certificate. A *secure* page with no
 * `mediaDevices` is WebKit withholding capture outside Safari proper — a
 * home-screen web app or an in-app browser (WebKit #180551) — and sending that
 * user to install a certificate points them at a problem they do not have.
 */
export function microphoneBlock(env: {
  /** `window.isSecureContext`. */
  secureContext: boolean;
  /** `navigator.mediaDevices`. Typed loose because its being absent is the point. */
  mediaDevices: unknown;
}): MicrophoneProblem | null {
  if (!env.secureContext) return microphoneProblem("insecure-context");
  if (!env.mediaDevices) return microphoneProblem("unsupported");
  return null;
}

/**
 * The two globals `microphoneBlock` judges, read in one place.
 *
 * A seam, not a wrapper: without it the only code that touches
 * `navigator.mediaDevices` sits inside a React hook this suite cannot render,
 * so the half that decides would be tested and the half that looks would not —
 * and looking in the wrong place is precisely how the crash shipped.
 */
export function currentMicrophoneEnvironment(): {
  secureContext: boolean;
  mediaDevices: unknown;
} {
  return {
    secureContext: window.isSecureContext,
    mediaDevices: navigator.mediaDevices,
  };
}

/**
 * The names `getUserMedia` rejects with, plus the aliases older engines kept.
 *
 * `SecurityError` sits with the denials: it means media capture is switched off
 * for this document, which the user resolves in the same place as a refusal.
 */
const MICROPHONE_ERROR_NAMES: Record<string, MicrophoneFailure> = {
  NotAllowedError: "denied",
  PermissionDeniedError: "denied",
  SecurityError: "denied",
  NotFoundError: "not-found",
  DevicesNotFoundError: "not-found",
  NotReadableError: "busy",
  TrackStartError: "busy",
  AbortError: "aborted",
};

/**
 * Turn whatever the handshake threw into something the user can act on.
 *
 * Answers `null` when the failure was not the microphone's — the mint and the
 * SDP exchange reject through the same `catch`, and their messages already say
 * what they are about.
 *
 * The match is on `err.name`, not on `err.message`. The message is written by
 * the engine: Chrome says "Permission denied", other engines phrase the same
 * refusal as a sentence containing neither that phrase nor the exception's
 * name, so the message test this replaces recognised a denial in one browser
 * and printed the raw English of the others.
 */
export function classifyMicrophoneError(err: unknown): MicrophoneProblem | null {
  // The only `TypeError` reachable here is `navigator.mediaDevices` being
  // absent: the constraints are a constant with `audio` set, so the "every
  // constraint is false" TypeError that `getUserMedia` also defines cannot
  // happen. Without this branch that crash arrived on screen verbatim.
  if (err instanceof TypeError) return microphoneProblem("unsupported");

  const name = err instanceof Error ? err.name : "";
  const known = MICROPHONE_ERROR_NAMES[name];
  if (known) return microphoneProblem(known);

  const message = err instanceof Error ? err.message : String(err);
  return /permission denied/i.test(message) ? microphoneProblem("denied") : null;
}

/**
 * Whether the call the tab just came back to is still there.
 *
 * `openRealtimeSession` only reacts to `failed` and `closed`. A peer connection
 * the OS froze while the phone slept comes back as `disconnected`, which
 * nothing was watching — so the hook still said "live" and the button still
 * said connected over a call with no other end.
 *
 * Anything short of `connected` counts as gone, `connecting` included: after a
 * nap that is ICE trying to rebuild a session whose ephemeral token has most
 * likely already expired. A live status with no peer connection counts as gone
 * for the same reason — from the user's side it is the same silence.
 *
 * Reconnecting is deliberately not this function's business, nor the caller's:
 * a fresh token runs the summariser and is billed, and a phone coming out of a
 * pocket asked for neither.
 */
export function callDroppedWhileHidden(
  status: SessionStatus,
  connectionState: RTCPeerConnectionState | null,
): boolean {
  return status === "live" && connectionState !== "connected";
}

/**
 * The holder named by a refusal, when the refusal was about the microphone.
 *
 * `POST /api/realtime/session` answers 409 twice over: once because somebody
 * else is speaking, once because the conversation has no materials. Only the
 * first carries a `floor`, and only the first is a state rather than an error —
 * so the snapshot's presence is the discriminator, not the status code.
 */
export function floorFromRefusal(err: unknown): FloorSnapshot | null {
  if (!(err instanceof api.ApiError) || err.status !== 409) return null;
  const body = err.body as { floor?: unknown } | null;
  return parseFloorSnapshot(body?.floor);
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
    options: { signal: AbortSignal; clientId?: string; clientName?: string },
  ) => Promise<RealtimeSessionToken>;
  createPeerConnection: () => RTCPeerConnection;
  /** The hidden element the model's voice plays through. */
  createAudioSink: () => HTMLAudioElement | null;
  getMicrophone: () => Promise<MediaStream>;
  /** POST the offer to OpenAI and hand back the answer SDP. */
  exchangeSdp: (offerSdp: string, token: string) => Promise<string>;
}

const BROWSER: BrowserBridge = {
  mint: (id, options) =>
    api.createRealtimeSession(id, {
      signal: options.signal,
      ...(options.clientId ? { clientId: options.clientId } : {}),
      ...(options.clientName ? { clientName: options.clientName } : {}),
    }),
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
  /**
   * Who is asking, so the mint can enforce one microphone per conversation.
   *
   * Optional because the handshake works without it — and because every test
   * that predates the floor calls this function without one.
   */
  clientId?: string;
  clientName?: string;
  /** Aborted by `disconnect` — which is also what a conversation switch runs. */
  signal: AbortSignal;
  /** Which conversation the UI is on *now*, re-read after every await. */
  currentConversation: () => string | null;
  onServerEvent: (event: RealtimeServerEvent) => void;
  onChannelOpen: () => void;
  onConnectionLost: () => void;
  /**
   * The browser would not start the model's voice, and only a tap will.
   *
   * Optional because it is the UI's problem, not the handshake's: a caller that
   * has nowhere to put a "tocar áudio" button is better off silent than
   * throwing.
   */
  onAudioBlocked?: () => void;
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

  // Built and started here, ahead of every await, so it is still inside the
  // click that asked for the call: this function is invoked — not awaited —
  // straight out of the button handler, so everything down to the mint runs in
  // the gesture's own task. WebKit only honours a `play()` made there; Apple's
  // own guidance names the delay of an async step ahead of `play()` as exactly
  // why the element stops recognising the gesture. The mint can sit for its
  // full timeout while a conversation with memory is summarised, so an element
  // created after it is an element iOS will never let speak, and the model
  // connects, talks, and is heard by nobody.
  //
  // There is no source on it yet, so this first `play()` rejects. It is called
  // for the permission the call carries, not for the playback.
  const audio = bridge.createAudioSink();
  if (audio) void audio.play().catch(() => {});

  /**
   * Take the element back out of the page.
   *
   * Owned out here rather than inside the handshake because it is now created
   * before the handshake's first await, so every exit that is not a live
   * session has to undo it — including a mint or an SDP exchange that *throws*,
   * which no `giveBack` inside runs for. One hidden `<audio>` per failed press
   * otherwise accumulates for the life of the tab.
   */
  const releaseAudio = (): void => {
    if (!audio) return;
    audio.srcObject = null;
    audio.remove();
  };

  try {
    const handles = await handshake(deps, bridge, audio);
    if (!handles) releaseAudio();
    return handles;
  } catch (err) {
    releaseAudio();
    throw err;
  }
}

/**
 * Everything after the audio element: token, peer connection, microphone, SDP.
 *
 * Split out only so the element above it can outlive each of these steps' ways
 * of ending. `signal.aborted || currentConversation() !== conversationId` is
 * re-read after every await here, and each `null` it returns has already handed
 * back what it took by then.
 */
async function handshake(
  deps: OpenSessionDeps,
  bridge: BrowserBridge,
  audio: HTMLAudioElement | null,
): Promise<RealtimeHandles | null> {
  const abandoned = (): boolean =>
    deps.signal.aborted || deps.currentConversation() !== deps.conversationId;

  const token = await bridge.mint(deps.conversationId, {
    signal: deps.signal,
    ...(deps.clientId ? { clientId: deps.clientId } : {}),
    ...(deps.clientName ? { clientName: deps.clientName } : {}),
  });
  if (abandoned()) return null;

  const pc = bridge.createPeerConnection();
  if (audio) {
    pc.ontrack = (event) => {
      audio.srcObject = event.streams[0] ?? null;
      // `autoplay` does not restart an element that already ran its load
      // algorithm against nothing, so the track needs an explicit `play()`. And
      // if the unlock above did not take, this rejection is the only notice the
      // page gets that the model is speaking into a muted phone — the UI turns
      // it into a button, because at this point only a tap can help.
      void audio.play().catch(() => deps.onAudioBlocked?.());
    };
  }

  /** Undo everything taken so far. Stopping the tracks is what kills the light. */
  const giveBack = (stream: MediaStream | null): null => {
    stream?.getTracks().forEach((track) => track.stop());
    pc.close();
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
  const [micFailure, setMicFailure] = useState<MicrophoneFailure | null>(null);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [callDropped, setCallDropped] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [userSpeaking, setUserSpeaking] = useState(false);
  const [assistantSpeaking, setAssistantSpeaking] = useState(false);
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [jobs, setJobs] = useState<AgentJob[]>([]);
  const [deepThinkJobs, setDeepThinkJobs] = useState<DeepThinkJob[]>([]);
  const [webSearchJobs, setWebSearchJobs] = useState<WebSearchJob[]>([]);
  const [diagrams, setDiagrams] = useState<MermaidDiagram[]>([]);
  /**
   * The conversation's markdown, as the server last knew it.
   *
   * `null` means "not read yet" and `""` means "read, and empty" — the panel
   * shows its empty state for both, but only the second one is safe to save
   * over, so the two are not collapsed.
   */
  const [documentContent, setDocumentContent] = useState<string | null>(null);
  const [resumed, setResumed] = useState(false);
  const [memoryEvents, setMemoryEvents] = useState(0);
  const [sessionUsd, setSessionUsd] = useState(0);
  // Bumped to re-read the stored memory. Held here rather than taken as an
  // argument so the caller does not have to own a counter it never reads.
  const [memoryToken, setMemoryToken] = useState(0);
  // Same idea, for the archived transcript. `history.reset` bumps it: the live
  // stream has told us its replay buffer cannot cover our gap, so the only way
  // back to a complete transcript is to read the conversation again.
  const [historyToken, setHistoryToken] = useState(0);

  /**
   * Who this browser is, for the whole life of the tab.
   *
   * The floor is held by a browser, not by a session — the holder's `/live`
   * stream is the heartbeat behind it — so this has to outlive every connect,
   * disconnect and conversation switch.
   */
  const clientId = useMemo(() => browserClientId(), []);

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
  /**
   * The conversation this browser currently holds the microphone on.
   *
   * The id and not a boolean, because the release has to name the conversation
   * the floor was taken on — and the moment it matters most is a conversation
   * switch, when `conversationId` has already moved on.
   */
  const heldFloorRef = useRef<string | null>(null);

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

  /**
   * Persist a finished turn under the id the transcript already knows it by.
   *
   * A storage failure must never break the call, and the id must never be left
   * to the server — see `persistTurn`.
   */
  const persist = useCallback(
    (id: string, role: "user" | "assistant" | "tool", content: string) => {
      const conversationId = convRef.current;
      if (!conversationId) return;
      persistTurn(conversationId, id, role, content);
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

      // `executeToolCalls` turns a per-call rejection into a spoken output, so
      // a rejection here means the batch itself died. Either way every call
      // gets an answer and the turn closes — the conversation must not stay
      // stuck waiting on a `function_call_output` that never comes.
      let results: ToolCallOutcome[];
      try {
        results = await executeToolCalls(id, calls);
      } catch {
        results = failedToolOutcomes(calls);
      }

      foldToolOutcomes(
        {
          upsertEntry,
          setDiagrams,
          addPendingAck: (callId) => {
            pendingAcksRef.current.add(callId);
          },
          send,
          setActiveTool,
          // Wait for the server to confirm the outputs before asking for a
          // response; the timer is the escape hatch if an ack never shows up.
          armAckTimer: () => {
            if (ackTimerRef.current) clearTimeout(ackTimerRef.current);
            ackTimerRef.current = setTimeout(flushAcks, ACK_TIMEOUT_MS);
          },
        },
        results,
      );
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
          persist(itemId, "user", text);
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
          persist(itemId, "assistant", text);
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
        setWebSearchJobs,
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

  /**
   * Give the microphone back, if this browser is holding one.
   *
   * Separate from `teardown` and deliberately not part of it. `connect()` tears
   * a half-built attempt down before starting a new one, and a release fired
   * there would be a `DELETE` racing the `POST` that claims the floor two lines
   * later — the release landing second takes away the microphone this client
   * just won. So only the ways of *stopping* release: `disconnect`, and the
   * conversation switch that runs it.
   */
  const handBackFloor = useCallback(() => {
    const held = heldFloorRef.current;
    if (!held) return;
    heldFloorRef.current = null;
    void api.releaseFloor(held, clientId).catch(() => {
      // The grace window behind the `/live` stream releases it anyway, a few
      // seconds later. Nothing here is worth a message to the user.
    });
  }, [clientId]);

  const teardown = useCallback(() => {
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
    // Both describe a call that no longer exists. The caller that hangs up
    // because the call already died sets `callDropped` again straight after.
    setAudioBlocked(false);
    setCallDropped(false);
  }, []);

  /**
   * Hang up, and let the next person speak.
   *
   * The floor would eventually free itself — the server starts a grace window
   * when the holder's last `/live` stream closes — but hanging up does not close
   * that stream: this browser is still watching the conversation, so without
   * this the microphone would stay locked to a session that no longer exists.
   */
  const disconnect = useCallback(() => {
    teardown();
    handBackFloor();
  }, [handBackFloor, teardown]);

  /**
   * Start the model's voice from inside the user's tap.
   *
   * The element is still holding the model's track — nothing was torn down, the
   * browser only refused to begin. So this is the same `play()` the handshake
   * already tried, made somewhere WebKit accepts it.
   */
  const playAudio = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    void audio.play().then(
      () => setAudioBlocked(false),
      () => {
        /* still refused: the button stays, because it is all the user has */
      },
    );
  }, []);

  /**
   * Notice a call that died while the phone was asleep.
   *
   * Re-registered on every status change rather than reading a ref: there is no
   * `react-hooks` lint here, and a handler installed once would compare against
   * whatever `status` was when the session opened.
   */
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      const state = pcRef.current?.connectionState ?? null;
      if (!callDroppedWhileHidden(status, state)) return;
      disconnect();
      setCallDropped(true);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [disconnect, status]);

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

  const reloadMemory = useCallback(() => setMemoryToken((token) => token + 1), []);

  // ── The shared conversation ────────────────────────────────────
  //
  // Every handler below only ever writes to the screen. None of them calls
  // `send` or `requestResponse`, and `LiveStreamDeps` gives them no way to: a
  // `message.appended` folded back into the session as an injected turn would
  // make the assistant narrate the sentence it has just finished saying.
  // `conversation-stream.test.ts` asserts both halves of that — the identifiers
  // are absent from the source, and the calls stay untouched when every event
  // type is driven through the handler.

  const applyLiveMessages = useCallback((messages: LiveMessage[]) => {
    const at = nowISO();
    setTranscript((live) => mergeRemoteEntries(live, entriesFromMessages(messages, at)));
  }, []);

  const applyLiveTool = useCallback((event: LiveToolFinished) => {
    const at = nowISO();
    const entry = entryFromToolFinished(event, at);
    if (entry) setTranscript((live) => mergeRemoteEntries(live, [entry]));

    // The drawing travels in `meta`, never in `output`, because `output` is read
    // out loud. `appendDiagram` keys on the diagram's own id, so the screen that
    // made the call folds its own echo onto the picture already there.
    const diagram = diagramFromMeta(event.meta);
    if (diagram) setDiagrams((previous) => appendDiagram(previous, diagram));
  }, []);

  const applyLiveDocument = useCallback((content: string) => {
    setDocumentContent(content);
  }, []);

  const reloadHistory = useCallback(() => setHistoryToken((token) => token + 1), []);

  const { viewers, floor, floorRequest, noteFloor } = useConversationStream(
    conversationId,
    clientId,
    {
      onMessages: applyLiveMessages,
      onToolFinished: applyLiveTool,
      // The count is not adopted as `memoryEvents` — that number describes what a
      // resume was built from, and overwriting it would make the "retomando"
      // line report the present. What a change means here is that the file the
      // gallery is seeded from moved, so the gallery re-reads it.
      onMemoryChanged: reloadMemory,
      // Adopted from every source, this browser's own save included. The panel
      // is what decides whether to overwrite the textarea — it will not, while
      // the caret is in it — so dropping the echo here would only make a second
      // screen's edits arrive and this one's not.
      onDocumentChanged: applyLiveDocument,
      onReset: reloadHistory,
    },
  );

  const isFloorHolder = floor?.client_id === clientId;

  // ── The microphone, as three buttons ───────────────────────────

  const requestFloor = useCallback(() => {
    const id = convRef.current;
    if (!id) return;
    void api.requestFloor(id, clientId, browserClientName()).catch(() => {
      // A 409 here means nobody holds it — the answer to which is to connect,
      // which is the button next to this one.
    });
  }, [clientId]);

  const releaseFloor = useCallback(() => disconnect(), [disconnect]);

  /**
   * Answer somebody who asked for the microphone.
   *
   * The same act as releasing it, and that is not an oversight: the server has
   * no forced hand-over, on purpose — cutting a holder off mid-sentence is worse
   * than waiting. Granting is letting go, and the client that asked takes it by
   * connecting. Kept as its own name because the button that calls it says
   * "passar o microfone" and reads nothing like "desconectar".
   */
  const grantFloor = useCallback(() => disconnect(), [disconnect]);

  // ── Connect ────────────────────────────────────────────────────

  const connect = useCallback(async () => {
    const id = convRef.current;
    if (!id) return;

    // Asked before anything is torn down or minted, because in an insecure
    // context there is no `navigator.mediaDevices` for the handshake to fail
    // against — it reached into `undefined` and the phone showed a TypeError.
    // Reporting it here also keeps `status` off "connecting": nothing is
    // connecting, and a button spinning for a session that was never going to
    // start is the same lie in a different shape.
    const blocked = microphoneBlock(currentMicrophoneEnvironment());
    if (blocked) {
      setError(blocked.message);
      setMicFailure(blocked.failure);
      setStatus("error");
      return;
    }

    // `pcRef` is only filled once the handshake is through, so a second press
    // during the mint is caught by the attempt, not by the peer connection.
    //
    // `teardown` and not `disconnect`: this is the start of a connect, and the
    // floor released here would be the one the mint below is about to claim.
    if (pcRef.current || connectAbortRef.current) teardown();

    const attempt = new AbortController();
    connectAbortRef.current = attempt;

    setError(null);
    setMicFailure(null);
    setAudioBlocked(false);
    setCallDropped(false);
    setStatus("connecting");

    // Recorded before the mint rather than after it. The mint *is* the claim, so
    // between it succeeding and the SDP exchange failing there is a window where
    // the server holds a floor for this client that nothing here knows about —
    // and nothing would ever release, because the grace window only starts when
    // the `/live` stream closes and this browser is still watching. Releasing a
    // floor we turn out not to hold is a no-op server-side, so the pessimistic
    // order is the safe one.
    heldFloorRef.current = id;

    try {
      const session = await openRealtimeSession({
        conversationId: id,
        clientId,
        clientName: browserClientName(),
        signal: attempt.signal,
        currentConversation: () => convRef.current,
        onServerEvent: handleEvent,
        onChannelOpen: () => setStatus("live"),
        onConnectionLost: () =>
          setStatus((current) => (current === "live" ? "idle" : current)),
        onAudioBlocked: () => setAudioBlocked(true),
      });

      // Abandoned mid-handshake. Everything it took is already given back and
      // `disconnect` has already set the status; adopting it here is what used
      // to hand `pcRef` a session belonging to the previous conversation.
      if (!session) {
        handBackFloor();
        return;
      }

      pcRef.current = session.pc;
      dcRef.current = session.dc;
      streamRef.current = session.stream;
      audioRef.current = session.audio;
      modelRef.current = session.token.model;
      // So the UI can say "retomando" instead of "conectado". The resume itself
      // is in the server-side instructions and never reaches the browser.
      setResumed(session.token.resumed === true);
      setMemoryEvents(session.token.memory_events ?? 0);

      // Who the server says ended up with it, which settles the pessimistic
      // guess above. A 200 with somebody else's floor is not reachable today —
      // the mint refuses with 409 instead — but believing we hold a microphone
      // we do not is the one error worth spending a branch on.
      const granted = parseFloorSnapshot(session.token.floor);
      noteFloor(granted);
      heldFloorRef.current = granted?.client_id === clientId ? id : null;

      openJobStream(id);
    } catch (err) {
      // A cancelled attempt is not a failure to report: the abort came from
      // the user leaving, and `disconnect` already put the UI back to idle.
      if (attempt.signal.aborted) {
        handBackFloor();
        return;
      }

      // Somebody else is talking. That is a state, not a failure: the server
      // refuses with 409 and names the holder in Portuguese, and the snapshot in
      // the body is what lets the UI offer "pedir o microfone" instead of
      // "tentar de novo". Only the floor 409 carries a `floor` — the mint's
      // other 409, for a conversation with no materials, does not, and that one
      // really is an error.
      const taken = floorFromRefusal(err);
      if (taken) {
        heldFloorRef.current = null;
        noteFloor(taken);
        setError(err instanceof Error ? err.message : "O microfone está ocupado.");
        setMicFailure(null);
        teardown();
        return;
      }

      // A microphone failure gets a sentence about what to do next; anything
      // else — the mint, the SDP exchange — already says what it is about.
      const problem = classifyMicrophoneError(err);
      setMicFailure(problem?.failure ?? null);
      setError(
        problem?.message ??
          (err instanceof Error
            ? err.message
            : "Não foi possível iniciar a sessão."),
      );
      setStatus("error");
      disconnect();
    }
  }, [
    clientId,
    disconnect,
    handBackFloor,
    handleEvent,
    noteFloor,
    openJobStream,
    teardown,
  ]);

  // ── Text input (same conversation, typed instead of spoken) ────

  const sendText = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || !dcRef.current) return;
      // Minted once and used twice: the line on screen and the archived turn are
      // the same turn, so the echo off `/live` must land on the line, not next to it.
      const id = `typed-${Date.now()}`;
      upsertEntry(id, "user", () => trimmed, true);
      persist(id, "user", trimmed);
      send(userTextEvent(trimmed));
      requestResponse();
    },
    [persist, requestResponse, send, upsertEntry],
  );

  const cancelJob = useCallback((jobId: string) => {
    void api.cancelAgentJob(jobId).catch(() => {});
  }, []);


  // Switching conversations tears the session down; a live call belongs to the
  // conversation it was opened for.
  useEffect(() => {
    setTranscript([]);
    setJobs([]);
    setDeepThinkJobs([]);
    setWebSearchJobs([]);
    setDiagrams([]);
    setDocumentContent(null);
    setResumed(false);
    setMemoryEvents(0);
    setSessionUsd(0);
    return () => disconnect();
  }, [conversationId, disconnect]);

  // The document, read once per conversation. The stream keeps it current after
  // that; this is the only thing that puts the existing one on screen, and it is
  // the same reason the archived transcript is fetched — a first connection to
  // `/live` replays nothing.
  useEffect(() => {
    if (!conversationId) return;

    let cancelled = false;
    void api
      .getDocument(conversationId)
      .then((content) => {
        if (cancelled || convRef.current !== conversationId) return;
        setDocumentContent(content ?? "");
      })
      .catch(() => {
        // A conversation with no document answers null, not an error. Anything
        // else leaves the panel on its empty state, which is recoverable by
        // typing — and by the next `document.changed` frame.
      });

    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  /**
   * Put the conversation's archived turns on screen.
   *
   * This is the half of the contract the server counts on. A first connection to
   * `/live` replays nothing — `since <= 0` is not a gap — precisely because the
   * client is expected to have just read the conversation over REST; replaying
   * the ring buffer on top of that would show every message twice. So the read
   * is not decoration: without it the second person joining a call in progress
   * sees an empty page until somebody says something new.
   *
   * It runs again whenever `history.reset` fires, which is the stream saying its
   * buffer cannot cover our gap. `mergeRemoteEntries` adds only what is missing,
   * so nothing already on screen is redrawn or reordered.
   *
   * Declared after the reset effect above so React runs it second, for the same
   * reason the gallery seeding is.
   */
  useEffect(() => {
    if (!conversationId) return;

    let cancelled = false;
    void fetchArchivedTranscript(conversationId, nowISO())
      .then((archived) => {
        // Re-read after the await: the user may have moved on, and seeding one
        // conversation's turns into another is worse than seeding none.
        if (cancelled || convRef.current !== conversationId) return;
        if (archived.length === 0) return;
        setTranscript((live) => mergeRemoteEntries(live, archived));
      })
      .catch(() => {
        // The live half of the conversation still works without its past.
      });

    return () => {
      cancelled = true;
    };
  }, [conversationId, historyToken]);

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
    micFailure,
    audioBlocked,
    playAudio,
    callDropped,
    transcript,
    userSpeaking,
    assistantSpeaking,
    activeTool,
    jobs,
    deepThinkJobs,
    webSearchJobs,
    diagrams,
    documentContent,
    setDocumentContent,
    resumed,
    memoryEvents,
    sessionUsd,
    viewers,
    floor,
    isFloorHolder,
    floorRequest,
    requestFloor,
    grantFloor,
    releaseFloor,
    connect,
    disconnect,
    sendText,
    cancelJob,
    reloadMemory,
    setSpeed,
  };
}
