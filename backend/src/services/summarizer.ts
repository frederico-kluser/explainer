import type { Message } from "../types/index.js";
import { chat, type ChatMessage } from "./openrouter.js";

// ---------------------------------------------------------------------------
// Token estimation – rough heuristic for English (chars / 4)
// For Portuguese, use chars / 3 instead.
// ---------------------------------------------------------------------------

function estimateTokens(messages: Message[]): number {
  let totalChars = 0;
  for (const msg of messages) {
    if (msg.content) totalChars += msg.content.length;
    if (msg.tool_calls) totalChars += JSON.stringify(msg.tool_calls).length;
  }
  return Math.ceil(totalChars / 4);
}

const MAX_ESTIMATED_TOKENS = 8000;

/**
 * Returns true when the estimated token count of the conversation exceeds
 * the summarization threshold (8000 tokens).
 */
export function shouldSummarize(messages: Message[]): boolean {
  return estimateTokens(messages) > MAX_ESTIMATED_TOKENS;
}

// ---------------------------------------------------------------------------
// Summarization
// ---------------------------------------------------------------------------

const SUMMARIZE_SYSTEM_PROMPT =
  "You are a conversation summarizer. Summarize the following conversation " +
  "in about 200 words. Focus on:\n" +
  "- The user's main questions and requests\n" +
  "- Key information provided or discovered\n" +
  "- Important decisions or conclusions reached\n" +
  "- Any pending items or open questions\n\n" +
  "Write a concise, factual summary. Do not add commentary or analysis " +
  "beyond what is in the conversation.";

/**
 * Produces a ~200-word summary of the conversation via a non-streaming LLM call.
 */
export async function summarizeConversation(
  messages: Message[],
): Promise<string> {
  const conversationText = messages
    .map((m) => {
      const header = `[${m.role}]`;
      const body = m.content ?? "(tool call)";
      return `${header} ${body}`;
    })
    .join("\n\n");

  const summaryMessages: ChatMessage[] = [
    { role: "system", content: SUMMARIZE_SYSTEM_PROMPT },
    {
      role: "user",
      content: `Please summarize this conversation:\n\n${conversationText}`,
    },
  ];

  const response = await chat(summaryMessages);
  const content = response.choices[0]?.message?.content;

  if (!content) {
    throw new Error("Summarization returned empty response");
  }

  return content;
}
