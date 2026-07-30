import { Router, type Request, type Response } from "express";
import { writeFile, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import { v4 as uuidv4 } from "uuid";
import { chat, synthesize, type ChatMessage } from "../services/openrouter.js";
import { executeToolCall } from "../services/tool-executor.js";
import { getConversation, updateConversation } from "../services/storage.js";
import { TOOLS } from "../tools/index.js";
import { ensureDir } from "../middleware/sandbox.js";
import type { Message, ToolCall } from "../types/index.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_TOOL_ITERATIONS = 5;
const UUID_RE = /^[a-f0-9-]{36}$/;
const AUDIO_DIR = resolve(
  homedir(),
  ".local",
  "share",
  "voice-assistant",
  "audio",
);

const SYSTEM_PROMPT =
  "You are a helpful voice assistant. You have access to web research and the user's attached files. " +
  "Keep responses concise and conversational — they will be spoken aloud. Use tools when needed.";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isoNow(): string {
  return new Date().toISOString();
}

function sendSSE(res: Response, data: object): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

interface NodeError extends Error {
  code: string;
}

function isNodeError(err: unknown): err is NodeError {
  return err instanceof Error && "code" in err;
}

// ---------------------------------------------------------------------------
// Router: POST /api/chat
// ---------------------------------------------------------------------------

const chatRouter = Router();

chatRouter.post("/", async (req: Request, res: Response, next) => {
  try {
    // ── 1. Validate and load ──────────────────────────────────────────────

    const { conversation_id, message } = req.body as {
      conversation_id?: string;
      message?: string;
    };

    if (
      !conversation_id ||
      typeof conversation_id !== "string" ||
      !UUID_RE.test(conversation_id)
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
      conv.messages.push(userMsg);
      await updateConversation(conversation_id, { messages: conv.messages });
    }

    // ── 2. Build messages array for LLM ───────────────────────────────────

    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      ...conv.messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
        ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      })),
    ];

    // Set SSE response headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    // ── 3. Tool calling loop (max 5 iterations) ───────────────────────────

    let content: string | null = null;

    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      let response;
      try {
        response = await chat(messages, TOOLS);
      } catch (chatErr) {
        const msg =
          chatErr instanceof Error ? chatErr.message : String(chatErr);
        sendSSE(res, { type: "error", error: `LLM error: ${msg}` });
        res.end();
        return;
      }

      const choice = response.choices[0]?.message;
      if (!choice) {
        sendSSE(res, { type: "error", error: "Empty LLM response" });
        res.end();
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

        // Push assistant message with tool_calls into the LLM transcript
        messages.push({
          role: "assistant",
          content: choice.content,
          tool_calls: toolCalls,
        });

        // Execute each tool call and push tool result messages
        for (const tc of toolCalls) {
          const parsedArgs = JSON.parse(tc.function.arguments);

          sendSSE(res, {
            type: "tool_call",
            tool: tc.function.name,
            args: parsedArgs,
          });

          try {
            const result = await executeToolCall(tc, conversation_id);
            messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: result.content,
            });
          } catch (toolErr) {
            const errMsg =
              toolErr instanceof Error ? toolErr.message : String(toolErr);
            messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: `Error executing tool: ${errMsg}`,
            });
          }
        }

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
      res.end();
      return;
    }

    if (!content) {
      sendSSE(res, {
        type: "error",
        error: "Max tool iterations reached without content",
      });
      res.end();
      return;
    }

    // ── 4. Generate TTS ──────────────────────────────────────────────────

    const messageId = uuidv4();
    let audioUrl: string | undefined;

    try {
      await ensureDir(resolve(AUDIO_DIR, conversation_id));
      const audioBuffer = await synthesize(content);
      const audioPath = resolve(AUDIO_DIR, conversation_id, `${messageId}.mp3`);
      await writeFile(audioPath, audioBuffer);
      audioUrl = `/api/files/audio/${conversation_id}/${messageId}.mp3`;
      sendSSE(res, { type: "audio", url: audioUrl });
    } catch (ttsErr) {
      console.error(
        "TTS failed:",
        ttsErr instanceof Error ? ttsErr.message : String(ttsErr),
      );
      // Continue without audio — still return text
    }

    // ── 5. Save assistant message to storage ──────────────────────────────

    const assistantMessage: Message = {
      id: messageId,
      role: "assistant",
      content,
      audio_url: audioUrl,
      timestamp: isoNow(),
    };
    conv.messages.push(assistantMessage);
    await updateConversation(conversation_id, { messages: conv.messages });

    // ── 6. Send final SSE events and end ──────────────────────────────────

    sendSSE(res, { type: "content", text: content });
    sendSSE(res, { type: "done" });
    res.end();
  } catch (err) {
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

    if (!UUID_RE.test(convId)) {
      res.status(400).json({ error: "Invalid conversation ID" });
      return;
    }

    if (filename.includes("/") || filename.includes("..")) {
      res.status(400).json({ error: "Invalid filename" });
      return;
    }

    const resolved = resolve(AUDIO_DIR, convId, filename);
    const audioRoot = resolve(AUDIO_DIR);

    // Prevent path traversal
    if (!resolved.startsWith(audioRoot + sep) && resolved !== audioRoot) {
      res.status(403).json({ error: "Path escape detected" });
      return;
    }

    try {
      const data = await readFile(resolved);
      res.setHeader("Content-Type", "audio/mpeg");
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
