// === Contracts for the three deliberation subsystems ===
//
// Frozen ahead of the implementations so the modules that produce these values
// and the modules that consume them can be written at the same time without
// agreeing on anything else. Types only: putting logic here would make this file
// a second place to look for behaviour.
//
//   - Brave search    — the web the thinkers read from
//   - Deep think      — the fan-out of thinkers plus one synthesiser
//   - Mermaid         — instructions in, validated diagram source out
//   - Memory          — the conversation as a file that can be resumed

// ---------------------------------------------------------------------------
// Brave search
// ---------------------------------------------------------------------------

/** One hit from the Brave Search API, flattened to what a thinker can cite. */
export interface BraveResult {
  title: string;
  url: string;
  /** Description/snippet, already stripped of Brave's <strong> highlight tags. */
  snippet: string;
  /** ISO date when Brave reports one; absent for undated pages. */
  age?: string;
}

export interface BraveSearchResponse {
  query: string;
  results: BraveResult[];
  /** Brave's own one-paragraph answer, when the plan in use returns one. */
  summary?: string;
}

/**
 * What a thinker is handed to reach the web.
 *
 * Passed in rather than imported so the deep-think engine can be exercised
 * against a stub, and so a search outage degrades a thinker instead of the run.
 */
export type SearchFn = (
  query: string,
  options?: { count?: number },
) => Promise<BraveSearchResponse>;

// ---------------------------------------------------------------------------
// Deep think
// ---------------------------------------------------------------------------

/** Hard ceiling the user asked for. More thinkers is not more thinking. */
export const MAX_THINKERS = 10;

/**
 * One thinker: the same scenario seen from one deliberate angle.
 *
 * The angle is what makes the fan-out worth its cost — ten agents given the
 * same prompt return the same answer ten times.
 */
export interface ThinkerSpec {
  id: string;
  /** Short label for the UI, e.g. "riscos", "custo", "quem discorda". */
  angle: string;
  /** The instruction this thinker reasons under. */
  prompt: string;
}

export type ThinkerStatus = "pending" | "running" | "done" | "error";

export interface ThinkerResult {
  id: string;
  angle: string;
  status: ThinkerStatus;
  /** The thinker's reasoning, in Brazilian Portuguese, once it is done. */
  thinking?: string;
  /** Every source the thinker actually opened, in the order it opened them. */
  citations?: BraveResult[];
  /** Number of Brave calls this thinker made, for the cost ledger. */
  searches?: number;
  error?: string;
  usd?: number;
}

export type DeepThinkStatus = "running" | "done" | "error" | "cancelled";

export interface DeepThinkJob {
  id: string;
  conversation_id: string;
  /** The question or scenario, as the voice model phrased it. */
  scenario: string;
  status: DeepThinkStatus;
  /** Human-readable trace of the current stage, for the spoken status line. */
  activity: string;
  thinkers: ThinkerResult[];
  /** The synthesiser's consolidated answer, plain prose, ready to be spoken. */
  synthesis?: string;
  error?: string;
  started_at: string;
  finished_at?: string;
  cost_usd?: number;
}

/**
 * What the SSE stream carries. Deliberately parallel to `AgentJobEvent`: the
 * browser already knows how to fold one of these into a card.
 */
export type DeepThinkEvent =
  | { type: "deep_think_activity"; job_id: string; activity: string; thinkers: ThinkerResult[] }
  | { type: "deep_think_done"; job_id: string; synthesis: string; thinkers: ThinkerResult[]; cost_usd?: number; replay?: boolean }
  | { type: "deep_think_error"; job_id: string; error: string; replay?: boolean };

// ---------------------------------------------------------------------------
// Mermaid
// ---------------------------------------------------------------------------

/**
 * The diagram kinds the generator is allowed to emit.
 *
 * A closed list, because the model will happily invent a diagram type that
 * mermaid has never supported and the browser then renders an error box.
 */
