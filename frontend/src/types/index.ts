export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: "web_research" | "search_project_files" | "read_file" | "list_attachments";
    arguments: string;
  };
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

export interface Conversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  messages?: Message[];
  attachments?: Attachment[];
}

export type ChatEvent =
  | { type: "tool_call"; tool: string; args: Record<string, unknown> }
  | { type: "content"; text: string }
  | { type: "audio"; url: string }
  | { type: "done" };
