// === OpenAI, over /v1/responses ===
//
// The `openai-responses` half of the contract in `./types.ts`. Everything this
// file knows that the Chat adapter does not is a property of the protocol, not
// of OpenAI: reasoning effort nests under `reasoning`, a tool call arrives as a
// `function_call` item keyed by `call_id`, and the items the model emitted have
// to be replayed verbatim on the next request of the same exchange.
//
// Plain `fetch` rather than the SDK, for the reason `services/openai.ts` gives
// at its own head: a 20-line wrapper is easier to pin to the documented request
// shape than a version range is.

import { OpenAIError } from "../openai.js";
import { providerKey } from "./keys.js";
import type {
  ChatRequest,
  ChatResponse,
  DiscoveredModel,
  NormalisedUsage,
  ProviderAdapter,
  ToolCall,
  Turn,
} from "./types.js";

/**
 * Read at call time, not at import.
 *
 * `services/openai.ts` freezes the same expression into a module constant, and
 * for that module the import graph guarantees `load-env.ts` ran first. An
 * adapter is built by a registry that a test imports directly, so freezing here
 * would bake in whatever the environment held when the registry was first
 * touched. Same variable and same default as the rest of the backend — a second
 * spelling of the base URL would be a second thing to configure.
 */
function baseUrl(): string {
  const base = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  return base.replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

interface ResponsesItem {
  type?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: Array<{ text?: string }>;
}

interface ResponsesPayload {
  model?: string;
  status?: string;
  incomplete_details?: { reason?: string };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
  };
  output?: ResponsesItem[];
  output_text?: string;
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/**
 * One `Turn` as the items the Responses API accepts back.
 *
 * Returns a LIST because `raw` is a list: it holds every item the model emitted
 * last time — the `reasoning` items included — and the API rejects a
 * `function_call_output` whose matching `function_call` and reasoning items are
 * not in front of it. Rebuilding an assistant turn from `content` alone would
 * drop exactly those, so `raw` wins whenever it is there.
 */
function toItems(turn: Turn): unknown[] {
  if (Array.isArray(turn.raw)) return [...turn.raw];

  if (turn.role === "tool") {
    return [
      {
        type: "function_call_output",
        call_id: turn.toolCallId ?? "",
        output: turn.content,
      },
    ];
  }

  return [{ role: turn.role, content: turn.content }];
}

function buildBody(request: ChatRequest): Record<string, unknown> {
  const input = request.turns.flatMap(toItems);

  const body: Record<string, unknown> = {
    model: request.model,
    input,
    max_output_tokens: request.maxOutputTokens,
  };

  if (request.tools?.length) {
    // Flat, not nested under `function`: that is the Responses/Realtime shape,
    // and the nested Chat spelling is accepted without error while exposing
    // zero tools to the model.
    body.tools = request.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
    body.tool_choice = "auto";
  }

  // Absent means "send nothing". A non-reasoning model rejects the field
  // outright, so an `effort: undefined` that still serialises the key is the
  // difference between a call and a 400.
  if (request.effort) body.reasoning = { effort: request.effort };

  return body;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function abortError(): Error {
  const err = new Error("A chamada ao modelo foi interrompida.");
  err.name = "AbortError";
  return err;
}

/**
 * One request, bounded by BOTH the caller's signal and this call's own timeout.
 *
 * The two are separate on purpose — see `ChatRequest.signal`. A local
 * `AbortController` is what lets one `fetch` be cancelled by either without the
 * caller's signal being aborted on its behalf, which would take down every
 * other call sharing it.
 */
async function send(
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
  { timeoutMs, signal }: { timeoutMs: number; signal?: AbortSignal },
): Promise<unknown> {
  if (signal?.aborted) throw abortError();

  const controller = new AbortController();
  const relay = () => controller.abort();
  signal?.addEventListener("abort", relay, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
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

    return JSON.parse(text);
  } catch (err) {
    if (err instanceof OpenAIError) throw err;
    // The caller's signal wins the race for the message: "the round was
    // cancelled" and "this call was too slow" are different diagnoses.
    if (signal?.aborted) throw abortError();
    if (err instanceof Error && err.name === "AbortError") {
      throw new OpenAIError(504, `A chamada ao modelo passou de ${timeoutMs}ms.`);
    }
    throw new OpenAIError(502, err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", relay);
  }
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

function textOf(payload: ResponsesPayload): string {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text;
  }
  const chunks: string[] = [];
  for (const item of payload.output ?? []) {
    if (item.type !== "message") continue;
    for (const part of item.content ?? []) {
      if (part.text) chunks.push(part.text);
    }
  }
  return chunks.join("\n").trim();
}

function toolCallsOf(payload: ResponsesPayload): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const item of payload.output ?? []) {
    if (item.type !== "function_call") continue;
    calls.push({
      // `call_id` verbatim, and `arguments` as the string it arrived as. Both
      // are contract, not preference — see `ToolCall` in `./types.ts`.
      id: item.call_id ?? "",
      name: item.name ?? "",
      arguments: item.arguments ?? "",
    });
  }
  return calls;
}

/**
 * Pass through, do not translate.
 *
 * The Responses vocabulary IS `NormalisedUsage` — that is why the contract
 * picked it — so the only work here is defaulting the counts a payload omitted.
 */
function usageOf(payload: ResponsesPayload): NormalisedUsage {
  const usage = payload.usage ?? {};
  const normalised: NormalisedUsage = {
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
  };
  const cached = usage.input_tokens_details?.cached_tokens;
  if (typeof cached === "number") {
    normalised.input_tokens_details = { cached_tokens: cached };
  }
  return normalised;
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

interface OpenAIModelItem {
  id?: string;
  created?: number;
  owned_by?: string;
}

/**
 * `GET /v1/models` answers `{object, data:[{id, object, created, owned_by}]}`
 * and nothing else — no context window, no output ceiling, no price, no
 * capability flags. Confirmed against the API reference for both `list` and
 * `retrieve`, which describe `created` as "The Unix timestamp (in seconds) when
 * the model was created".
 *
 * So four of the seven fields are `null`/`false` here by fact rather than by
 * oversight, and the one that hurts is `supports_tools`: every OpenAI model
 * discovered this way arrives without tools, because the catalogue does not say
 * and `DiscoveredModel` requires the safe answer when it does not. Guessing
 * true would fail the whole call on the first model that refuses them; guessing
 * false costs that thinker its sources and nothing else.
 */
function toDiscovered(item: OpenAIModelItem): DiscoveredModel | null {
  if (!item.id) return null;
  return {
    id: item.id,
    label: item.id,
    context_window: null,
    max_output_tokens: null,
    supports_tools: false,
    rate: null,
    released_at: isoFromEpochSeconds(item.created),
    provider: "openai",
  };
}

/**
 * Seconds, not milliseconds — the reference says so, and the catalogue agrees:
 * live ids read 1685232000…1786034890, which is 2023-05-28…2026-08-06 read as
 * seconds and 1970 read as milliseconds.
 */
export function isoFromEpochSeconds(seconds: number | undefined): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return null;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const openAIResponsesAdapter: ProviderAdapter = {
  provider: "openai",
  wire: "openai-responses",

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const payload = (await send(
      `${baseUrl()}/responses`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${providerKey("openai")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(buildBody(request)),
      },
      { timeoutMs: request.timeoutMs, signal: request.signal },
    )) as ResponsesPayload;

    return {
      // The answer's model, not the request's: an alias resolves to a dated
      // snapshot and the snapshot is what was billed.
      model: payload.model ?? request.model,
      text: textOf(payload),
      toolCalls: toolCallsOf(payload),
      usage: usageOf(payload),
      // Every item, not just the message. Dropping the reasoning items is the
      // documented way to break the next request of this exchange.
      raw: payload.output ?? [],
      // OpenAI never reports a charge. `null` means "fall back to the rate
      // card"; a `0` here would be stored as a real, free call.
      reportedUsd: null,
      // `incomplete_details.reason` is the specific answer ("max_output_tokens")
      // and `status` the generic one; report the specific when there is one.
      finishReason: payload.incomplete_details?.reason ?? payload.status,
    };
  },

  async listModels(signal?: AbortSignal): Promise<DiscoveredModel[]> {
    const payload = (await send(
      `${baseUrl()}/models`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${providerKey("openai")}` },
      },
      { timeoutMs: 30_000, signal },
    )) as { data?: OpenAIModelItem[] };

    const models: DiscoveredModel[] = [];
    for (const item of payload.data ?? []) {
      const model = toDiscovered(item);
      if (model) models.push(model);
    }
    return models;
  },
};
