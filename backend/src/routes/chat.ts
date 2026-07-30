import { Router, type Request, type Response } from "express";
import { writeFile, readFile } from "node:fs/promises";
import { extname } from "node:path";
import { v4 as uuidv4 } from "uuid";
import { chat, synthesize, type ChatMessage } from "../services/openrouter.js";
import { executeToolCall, parseToolArguments } from "../services/tool-executor.js";
import {
  appendMessages,
  getConversation,
  updateConversation,
} from "../services/storage.js";
import { buildTranscript } from "../services/transcript.js";
import {
  nextSummaryBoundary,
  readSummaryState,
  shouldSummarize,
  summarizeConversation,
} from "../services/summarizer.js";
import { TOOLS } from "../tools/index.js";
import { ensureDir, isUUID, validateAudioPath } from "../middleware/sandbox.js";
import type { Message, ToolCall } from "../types/index.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_TOOL_ITERATIONS = 5;

// Which container the TTS provider produced is decided at synthesis time, so
// the file extension — not a hardcoded audio/mpeg — drives the response type.
const AUDIO_MIME: Record<string, string> = {
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
};

const SYSTEM_PROMPT =
  "You are a helpful voice assistant. You have access to web research and the user's attached files. " +
  "Keep responses concise and conversational — they will be spoken aloud. Use tools when needed.";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isoNow(): string {
  return new Date().toISOString();
}

/**
 * Write one SSE event. Guards against writing after our own `end()`; a client
 * that hung up is detected separately via the `close` event, since Node only
 * sets `writableEnded` when *we* close the stream.
 */
function sendSSE(res: Response, data: object): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function endStream(res: Response): void {
  if (!res.writableEnded) res.end();
}

interface NodeError extends Error {
  code: string;
}