export type MermaidDiagramKind =
  | "flowchart"
  | "sequenceDiagram"
  | "classDiagram"
  | "stateDiagram-v2"
  | "erDiagram"
  | "journey"
  | "gantt"
  | "pie"
  | "mindmap"
  | "timeline";

export interface MermaidRequest {
  /** What to draw, in natural language. The caller never writes mermaid. */
  instructions: string;
  /** Optional nudge; omitted, the generator picks the kind from the wording. */
  kind?: MermaidDiagramKind;
  /** Optional title rendered above the diagram in the UI. */
  title?: string;
}

export interface MermaidDiagram {
  id: string;
  kind: MermaidDiagramKind;
  title?: string;
  /** The mermaid source itself, already validated. */
  source: string;
  /** One or two sentences the voice model can say while it is on screen. */
  caption: string;
  created_at: string;
}

/** Why a generated diagram was rejected, so the generator can retry usefully. */
export interface MermaidValidation {
  ok: boolean;
  kind?: MermaidDiagramKind;
  problems: string[];
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

/**
 * One thing that happened, in order.
 *
 * The user asked for the conversation, the reflections and the tool calls in the
 * same file — so they are one append-only sequence rather than three lists that
 * can drift out of order with each other.
 */
export type MemoryEventKind =
  | "user"
  | "assistant"
  | "tool_call"
  | "tool_result"
  | "reflection"
  | "diagram"
  | "note";

export interface MemoryEvent {
  id: string;
  kind: MemoryEventKind;
  at: string;
  /** The text of the turn, the reflection, or the note. */
  text?: string;
  /** `tool_call` / `tool_result`: which tool, and what went in and out. */
  tool?: string;
  arguments?: string;
  output?: string;
  /** `diagram`: the mermaid id this event points at. */
  diagram_id?: string;
  /** Free-form extras a producer wants to keep without widening this type. */
  meta?: Record<string, unknown>;
}

export interface MemoryFile {
  /** Bumped when the shape changes, so an old file can be read or refused. */
  version: 1;
  conversation_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  /** Labels of the materials the conversation was pointed at when it ran. */
  materials: string[];
  events: MemoryEvent[];
  /** Diagrams produced during the conversation, kept whole for replay. */
  diagrams?: MermaidDiagram[];
}

/**
 * What a resumed conversation is seeded with.
 *
 * Not the raw file: a full transcript replayed into the session instructions
 * would be re-billed on every single response. This is the compressed form.
 */
export interface MemoryResume {
  conversation_id: string;
  /** Prose summary of what was discussed and decided. */
  summary: string;
  /** The reflections worth carrying forward, verbatim. */
  reflections: string[];
  /** Which tools were used and what they established. */
  tool_findings: string[];
  materials: string[];
  event_count: number;
}

// ---------------------------------------------------------------------------
// Web search
// ---------------------------------------------------------------------------

/**
 * One background web search, as the job stream knows it.
 *
 * The query the voice model asked for plus the state of the run. The stream
 * carries no context block — only the server ever saw it.
 */
export interface WebSearchJob {
  id: string;
  conversation_id: string;
  query: string;
  status: "running" | "done" | "error" | "cancelled";
  activity: string;
  /** The spoken answer (with sources), when the job finished. */
  result?: string;
  error?: string;
  cost_usd?: number;
  started_at: string;
  finished_at?: string;
}

/**
 * The web-search half of the job stream.
 *
 * A sibling union with the same discipline as `DeepThinkEvent`: discriminants
 * disjoint from the agent job's and the deliberation round's, `activity` with
 * no `replay` field — only a finished search is ever replayed.
 */
export type WebSearchEvent =
  | { type: "web_search_activity"; job_id: string; activity: string }
  | {
      type: "web_search_done";
      job_id: string;
      result: string;
      cost_usd?: number;
      replay?: boolean;
    }
  | { type: "web_search_error"; job_id: string; error: string; replay?: boolean };
