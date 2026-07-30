// === Core domain types for voice-assistant ===
// From PLAYBOOK.md section 13 — Modelo de dados

export interface Conversation {
  id: string; // UUID
  title: string; // "Nova conversa" or auto-generated summary
  created_at: string; // ISO 8601
  updated_at: string; // ISO 8601
  messages: Message[];
  attachments: Attachment[]; // Reference only, not file content
}

export interface Message {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string | null; // null when the message is only a tool_call
  tool_calls?: ToolCall[]; // Present on assistant messages
  tool_call_id?: string; // Present on tool messages
  audio_url?: string; // Path to TTS audio file (assistant only)
  timestamp: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: "web_research" | "search_project_files" | "read_file" | "list_attachments";
    arguments: string; // JSON string
  };
}

export interface Attachment {
  id: string;
  filename: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  path: string; // Relative to conversation directory
  added_at: string;
}
