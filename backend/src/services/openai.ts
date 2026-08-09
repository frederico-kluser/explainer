// Thin HTTP layer over the two OpenAI surfaces this app needs:
//
//   1. Realtime  — minting the ephemeral client secret the browser uses to open
//                  its own WebRTC session. The standard API key never leaves
//                  this process.
//   2. Responses — the `web_search` hosted tool. The Realtime API does *not*
//                  expose web search (its only tool types are `function` and
//                  `mcp`), so search runs here and comes back as a function
//                  result.
//
// Plain `fetch` rather than the SDK: the realtime client-secrets endpoint moves
// faster than the npm package does, and a 20-line wrapper is easier to pin to
// the documented request shape than a version range is.

import { addCost } from "./costs.js";
import { priceTextResponse, ratesFor, type TextUsage } from "./pricing.js";
// Import cycle, and a safe one: `providers/keys.ts` imports `OpenAIError` from
// this module to build its own 500. Both references live inside function
// bodies, so each is read long after both module bodies finished evaluating —
// whichever of the two the process imports first, neither binding is touched in
// its temporal dead zone. Do not "fix" it by moving `OpenAIError` elsewhere:
// that is a rename across every module that catches it, for no runtime gain.
import { providerKey } from "./providers/keys.js";

const OPENAI_BASE = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

export const REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-2.1";
export const REALTIME_VOICE = process.env.OPENAI_REALTIME_VOICE || "marin";
export const SEARCH_MODEL = process.env.OPENAI_SEARCH_MODEL || "gpt-5.2";
export const TEXT_MODEL = process.env.OPENAI_TEXT_MODEL || "gpt-5.2-mini";

export class OpenAIError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "OpenAIError";
  }
}

/**
 * The calling key, resolved through the one resolver rather than from
 * `process.env` — so a key typed into the setup screen reaches the very next
 * request, including the mint of a realtime session, with no restart.
 *
 * Reading `process.env` here was the bug: the PUT stored the key, answered
 * `present: true`, and this function kept throwing "not set" at the user
 * looking at the key they had just saved.
 */
function apiKey(): string {
  return providerKey("openai");
}

