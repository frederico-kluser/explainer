import type { Message } from "../types/index.js";
import type { ChatMessage } from "./openrouter.js";

/** How many stored messages are replayed verbatim once a summary exists. */
export const RECENT_MESSAGE_WINDOW = 16;

/**
 * Turn stored messages into a transcript the chat API will accept.
 *
 * Tool calls are persisted alongside ordinary messages, so any window into the
 * history can cut an `assistant(tool_calls)` → `tool(result)` pair in half.
 * OpenAI-compatible endpoints reject both halves of a broken pair, which would
 * make every later turn fail once a conversation grew past the window. This
 * drops the orphans on both sides so what is sent is always self-consistent.
 */
export function buildTranscript(messages: Message[]): ChatMessage[] {
  // Tool results present in this window, by the call they answer.
  const resolvedIds = new Set<string>();
  for (const m of messages) {
    if (m.role === "tool" && m.tool_call_id) resolvedIds.add(m.tool_call_id);
  }

  const announcedIds = new Set<string>();
  const out: ChatMessage[] = [];

  for (const m of messages) {
    if (m.role === "tool") {
      // A result whose call was cut out of the window has nothing to attach to.
      if (!m.tool_call_id || !announcedIds.has(m.tool_call_id)) continue;
      out.push({
        role: "tool",
        content: m.content,
        tool_call_id: m.tool_call_id,
      });
      continue;
    }

    if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
      const answered = m.tool_calls.filter((tc) => resolvedIds.has(tc.id));

      if (answered.length === 0) {
        // No results survived — keep any prose, drop the dangling calls.
        if (m.content && m.content.trim().length > 0) {
          out.push({ role: "assistant", content: m.content });
        }
        continue;
      }

      for (const tc of answered) announcedIds.add(tc.id);
      out.push({ role: "assistant", content: m.content, tool_calls: answered });
      continue;
    }

    out.push({ role: m.role, content: m.content });
  }

  return out;
}