function isNodeError(err: unknown): err is NodeError {
  return err instanceof Error && "code" in err;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Router: POST /api/chat
// ---------------------------------------------------------------------------

const chatRouter = Router();

chatRouter.post("/", async (req: Request, res: Response, next) => {
  // Tracks whether SSE headers went out: past that point an error can only be
  // reported in-band, never as a JSON status response.
  let streaming = false;

  try {
    // ── 1. Validate and load ──────────────────────────────────────────────

    const { conversation_id, message } = req.body as {
      conversation_id?: string;
      message?: string;
    };

    if (
      !conversation_id ||
      typeof conversation_id !== "string" ||
      !isUUID(conversation_id)
    ) {
      res.status(400).json({ error: "Invalid conversation_id" });
      return;
    }

    const conv = await getConversation(conversation_id);
    if (!conv) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }

    // Add user message to conversation when provided
    if (
      message !== undefined &&
      typeof message === "string" &&
      message.trim().length > 0
    ) {
      const userMsg: Message = {
        id: uuidv4(),
        role: "user",
        content: message,
        timestamp: isoNow(),
      };
      // Append rather than write back the array we read: another turn may be
      // persisting its own messages at the same time.
      conv.messages = (await appendMessages(conversation_id, [userMsg])).messages;
    }

    // ── 2. Optionally summarize long conversations ──────────────────────

    const priorSummary = readSummaryState(conv.metadata);
    let summaryText = priorSummary?.summary;
    // Clamp: stale metadata (e.g. history edited on disk) must not point past
    // the end of the array and silently blank out the whole transcript.
    let covered = Math.min(priorSummary?.covered ?? 0, conv.messages.length);

    if (shouldSummarize(conv.messages, covered)) {
      const boundary = nextSummaryBoundary(conv.messages, covered);
      try {
        summaryText = await summarizeConversation(
          conv.messages.slice(covered, boundary),
          priorSummary?.summary,
        );
        covered = boundary;

        conv.metadata = {
          ...(conv.metadata || {}),
          summary: summaryText,
          summarized_count: covered,
        };
        await updateConversation(conversation_id, { metadata: conv.metadata });
      } catch (summarizeErr) {
        console.error(
          "Summarization failed, proceeding without a new summary:",
          errText(summarizeErr),
        );
      }
    }

    // ── 3. Build messages array for LLM ───────────────────────────────────

    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      ...(summaryText
        ? [
            {
              role: "system" as const,
              content: `[Previous conversation summary]: ${summaryText}`,
            },
          ]
        : []),
      // The invariant: [0, covered) is what the summary stands for, and
      // [covered, end) is replayed verbatim. Trimming this window any further
      // would drop messages that no summary covers yet. RECENT_MESSAGE_WINDOW
      // governs where the *next* summary stops, not what gets sent.
      ...buildTranscript(conv.messages.slice(covered)),
    ];

    // Set SSE response headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    streaming = true;

    let clientGone = false;
    res.on("close", () => {
      clientGone = true;
    });

    // ── 4. Tool calling loop (max 5 iterations) ───────────────────────────

    let content: string | null = null;

    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      if (clientGone) return;

      // On the final pass, withhold the tools so the model has to answer in
      // prose instead of leaving the turn with nothing to say.
      const availableTools = i === MAX_TOOL_ITERATIONS - 1 ? undefined : TOOLS;

      let response;
      try {
        response = await chat(messages, availableTools);
      } catch (chatErr) {
        sendSSE(res, { type: "error", error: `LLM error: ${errText(chatErr)}` });
        endStream(res);
        return;
      }

      const choice = response.choices[0]?.message;
      if (!choice) {
        sendSSE(res, { type: "error", error: "Empty LLM response" });
        endStream(res);
        return;
      }

      // Handle tool calls
      if (choice.tool_calls && choice.tool_calls.length > 0) {
        // Map OpenAI tool calls to our ToolCall shape
        const toolCalls: ToolCall[] = choice.tool_calls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: {
            name: tc.function.name as ToolCall["function"]["name"],
            arguments: tc.function.arguments,
          },
        }));

        // Push assistant message with tool_calls into the LLM transcript…
        messages.push({
          role: "assistant",
          content: choice.content,
          tool_calls: toolCalls,
        });

        // …and into the stored history, so a reload or a later turn can still
        // see what the assistant asked for.
        const historyBatch: Message[] = [
          {
            id: uuidv4(),
            role: "assistant",
            content: choice.content,
            tool_calls: toolCalls,
            timestamp: isoNow(),
          },
        ];

        // Execute each tool call and push tool result messages
        for (const tc of toolCalls) {
          // Arguments come from the model and are frequently malformed; a throw
          // here would land in the error handler with the stream already open.
          let parsedArgs: Record<string, unknown> = {};
          try {
            parsedArgs = parseToolArguments(tc.function.arguments);
          } catch {
            // executeToolCall reports the same problem back to the model below.
          }

          sendSSE(res, {
            type: "tool_call",
            tool: tc.function.name,
            args: parsedArgs,
          });

          let resultContent: string;
          try {
            const result = await executeToolCall(tc, conversation_id);
            resultContent = result.content;
          } catch (toolErr) {
            resultContent = `Error executing tool: ${errText(toolErr)}`;
          }

          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: resultContent,
          });

          historyBatch.push({
            id: uuidv4(),
            role: "tool",
            content: resultContent,
            tool_call_id: tc.id,
            timestamp: isoNow(),
          });
        }

        conv.messages = (
          await appendMessages(conversation_id, historyBatch)
        ).messages;

        // Continue loop for potential follow-up tool calls
        continue;
      }

      // No tool calls — we have a final content answer
      if (choice.content) {
        content = choice.content;
        break;
      }

      // Neither tool calls nor content (shouldn't happen, but be safe)
      sendSSE(res, { type: "error", error: "LLM returned empty response" });
      endStream(res);
      return;
    }

    if (!content) {
      sendSSE(res, {
        type: "error",
        error: "Max tool iterations reached without content",
      });
      endStream(res);
      return;
    }

    // ── 5. Send the text first — TTS can take seconds ─────────────────────

    sendSSE(res, { type: "content", text: content });

    // ── 6. Generate TTS ──────────────────────────────────────────────────

    const messageId = uuidv4();
    let audioUrl: string | undefined;

    try {
      await ensureDir(validateAudioPath(conversation_id));
      const audio = await synthesize(content);
      const audioFile = `${messageId}${audio.extension}`;
      await writeFile(
        validateAudioPath(conversation_id, audioFile),
        audio.buffer,
      );
      audioUrl = `/api/files/audio/${conversation_id}/${audioFile}`;
    } catch (ttsErr) {
      console.error("TTS failed:", errText(ttsErr));
      // Continue without audio — still return text
    }

    // ── 7. Save assistant message to storage ──────────────────────────────
    // Persisted even if the client hung up: the answer was paid for.

    const assistantMessage: Message = {
      id: messageId,
      role: "assistant",
      content,
      ...(audioUrl ? { audio_url: audioUrl } : {}),
      timestamp: isoNow(),
    };

    try {
      await appendMessages(conversation_id, [assistantMessage]);
    } catch (persistErr) {
      // The answer was already delivered to the client — a storage failure
      // (conversation deleted mid-turn, disk full) must not be reported as if
      // the reply itself had failed.
      console.error(
        "[chat] Answer delivered but not persisted:",
        errText(persistErr),
      );
    }

    // ── 8. Send final SSE events and end ──────────────────────────────────

    if (audioUrl) sendSSE(res, { type: "audio", url: audioUrl });
    sendSSE(res, { type: "done" });
    endStream(res);
  } catch (err) {
    if (streaming) {
      // Headers are already out — report in-band rather than letting the
      // JSON error handler throw ERR_HTTP_HEADERS_SENT.
      console.error("[chat] Failure mid-stream:", err);
      sendSSE(res, { type: "error", error: "Internal server error" });
      endStream(res);
      return;
    }
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Audio router: GET /:convId/:filename
// Mounted at /api/files/audio
// ---------------------------------------------------------------------------

const audioRouter = Router();

audioRouter.get("/:convId/:filename", async (req, res, next) => {
  try {
    const { convId, filename } = req.params;

    // validateAudioPath rejects non-UUID ids and anything that is not a single
    // plain path segment, so no traversal can reach the read below.
    const resolved = validateAudioPath(convId, filename);

    try {
      const data = await readFile(resolved);
      res.setHeader("Content-Type", AUDIO_MIME[extname(filename).toLowerCase()] ?? "application/octet-stream");
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.send(data);
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === "ENOENT") {
        res.status(404).json({ error: "Audio file not found" });
        return;
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export default chatRouter;
export { audioRouter };
