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
export type SessionStreamEvent = AgentJobEvent | DeepThinkEvent | WebSearchEvent;

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
  /**
   * The conversation's markdown document was written, by the model or by
   * somebody on another screen. Carries the whole document rather than a patch:
   * it is capped at 100k characters server-side, and a diff protocol between
   * three writers is a bug surface this feature does not need.
   */
  | { type: "document.changed"; content: string; source: "user" | "assistant" }
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

// ---------------------------------------------------------------------------
// Conversation modes — mirrors backend/src/modes/types.ts
// ---------------------------------------------------------------------------

/**
 * One kind of conversation, as `GET /api/modes` describes it.
 *
 * Nothing in this package enumerates modes. The picker renders whatever the
 * server sends and the sidebar takes its title and its empty state from
 * `document`, so a mode added in `backend/src/modes/registry.ts` appears here
 * without a line changing.
 */
export interface ModeSummary {
  id: string;
  label: string;
  description: string;
  /** A `lucide-react` icon name, resolved against an allowlist in the picker. */
  icon: string;
  requires_material: boolean;
  document: {
    title: string;
    placeholder: string;
    open_by_default: boolean;
  } | null;
}

export interface ModesEnvelope {
  modes: ModeSummary[];
  default: string;
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

/**
 * The three providers the backend can be asked to call.
 *
 * Mirrors `backend/src/types/thinker-roster.ts`; the roster's own
 * `ThinkerProvider` is the same union.
 */
export type ProviderName = "openai" | "openrouter" | "deepseek";

/**
 * What the app is allowed to learn about a provider's key — never the key.
 *
 * Mirrors `backend/src/services/providers/keys.ts`, which builds the whole
 * object inside the module that owns the secret.
 */
export interface ProviderKeyStatus {
  provider: ProviderName;
  env_var: string;
  present: boolean;
  source: "runtime" | "env" | null;
  console_url: string;
}

export interface ProviderCredit {
  provider: ProviderName;
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

// ---------------------------------------------------------------------------
// Thinker roster — mirrors backend/src/types/thinker-roster.ts
// ---------------------------------------------------------------------------

/**
 * The three providers a roster row can point at.
 *
 * The same union as `ProviderName`; declared separately because the backend
 * treats it as its own type (`backend/src/types/thinker-roster.ts`) and the
 * wire contract is what this file mirrors.
 */
export type ThinkerProvider = ProviderName;

export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * One roster row's model: the provider, the provider's own id, and everything
 * discovery learned about the model so the budgeter never has to guess.
 */
export interface ModelChoice {
  provider: ThinkerProvider;
  model: string;
  /** Goes out as `reasoning.effort` (Responses) or `reasoning_effort` (Chat). */
  effort?: ReasoningEffort;
  /** Context window in tokens; `null` = never discovered (budget at the floor). */
  context_window: number | null;
  supports_tools: boolean;
  /** USD per 1M tokens, or `null` when no published price is known. */
  rate: { input: number; cached_input: number; output: number } | null;
  discovered_at?: string;
}

export interface ThinkerSlot {
  /**
   * 1..10, stable: it addresses the row in the UI, so it survives a slot being
   * disabled and is never renumbered to close a gap.
   */
  index: number;
  /** A disabled slot is skipped by the round but KEEPS its model. */
  enabled: boolean;
  model: ModelChoice;
  /** A fixed angle overriding the planner for this slot alone. */
  angle?: string;
}

export interface ThinkerRoster {
  version: 1;
  /** Reads every thinker's full trace and writes the answer. */
  master: ModelChoice;
  /** Plans the angles; deliberately does NOT follow the master. */
  planner: ModelChoice;
  /** Always ten items, in index order, including the disabled ones. */
  slots: ThinkerSlot[];
  updated_at: string;
}

export type RosterWarningCode = "provider_key_missing";

/** Which row of the settings screen a warning is about. */
export type RosterRole = "master" | "planner" | "thinker";

/**
 * Why a row cannot be called. The message is Brazilian Portuguese and reaches
 * the screen verbatim.
 */
export interface RosterWarning {
  code: RosterWarningCode;
  role: RosterRole;
  provider: ThinkerProvider;
  /** 1..10. Present only when `role` is `"thinker"`. */
  slot_index?: number;
  message: string;
}

/**
 * Everything `GET /api/thinkers` answers — and every later read or write of
 * the roster, which all carry the same envelope because the UI cannot render
 * a roster without the key statuses and warnings that describe it.
 */
export interface RosterEnvelope {
  roster: ThinkerRoster;
  providers: ProviderKeyStatus[];
  warnings: RosterWarning[];
}

/**
 * One verdict per unique config after `POST /api/thinkers/test`, keyed by
 * `${provider}::${model}::${effort ?? "default"}` — the same string the UI
 * dedupes with. `skipped` means the provider has no key, so there is nothing
 * to try; `errors` carries the adapter's own message for `error` verdicts.
 *
 * Mirrors `ConfigTestEnvelope` in backend/src/routes/thinkers.ts.
 */
export interface ConfigTestEnvelope {
  results: Record<string, "ok" | "error" | "skipped">;
  errors: Record<string, string>;
}

// ---------------------------------------------------------------------------
// The model catalogue — mirrors backend/src/services/model-catalog.ts
// ---------------------------------------------------------------------------

/** One model in the catalogue, as `GET /api/models` hands it out. */
export interface CatalogModel {
  /** The id to send back as the request's `model`, verbatim. */
  id: string;
  /** Human-readable, for the roster UI. Falls back to `id`. */
  label: string;
  context_window: number | null;
  max_output_tokens: number | null;
  supports_tools: boolean;
  rate: { input: number; cached_input: number; output: number } | null;
  released_at: string | null;
  /**
   * The year of `released_at`, or `null` when the provider published no date.
   * `null` is never rendered as, coerced to, or counted as the minimum year —
   * an undated model is "sem data", not "2026".
   */
  year: number | null;
  /**
   * True only when this model is in the caller's `keep` list AND would have
   * been filtered out without it — the "(selecionado)" badge.
   */
  kept_by_selection: boolean;
}

export type CatalogProviderState = "ok" | "skipped" | "error";

/** What one provider answered, reported rather than absorbed. */
export interface CatalogProviderStatus {
  provider: ThinkerProvider;
  /** `ok` — answered; `skipped` — its catalogue needs a key; `error` — it failed. */
  status: CatalogProviderState;
  /** Why, in Brazilian Portuguese for `skipped`; the provider's own words for `error`. */
  note?: string;
  /** Models this provider answered with, BEFORE any filter. Zero unless `ok`. */
  count: number;
}

export interface CatalogResult {
  models: CatalogModel[];
  providers: CatalogProviderStatus[];
  /** The minimum year actually applied, after defaults and clamping. */
  min_year: number;
  /** Models discovered before filtering. Always the sum of `providers[].count`. */
  total: number;
  /** Models that survived. Always `models.length`. */
  filtered: number;
}

// ---------------------------------------------------------------------------
// Web search — mirrors backend/src/types/deep-tools.ts
// ---------------------------------------------------------------------------

/** One background web search, as the browser knows it. */
export interface WebSearchJob {
  id: string;
  conversation_id: string;
  query: string;
  status: "running" | "done" | "error" | "cancelled";
  activity: string;
  result?: string;
  error?: string;
  cost_usd?: number;
  started_at: string;
  finished_at?: string;
}

/**
 * The web-search half of the job stream.
 *
 * Same discipline as `DeepThinkEvent`: `web_search_activity` carries no
 * `replay` field at all — only a finished search is ever replayed.
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
