export type SourceKind = "repo" | "markdown" | "machine";

/** One material a conversation is pointed at. */
export interface Material {
  id: string;
  kind: SourceKind;
  label: string;
  origin?: string;
  primary_doc_path?: string;
  primary_doc_preview: string | null;
  primary_doc_chars: number;
  ephemeral: boolean;
  resolved_at: string;
}

/** Everything a conversation is pointed at, plus what that unlocks. */
export interface MaterialsEnvelope {
  materials: Material[];
  tools: string[];
  greeting: string;
  /** Present on an add, so the UI can point at what just arrived. */
  added?: Material;
}

/** A directory offered by the machine browser. */
export interface BrowseEntry {
  name: string;
  path: string;
  is_repo: boolean;
  has_doc: boolean;
}

export interface BrowseResult {
  path: string | null;
  parent: string | null;
  roots: string[];
  entries: BrowseEntry[];
  self?: BrowseEntry | null;
}

export interface SourceSpec {
  kind: SourceKind;
  ref?: string;
  markdown?: string;
  label?: string;
}

export type AgentJobStatus = "running" | "done" | "error" | "cancelled";

export interface AgentJob {
  id: string;
  conversation_id: string;
  prompt: string;
  cwd: string;
  status: AgentJobStatus;
  activity: string;
  result?: string;
  error?: string;
  started_at: string;
  finished_at?: string;
  cost_usd?: number;
}

export type AgentJobEvent =
  | { type: "activity"; job_id: string; activity: string }
  | { type: "done"; job_id: string; result: string; cost_usd?: number; replay?: boolean }
  | { type: "error"; job_id: string; error: string; replay?: boolean };

// ---------------------------------------------------------------------------
// Deep think — mirrors backend/src/types/deep-tools.ts
// ---------------------------------------------------------------------------

/** One hit a thinker actually opened, as Brave returned it. */
export interface BraveResult {
  title: string;
  url: string;
  snippet: string;
  age?: string;
}

export type ThinkerStatus = "pending" | "running" | "done" | "error";

/** One thinker: the same scenario seen from one deliberate angle. */
export interface ThinkerResult {
  id: string;
  angle: string;
  status: ThinkerStatus;
  thinking?: string;
  citations?: BraveResult[];
  searches?: number;
  error?: string;
  usd?: number;
}

export type DeepThinkStatus = "running" | "done" | "error" | "cancelled";

/**
 * One deliberation round, as the browser knows it.
 *
 * The stream carries no `scenario` — it is what the voice model asked, and only
 * the server ever saw it — so a card built from events alone starts with an
 * empty one, exactly like `AgentJob.prompt`.
 */