async function request<T>(
  path: string,
  body: unknown,
  timeoutMs = 60_000,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${OPENAI_BASE}${path}`, {
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
      // OpenAI errors are JSON, but a gateway in front of it may not be.
      let detail = text.slice(0, 500);
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string } };
        if (parsed.error?.message) detail = parsed.error.message;
      } catch {
        // keep the raw body
      }
      throw new OpenAIError(response.status, detail);
    }

    return JSON.parse(text) as T;
  } catch (err) {
    if (err instanceof OpenAIError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new OpenAIError(504, `OpenAI request timed out after ${timeoutMs}ms`);
    }
    throw new OpenAIError(502, err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Realtime: ephemeral client secrets
// ---------------------------------------------------------------------------

/** The session config accepted by both `client_secrets` and `session.update`. */
export interface RealtimeSessionConfig {
  type: "realtime";
  model: string;
  instructions: string;
  output_modalities?: string[];
  audio?: Record<string, unknown>;
  tools?: unknown[];
  tool_choice?: string;
  [key: string]: unknown;
}

export interface ClientSecret {
  value: string;
  expires_at: number;
  session: Record<string, unknown>;
}

/**
 * Mint a short-lived token the browser can use to open its own WebRTC peer
 * connection to the realtime model.
 *
 * Everything that costs money or grants access — model, voice, instructions,
 * tool list — is fixed here, server-side. A tampered browser can burn the
 * session it was given, and nothing else.
 */
export async function mintRealtimeClientSecret(
  session: RealtimeSessionConfig,
  safetyIdentifier?: string,
): Promise<ClientSecret> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await fetch(`${OPENAI_BASE}/realtime/client_secrets`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        "Content-Type": "application/json",
        // A stable, privacy-preserving per-user id. The Realtime API binds it to
        // the token, so the browser never has to send it.
        ...(safetyIdentifier
          ? { "OpenAI-Safety-Identifier": safetyIdentifier }
          : {}),
      },
      body: JSON.stringify({ session }),
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
      throw new OpenAIError(response.status, detail);
    }

    return JSON.parse(text) as ClientSecret;
  } catch (err) {
    if (err instanceof OpenAIError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new OpenAIError(504, "Minting the realtime session timed out");
    }
    throw new OpenAIError(502, err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Responses: hosted web search
// ---------------------------------------------------------------------------

interface ResponsesPayload {
  status?: string;
  /** Why a non-`completed` response stopped. Only present when it did. */
  incomplete_details?: { reason?: string };
  model?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
  };
  output?: Array<{
    type?: string;
    content?: Array<{
      type?: string;
      text?: string;
      annotations?: Array<{ type?: string; url?: string; title?: string }>;
    }>;
  }>;
}

export interface WebSearchResult {
  text: string;
  citations: Array<{ title: string; url: string }>;
  /** Token usage, so the caller can put a price on the answer. */
  usage: TextUsage;
  model: string;
  /** How many hosted search calls were billed ($10 per 1000). */
  search_calls: number;
}

/**
 * Answer `query` from the live web using OpenAI's hosted `web_search` tool.
 *
 * Returns prose plus the `url_citation` annotations, because the model on the
 * other end is going to *speak* this: a synthesised answer with two or three
 * named sources reads aloud far better than ten raw search hits.
 */
export async function webSearch(
  query: string,
  { timeoutMs = 45_000 }: { timeoutMs?: number } = {},
): Promise<WebSearchResult> {
  const payload = await request<ResponsesPayload>(
    "/responses",
    {
      model: SEARCH_MODEL,
      tools: [{ type: "web_search" }],
      tool_choice: "auto",
      reasoning: { effort: "low" },
      max_output_tokens: 900,
      input:
        "Pesquise na web e responda de forma curta e objetiva, em portugues do Brasil, " +
        "em no maximo cinco frases, citando as fontes.\n\nPergunta: " +
        query,
    },
    timeoutMs,
  );

  const citations: Array<{ title: string; url: string }> = [];
  const chunks: string[] = [];
  let searchCalls = 0;

  for (const item of payload.output ?? []) {
    if (item.type === "web_search_call") {
      searchCalls += 1;
      continue;
    }
    if (item.type !== "message") continue;
    for (const part of item.content ?? []) {
      if (part.text) chunks.push(part.text);
      for (const annotation of part.annotations ?? []) {
        if (annotation.type === "url_citation" && annotation.url) {
          citations.push({
            title: annotation.title ?? annotation.url,
            url: annotation.url,
          });
        }
      }
    }
  }

  return {
    text: chunks.join("\n").trim(),
    citations,
    usage: payload.usage ?? {},
    model: payload.model ?? SEARCH_MODEL,
    search_calls: searchCalls,
  };
}

// ---------------------------------------------------------------------------
// Responses: plain text completion (titles, session re-seeding)
// ---------------------------------------------------------------------------

export interface CompleteTextOptions {
  maxTokens?: number;
  timeoutMs?: number;
  /**
   * Charge the call to this conversation. Omitted, the tokens are spent and
   * nothing is booked — which is what every call site did before this parameter
   * existed, and why the ledger under-reported.
   *
   * `conversationId` and pricing the call yourself are MUTUALLY EXCLUSIVE. Pass
   * the id OR read the returned `usage` and call `addCost` yourself. Both at
   * once double-books the charge.
   *
   * The id answers *who pays*; the returned `usage` answers *what happened*.
   * A caller that needs a `detail` of its own — per attempt, per retry — has to
   * book it itself, and therefore must not pass the id.
   */
  conversationId?: string;
}

/** What a one-shot completion actually produced, beyond the prose. */
export interface TextCompletion {
  text: string;
  /**
   * Always present; `{}` when the payload carried no usage at all.
   *
   * Never `undefined`, so a caller pricing the call can hand it straight to
   * `priceTextResponse` without a guard. `{}` prices to 0 — the same silent zero
   * an unpriced model gives, which is why the no-usage case is also warned about
   * when this call is booked here.
   */
  usage: TextUsage;
  /**
   * The model the provider says answered, which is not always the one asked
   * for — a dated snapshot id can come back for an alias. Pricing has to use
   * this one. Falls back to the requested `TEXT_MODEL` only when the payload
   * omits it entirely.
   */
  model: string;
  /** `"completed"` or `"incomplete"`. A 200 does not mean a whole answer. */
  status?: string;
  /**
   * The output hit `max_output_tokens` and the text is cut off mid-thought.
   *
   * Worth checking before storing the text as if it were a finished answer;
   * nothing about the HTTP response distinguishes the two.
   */
  truncated?: boolean;
}

/**
 * Book what a completion cost, from the `usage` the response carried.
 *
 * Mirrors `bookCost` in `mermaid.ts` on purpose, including both warnings: the
 * silent zero is this ledger's documented failure mode, and it has two doors —
 * a payload with no `usage`, and a model id the rate card has never heard of.
 * `OPENAI_TEXT_MODEL` makes the second one reachable by configuration.
 */
function bookCost(conversationId: string, payload: ResponsesPayload): void {
  if (!payload.usage) {
    console.warn(
      "[openai] completeText was not billed: the response carried no usage",
    );
    return;
  }

  const usage = payload.usage;
  const model = payload.model ?? TEXT_MODEL;
  if (!ratesFor(model)) {
    console.warn(
      `[openai] model "${model}" is not on the rate card; this completion books usd=0`,
    );
  }

  // Fire and forget: `addCost` swallows its own storage failures, and a summary
  // must not wait on the ledger.
  void addCost(conversationId, {
    source: "text",
    usd: priceTextResponse(model, usage),
    detail: `completeText (${model})`,
    tokens: {
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cached: usage.input_tokens_details?.cached_tokens ?? 0,
    },
  });
}

/**
 * One-shot text completion. Used for conversation titles and summaries.
 *
 * Returns the token counts alongside the prose rather than only the prose:
 * without them `priceTextResponse` has nothing to price and answers 0, so a
 * caller that books its own charge would report a free call. Passing
 * `conversationId` books it here instead — see that option for why the two are
 * mutually exclusive.
 */
export async function completeText(
  prompt: string,
  { maxTokens = 400, timeoutMs = 30_000, conversationId }: CompleteTextOptions = {},
): Promise<TextCompletion> {
  const payload = await request<ResponsesPayload>(
    "/responses",
    {
      model: TEXT_MODEL,
      input: prompt,
      max_output_tokens: maxTokens,
    },
    timeoutMs,
  );

  // The raw payload, not the normalised usage below: `bookCost` distinguishes
  // "no usage at all" (worth a warning) from zeroed counts, and `{}` would
  // erase that difference.
  if (conversationId) bookCost(conversationId, payload);

  const chunks: string[] = [];
  for (const item of payload.output ?? []) {
    if (item.type !== "message") continue;
    for (const part of item.content ?? []) {
      if (part.text) chunks.push(part.text);
    }
  }

  return {
    text: chunks.join("\n").trim(),
    usage: payload.usage ?? {},
    model: payload.model ?? TEXT_MODEL,
    status: payload.status,
    truncated: payload.incomplete_details?.reason === "max_output_tokens",
  };
}
