// Thin HTTP layer over the DeepSeek API (OpenAI-compatible chat completions).
//
// Three surfaces:
//   1. deepseekChat        — standard non-streaming chat. Used for intent
//                            classification and direct generation.
//   2. deepseekChatStream  — streaming chat via SSE. Used for streaming
//                            responses to the frontend.
//   3. deepseekReasoner    — reasoning model with tool calling. Used for the
//                            ReAct loop. Returns the full response including
//                            thinking tokens and any tool calls.
//
// Plain fetch rather than an SDK: the API is OpenAI-compatible, so a thin
// wrapper over fetch is simpler and avoids an extra dependency.

import type {
  DeepSeekMessage,
  DeepSeekOptions,
  DeepSeekResponse,
  DeepSeekReasonerResponse,
  DeepSeekStreamChunk,
  DeepSeekTool,
} from "../types/index.js";
import { priceTextResponse } from "./pricing.js";
import { addCost } from "./costs.js";

const DEEPSEEK_BASE = "https://api.deepseek.com/v1";
const DEFAULT_CHAT_MODEL = "deepseek-chat";
const DEFAULT_REASONER_MODEL = "deepseek-reasoner";
const DEFAULT_MAX_TOKENS_CHAT = 4096;
const DEFAULT_MAX_TOKENS_REASONER = 8192;
const DEFAULT_TIMEOUT_MS = 120_000;

export class DeepSeekError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "DeepSeekError";
  }
}

function apiKey(): string {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) {
    throw new DeepSeekError(500, "DEEPSEEK_API_KEY is not set on the server");
  }
  return key;
}

// ---------------------------------------------------------------------------
// Internal: typed fetch wrapper
// ---------------------------------------------------------------------------

interface ChatCompletionPayload {
  model: string;
  messages: DeepSeekMessage[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  tools?: DeepSeekTool[];
}

async function request<T>(
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${DEEPSEEK_BASE}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await response.text();
    if (!response.ok) {
      let detail = text.slice(0, 500);
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string } };
        if (parsed.error?.message) detail = parsed.error.message;
      } catch {
        // keep the raw body
      }
      throw new DeepSeekError(response.status, detail);
    }

    return JSON.parse(text) as T;
  } catch (err) {
    if (err instanceof DeepSeekError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new DeepSeekError(
        504,
        `DeepSeek request timed out after ${timeoutMs}ms`,
      );
    }
    throw new DeepSeekError(
      502,
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Internal: execute a request with a single retry on 5xx errors
// ---------------------------------------------------------------------------

async function withRetry<T>(
  fn: () => Promise<T>,
  retries = 1,
): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries) throw err;
      if (err instanceof DeepSeekError && err.status >= 500 && err.status < 600) {
        // Wait a tick before retrying so a transient outage has a chance to resolve.
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }
      throw err;
    }
  }
  // Unreachable — the final iteration always either returns or throws.
  throw new DeepSeekError(500, "Unexpected retry exhaustion");
}

// ---------------------------------------------------------------------------
// Internal: record the cost of a DeepSeek call
// ---------------------------------------------------------------------------

function recordCost(
  conversationId: string | undefined,
  model: string,
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number },
  detail: string,
): void {
  if (!conversationId) return;

  const usd = priceTextResponse(model, {
    input_tokens: usage.prompt_tokens,
    output_tokens: usage.completion_tokens,
  });

  // Fire-and-forget — cost bookkeeping must never block the caller.
  addCost(conversationId, {
    source: "text",
    usd,
    detail,
    tokens: {
      input: usage.prompt_tokens,
      output: usage.completion_tokens,
    },
  }).catch((err) => {
    console.warn(
      "[deepseek] Could not record cost:",
      err instanceof Error ? err.message : String(err),
    );
  });
}

// ---------------------------------------------------------------------------
// 1. Standard chat completion (non-streaming)
// ---------------------------------------------------------------------------

export interface DeepSeekChatResult {
  message: DeepSeekMessage;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  finishReason: string;
  model: string;
  id: string;
}

/**
 * Standard chat completion — single request, single response.
 *
 * Used for intent classification and direct generation where streaming is not
 * needed and the caller wants the full answer before continuing.
 */
export async function deepseekChat(
  messages: DeepSeekMessage[],
  options?: DeepSeekOptions & { conversationId?: string },
): Promise<DeepSeekChatResult> {
  const model = options?.model ?? DEFAULT_CHAT_MODEL;
  const maxTokens = options?.max_tokens ?? DEFAULT_MAX_TOKENS_CHAT;
  const timeoutMs = DEFAULT_TIMEOUT_MS;

  const payload: ChatCompletionPayload = {
    model,
    messages,
    max_tokens: maxTokens,
    temperature: options?.temperature,
  };

  const data = await withRetry(() =>
    request<DeepSeekResponse>("/chat/completions", payload, timeoutMs),
  );

  const choice = data.choices[0];
  if (!choice) {
    throw new DeepSeekError(502, "DeepSeek returned no choices");
  }

  recordCost(
    options?.conversationId,
    model,
    data.usage,
    "deepseekChat",
  );

  return {
    message: choice.message,
    usage: data.usage,
    finishReason: choice.finish_reason,
    model,
    id: data.id,
  };
}

