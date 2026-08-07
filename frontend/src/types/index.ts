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
  role: "user" | "assistant" | "agent" | "tool" | "system";
  content: string | null;
  timestamp: string;
}

export interface MessagesResponse {
  messages: Message[];
  total: number;
  has_more: boolean;
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
  materials: Array<{
    id: string;
    kind: SourceKind;
    label: string;
    origin?: string;
    primary_doc_path?: string;
  }>;
  tools: string[];
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

export type CostSource = "realtime" | "web_search" | "pi_agent" | "text";

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