export interface DeepThinkJob {
  id: string;
  conversation_id: string;
  scenario: string;
  status: DeepThinkStatus;
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
 * The deliberation half of the job stream.
 *
 * A sibling union rather than three more members of `AgentJobEvent`, for the
 * same reason the backend keeps them apart: the two describe different
 * subsystems and only share a transport. `deep_think_activity` carries no
 * `replay` field at all — only a finished round is ever replayed.
 */
export type DeepThinkEvent =
  | {
      type: "deep_think_activity";
      job_id: string;
      activity: string;
      thinkers: ThinkerResult[];
    }
  | {
      type: "deep_think_done";
      job_id: string;
      synthesis: string;
      thinkers: ThinkerResult[];
      cost_usd?: number;
      replay?: boolean;
    }
  | { type: "deep_think_error"; job_id: string; error: string; replay?: boolean };

/**
 * Everything `GET /api/agents/events` can deliver.
 *
 * One EventSource carries both unions because their discriminants are disjoint.
 * Anything reading this must narrow with `isDeepThinkEvent` before it folds an
 * event into a card — a chain of `type === "done" ? … : …` treats every
 * unrecognised type as a failure and invents a job that never existed.
 */
export type SessionStreamEvent = AgentJobEvent | DeepThinkEvent;

// ---------------------------------------------------------------------------
// The shared conversation — mirrors backend/src/services/conversation-bus.ts
// ---------------------------------------------------------------------------
//
// A second, entirely separate stream from the one above. `GET /api/agents/events`
// is per realtime session and feeds the model; `GET /api/conversations/:id/live`
// is per *conversation*, is opened by every screen that has it open — spectators
// included, and a spectator never connects a session — and feeds nothing but the
// screen. See the invariant in `lib/conversation-stream.ts`.

/** Who holds the microphone on a conversation. */
export interface FloorSnapshot {
  client_id: string;
  name: string;
  /** ISO stamp of when they took it. */
  since: string;
}

/** A viewer asking the holder to hand it over. */
export interface FloorRequest {
  client_id: string;
  name: string;
}

/** One archived turn, as the live stream carries it. */
export interface LiveMessage {
  id: string;
  /** `user`, `assistant` or `tool` in practice; typed loose because it is wire. */
  role: string;
  content: string | null;
  timestamp: string;
}

/**
 * Everything `GET /api/conversations/:id/live` can deliver.
 *
 * `history.reset` is the one frame the server sends with no `id:` line — it is
 * addressed to a single reconnecting client and must not move anybody's cursor.
 */
export type LiveEvent =
  /** A turn reached disk, on any screen. Emitted after the write, never before. */
  | { type: "message.appended"; messages: LiveMessage[] }
  /**
   * A tool the model called finished. A generated diagram rides in
   * `meta.diagram` rather than getting an event of its own.
   */
  | {
      type: "tool.finished";
      call_id: string | null;
      name: string;
      output: string;
      meta: Record<string, unknown> | null;
    }
  /** The memory file grew or was replaced. Coalesced server-side over 2 s. */
  | { type: "memory.changed"; event_count: number }
  /** Someone opened or closed the conversation. */
  | { type: "presence.changed"; viewers: number; floor: FloorSnapshot | null }
  /** The microphone changed hands, was taken or was let go. */
  | { type: "floor.changed"; holder: string | null; name: string | null }
  /** A viewer asked the holder for the microphone. */
  | { type: "floor.requested"; client_id: string; name: string }
  /** The replay gap fell out of the ring buffer: refetch the conversation. */
  | { type: "history.reset"; since: number };

export type LiveToolFinished = Extract<LiveEvent, { type: "tool.finished" }>;

/** The three frames that describe who is here and who is talking. */
export type LivePresenceEvent = Extract<
  LiveEvent,
  { type: "presence.changed" | "floor.changed" | "floor.requested" }
>;

// ---------------------------------------------------------------------------
// Mermaid — mirrors backend/src/types/deep-tools.ts
// ---------------------------------------------------------------------------

/** The closed list the generator is allowed to emit. */
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

export interface MermaidDiagram {
  id: string;
  kind: MermaidDiagramKind;
  title?: string;
  /** The mermaid source itself, already validated server-side. */
  source: string;
  /** The only part the model ever says out loud. */
  caption: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Memory — mirrors backend/src/types/deep-tools.ts
// ---------------------------------------------------------------------------

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
  text?: string;
  tool?: string;
  arguments?: string;
  output?: string;
  diagram_id?: string;
  meta?: Record<string, unknown>;
}

export interface MemoryFile {
  version: 1;
  conversation_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  materials: string[];
  events: MemoryEvent[];
  diagrams?: MermaidDiagram[];
}

/** The compressed form a resumed session is seeded with. */
export interface MemoryResume {
  conversation_id: string;
  summary: string;
  reflections: string[];
  tool_findings: string[];
  materials: string[];
  event_count: number;
}

/** One line of the live conversation. */
export interface TranscriptEntry {
  id: string;
  role: "user" | "assistant" | "tool" | "agent";
  text: string;
  /** Assistant/user lines stream in; `false` means the turn is still growing. */
  final: boolean;
  timestamp: string;
}

export interface Message {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string | null;
  timestamp: string;
}

export interface Conversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  messages?: Message[];
  metadata?: Record<string, unknown>;
}

export interface RealtimeSessionToken {
  value: string;
  expires_at: number;
  model: string;
  voice: string;
  speed: number;
  materials: Array<{
    id: string;
    kind: SourceKind;
    label: string;
    origin?: string;
    primary_doc_path?: string;
  }>;
  /**
   * The tools this session actually holds. `deep_think` and `check_deep_think`
   * only appear when the server has a `BRAVE_API_KEY`, so no UI may assume them.
   */
  tools: string[];
  /** The conversation was picked up, not started. The resume itself stays server-side. */
  resumed: boolean;
  /** How many recorded events that resume was compressed from. */
  memory_events: number;
  /**
   * Who ended up with the microphone — this caller, when it identified itself.
   *
   * The mint is the floor's enforcement point, so a 200 here means the session
   * is allowed to exist. Reading the holder off the body saves inferring it from
   * the absence of a 409.
   */
  floor: FloorSnapshot | null;
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

export type CostSource =
  | "realtime"
  | "web_search"
  | "pi_agent"
  | "text"
  | "deep_think"
  | "mermaid";

export interface CostEntry {
  source: CostSource;
  usd: number;
  detail?: string;
  tokens?: { input?: number; output?: number; audio?: number; cached?: number };
  at: string;
}

export interface CostSummary {
  total_usd: number;
  by_source: Record<CostSource, number>;
  entries: CostEntry[];
  process_total_usd: number;
}

export interface ProviderCredit {
  provider: "openai" | "openrouter" | "deepseek";
  label: string;
  remaining_usd: number | null;
  used_usd: number | null;
  total_usd: number | null;
  status: "ok" | "unavailable" | "error";
  note?: string;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface ConversationSettings {
  voice: string;
  speed: number;
  voices: string[];
}
