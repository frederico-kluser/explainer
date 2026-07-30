import { createReadStream } from "node:fs";
import OpenAI from "openai";
import type { Message } from "../types/index.js";

// ---------------------------------------------------------------------------
// Lazy-initialized OpenAI client pointed at OpenRouter
// ---------------------------------------------------------------------------

let _client: OpenAI | null = null;

const client = (): OpenAI => {
  if (!_client) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error(
        "OPENROUTER_API_KEY is not set. Provide it via environment variable.",
      );
    }
    _client = new OpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey,
      defaultHeaders: {
        "HTTP-Referer": "http://localhost:5173",
        "X-Title": "Voice Assistant",
      },
    });
  }
  return _client;
};

// ---------------------------------------------------------------------------
// 1. transcribe – STT via OpenRouter Whisper
// ---------------------------------------------------------------------------

export async function transcribe(audioPath: string): Promise<string> {
  try {
    const audioStream = createReadStream(audioPath);
    const response = await client().audio.transcriptions.create({
      // FileLike is overly strict in TS; ReadStream works at runtime.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      file: audioStream as any,
      model: "openai/whisper-large-v3",
    });
    return response.text;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`STT transcription failed: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// 2. chat – non-streaming LLM call (DeepSeek V4 Pro)
// ---------------------------------------------------------------------------

export type ChatMessage = Pick<
  Message,
  "content" | "tool_calls" | "tool_call_id"
> & {
  role: "user" | "assistant" | "tool" | "system";
};

export async function chat(
  messages: ChatMessage[],
  tools?: OpenAI.Chat.Completions.ChatCompletionTool[],
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  try {
    const completion = await client().chat.completions.create({
      model: "deepseek/deepseek-chat-v4-pro",
      messages: messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      tools,
      stream: false,
    });
    return completion;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`LLM chat failed: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// 3. synthesize – TTS with fallback
// ---------------------------------------------------------------------------

const TTS_MODELS = [
  "mistral/mistral-tts",
  "google/gemini-flash-tts",
] as const;

export async function synthesize(text: string): Promise<Buffer> {
  let lastError: Error | null = null;

  for (const model of TTS_MODELS) {
    try {
      const response = await client().audio.speech.create({
        model,
        input: text,
        voice: "alloy",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      lastError = new Error(`TTS model "${model}" failed: ${message}`);
    }
  }

  throw new Error(
    `TTS synthesis failed for all models: ${lastError?.message ?? "unknown error"}`,
  );
}

// ---------------------------------------------------------------------------
// 4. chatStream – stub for future streaming use
// ---------------------------------------------------------------------------

export async function chatStream(
  messages: ChatMessage[],
  tools?: OpenAI.Chat.Completions.ChatCompletionTool[],
): Promise<ReadableStream<Uint8Array>> {
  try {
    const stream = await client().chat.completions.create({
      model: "deepseek/deepseek-chat-v4-pro",
      messages: messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      tools,
      stream: true,
    });
    // stream is a ReadableStream (SSE) from the OpenAI client
    return stream.toReadableStream();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`LLM streaming failed: ${message}`);
  }
}