// ---------------------------------------------------------------------------
// 2. Streaming chat completion
// ---------------------------------------------------------------------------

export interface DeepSeekStreamResult {
  content: string;
  finishReason: string | null;
  model: string;
}

/**
 * Streaming chat completion — yields chunks as they arrive.
 *
 * Used for streaming responses to the frontend so the user sees text appear
 * token by token instead of waiting for the full response.
 */
export async function* deepseekChatStream(
  messages: DeepSeekMessage[],
  options?: DeepSeekOptions,
): AsyncGenerator<DeepSeekStreamChunk> {
  const model = options?.model ?? DEFAULT_CHAT_MODEL;
  const maxTokens = options?.max_tokens ?? DEFAULT_MAX_TOKENS_CHAT;
  const timeoutMs = DEFAULT_TIMEOUT_MS;

  const payload: ChatCompletionPayload = {
    model,
    messages,
    max_tokens: maxTokens,
    temperature: options?.temperature,
    stream: true,
  };

  // Streaming bypasses the shared request() helper because the response body
  // must be read as a stream rather than as a single JSON parse.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      throw new DeepSeekError(
        504,
        `DeepSeek stream request timed out after ${timeoutMs}ms`,
      );
    }
    throw new DeepSeekError(
      502,
      err instanceof Error ? err.message : String(err),
    );
  }

  if (!response.ok) {
    clearTimeout(timer);
    const text = await response.text();
    let detail = text.slice(0, 500);
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } };
      if (parsed.error?.message) detail = parsed.error.message;
    } catch {
      // keep the raw body
    }
    throw new DeepSeekError(response.status, detail);
  }

  if (!response.body) {
    clearTimeout(timer);
    throw new DeepSeekError(502, "DeepSeek stream response has no body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // Track usage for cost recording once the stream ends.
  let promptTokens = 0;
  let completionTokens = 0;
  let streamDone = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      // The last element may be incomplete; keep it in the buffer.
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) continue;

        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") {
          streamDone = true;
          break;
        }

        let chunk: DeepSeekStreamChunk;
        try {
          chunk = JSON.parse(data) as DeepSeekStreamChunk;
        } catch {
          // Skip unparseable lines — some proxies inject keep-alive comments.
          continue;
        }

        // Accumulate usage from the final chunk (which carries usage info).
        const usage = (chunk as unknown as Record<string, unknown>).usage as
          | { prompt_tokens?: number; completion_tokens?: number }
          | undefined;
        if (usage?.prompt_tokens) promptTokens = usage.prompt_tokens;
        if (usage?.completion_tokens) completionTokens = usage.completion_tokens;

        yield chunk;
      }

      if (streamDone) break;
    }
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }

  // Record cost after the stream completes.
  if (promptTokens > 0 || completionTokens > 0) {
    const usd = priceTextResponse(model, {
      input_tokens: promptTokens,
      output_tokens: completionTokens,
    });
    addCost("", {
      source: "text",
      usd,
      detail: "deepseekChatStream",
      tokens: { input: promptTokens, output: completionTokens },
    }).catch((err) => {
      console.warn(
        "[deepseek] Could not record stream cost:",
        err instanceof Error ? err.message : String(err),
      );
    });
  }
}

// ---------------------------------------------------------------------------
// 3. Reasoning model with tool calling
// ---------------------------------------------------------------------------

export interface DeepSeekReasonerResult {
  message: DeepSeekReasonerResponse["choices"][0]["message"];
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  finishReason: string;
  model: string;
  id: string;
}

/**
 * Reasoning model completion with optional tool calling.
 *
 * Used for the ReAct loop. The reasoner produces thinking tokens
 * (reasoning_content) before the final answer, and may request tool calls.
 */
export async function deepseekReasoner(
  messages: DeepSeekMessage[],
  tools?: DeepSeekTool[],
  options?: DeepSeekOptions & { conversationId?: string },
): Promise<DeepSeekReasonerResult> {
  const model = options?.model ?? DEFAULT_REASONER_MODEL;
  const maxTokens = options?.max_tokens ?? DEFAULT_MAX_TOKENS_REASONER;
  const timeoutMs = DEFAULT_TIMEOUT_MS;

  const payload: ChatCompletionPayload = {
    model,
    messages,
    max_tokens: maxTokens,
    temperature: options?.temperature,
    ...(tools && tools.length > 0 ? { tools } : {}),
  };

  const data = await withRetry(() =>
    request<DeepSeekReasonerResponse>("/chat/completions", payload, timeoutMs),
  );

  const choice = data.choices[0];
  if (!choice) {
    throw new DeepSeekError(502, "DeepSeek reasoner returned no choices");
  }

  recordCost(
    options?.conversationId,
    model,
    data.usage,
    "deepseekReasoner",
  );

  return {
    message: choice.message,
    usage: data.usage,
    finishReason: choice.finish_reason,
    model,
    id: data.id,
  };
}
