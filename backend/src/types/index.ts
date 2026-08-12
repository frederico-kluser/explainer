// === Core domain types for Explainer ===
//
// The app is a realtime voice companion: the browser holds a WebRTC session with
// an OpenAI realtime model, and every tool the model calls is executed here on
// the server. What the model is allowed to ask for depends on the *source* the
// user pointed the conversation at.

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/**
 * Where the answers come from.
 *
 * - `repo`     — a git repository (GitHub URL or a local path). The README is
 *                the anchor document; the model can grep the tree and dispatch
 *                `pi` coding agents at it.
 * - `markdown` — a free-floating markdown document with no repository behind it.
 *                Nothing to grep, so the only tool is web search.
 * - `machine`  — this laptop. Backed by the `~/Projects/config` docs, whose
 *                `project-router` skill is the domain → document index.
 */
export type SourceKind = "repo" | "markdown" | "machine";

/** What the client sends when it picks a source. */
export interface SourceSpec {
  kind: SourceKind;
  /** `repo`: a GitHub URL or an absolute local path. */
  ref?: string;
  /** `markdown`: the raw document. */
  markdown?: string;
  /** Optional display name; derived when omitted. */
  label?: string;
}

/** What the server resolved that spec into. Cached per conversation. */
export interface ResolvedSource {
  /** Stable handle, so the UI can remove it and the model can name it. */
  id: string;
  kind: SourceKind;
  label: string;
  /** Absolute directory the tools may read, for `repo` and `machine`. */
  root?: string;
  /** Where `root` came from — a URL for clones, the path itself for local repos. */
  origin?: string;
  /** Path of the anchor document, relative to `root`. */
  primary_doc_path?: string;
  /** Contents of the anchor document (README.md, SKILL.md, the pasted markdown). */
  primary_doc?: string;
  /** True when `root` is a throwaway clone we made, not a directory the user owns. */
  ephemeral?: boolean;
  resolved_at: string;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export type ToolName =
  | "web_search"
  | "list_materials"
  | "read_source_doc"
  | "search_source"
  | "read_source_file"
  | "list_source_files"
  | "dispatch_pi_agent"
  | "check_pi_agent"
  | "deep_think"
  | "check_deep_think"
  | "generate_diagram"
  // The conversation's own markdown document. Granted by the mode rather than
  // by the materials — these four read and write a file this conversation owns,
  // so they are the first tools whose availability has nothing to do with what
  // the conversation is pointed at.
  | "read_document"
  | "write_document"
  | "append_document"
  | "edit_document_section";

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: ToolName;
    arguments: string; // JSON string, straight off the wire
  };
}

// ---------------------------------------------------------------------------
// Agent jobs (pi coding agent)
// ---------------------------------------------------------------------------

export type AgentJobStatus = "running" | "done" | "error" | "cancelled";

export interface AgentJob {
  id: string;
  conversation_id: string;
  prompt: string;
  cwd: string;
  status: AgentJobStatus;
  /** Short human-readable trace of what the agent is doing right now. */
  activity: string;
  /** Final answer once `status === "done"`. */
  result?: string;
  error?: string;
  started_at: string;
  finished_at?: string;
  cost_usd?: number;
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export interface Conversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  messages: Message[];
  attachments: Attachment[];
  metadata?: Record<string, unknown>;
}

export interface Message {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  audio_url?: string;
  timestamp: string;
}

export interface Attachment {
  id: string;
  filename: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  path: string;
  added_at: string;
}
