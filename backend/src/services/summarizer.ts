import type { Message } from "../types/index.js";
import { chat, type ChatMessage } from "./openrouter.js";
import { RECENT_MESSAGE_WINDOW } from "./transcript.js";

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

// After summarizing, the verbatim tail must sit well under the trigger, or the
// next turn immediately crosses the threshold again. Half the budget leaves
// room for several turns before another summary is due.
const RECENT_TOKEN_BUDGET = MAX_ESTIMATED_TOKENS / 2;

// ---------------------------------------------------------------------------
// Summary state — persisted in conversation.metadata
// ---------------------------------------------------------------------------

export interface SummaryState {
  /** The summary text itself. */
  summary: string;
  /** Messages `[0, covered)` are represented by `summary`. */
  covered: number;
}

/** Read the summary bookkeeping out of a conversation's metadata, if present. */
export function readSummaryState(
  metadata: Record<string, unknown> | undefined,
): SummaryState | null {
  if (!metadata) return null;

  const summary = metadata.summary;
  if (typeof summary !== "string" || summary.length === 0) return null;

  const covered = metadata.summarized_count;
  return {
    summary,
    covered: typeof covered === "number" && covered > 0 ? covered : 0,
  };
}

/**
 * How far a new summary should reach — the index of the first message that
 * stays verbatim.
 *
 * Walks back from the newest message keeping a tail bounded by *both*
 * `RECENT_MESSAGE_WINDOW` and `RECENT_TOKEN_BUDGET`. Bounding by message count
 * alone is not enough: 16 verbose messages can carry more tokens than the
 * trigger threshold, in which case the tail stays over budget and every single
 * turn pays for another summary.
 *
 * Returns `covered` unchanged when there is nothing new worth folding in.
 */
export function nextSummaryBoundary(
  messages: Message[],
  covered: number,
): number {
  let boundary = messages.length;
  let kept = 0;
  let tokens = 0;

  for (let i = messages.length - 1; i >= covered; i--) {
    const cost = estimateTokens([messages[i]!]);
    // Always keep at least the newest message, however large it is.
    const full =
      kept > 0 &&
      (kept + 1 > RECENT_MESSAGE_WINDOW || tokens + cost > RECENT_TOKEN_BUDGET);
    if (full) break;

    kept++;
    tokens += cost;
    boundary = i;
  }

  return Math.max(covered, boundary);
}

/**
 * Returns true when the part of the conversation that is *not* yet summarized
 * exceeds the threshold and there is genuinely new material to fold in.
 *
 * Measuring only the uncovered tail is what stops the summary from being
 * regenerated on every single turn once a conversation crosses the threshold.
 */
export function shouldSummarize(messages: Message[], covered = 0): boolean {
  if (nextSummaryBoundary(messages, covered) <= covered) return false;
  return estimateTokens(messages.slice(covered)) > MAX_ESTIMATED_TOKENS;
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
 *
 * @param messages  The slice of the conversation to summarize.
 * @param previousSummary  An earlier summary to fold in, so nothing is lost as
 *                         the covered range advances.
 */
export async function summarizeConversation(
  messages: Message[],
  previousSummary?: string,
): Promise<string> {
  const conversationText = messages
    .map((m) => {
      const header = `[${m.role}]`;
      const body = m.content ?? "(tool call)";
      return `${header} ${body}`;
    })
    .join("\n\n");

  const userContent = previousSummary
    ? `Here is the summary of the conversation so far:\n\n${previousSummary}\n\n` +
      `Fold the following newer messages into a single updated summary:\n\n${conversationText}`
    : `Please summarize this conversation:\n\n${conversationText}`;

  const summaryMessages: ChatMessage[] = [
    { role: "system", content: SUMMARIZE_SYSTEM_PROMPT },
    { role: "user", content: userContent },
  ];

  const response = await chat(summaryMessages);
  const content = response.choices[0]?.message?.content;

  if (!content) {
    throw new Error("Summarization returned empty response");
  }

  return content;
}
