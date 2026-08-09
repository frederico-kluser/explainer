// === OpenAI-compatible /chat/completions ===
//
// The `openai-chat` half of the contract in `./types.ts`, shared by OpenRouter
// and DeepSeek. A factory rather than two files because the two differ in
// exactly three values — base URL, extra headers, extra body — and nothing
// else; a second hand-written copy would be a second place for the usage
// mapping below to rot.
//
// That mapping is the reason this file needs care. The Chat wire reports tokens
// as `prompt_tokens`/`completion_tokens`, `NormalisedUsage` is the Responses
// vocabulary, and `priceTextResponse` reads only the latter. Translating wrong
// does not throw: the counts are still in the object under their Chat names, so
// nothing looks empty, and the money silently reads $0.

import { OpenAIError } from "../openai.js";
import { providerKey, providerKeyPresent } from "./keys.js";
import { isoFromEpochSeconds } from "./openai-responses.js";
import type { ThinkerProvider } from "../../types/thinker-roster.js";
import type {
  ChatRequest,
  ChatResponse,
  DiscoveredModel,
  NormalisedUsage,
  ProviderAdapter,
  ToolCall,
  Turn,
} from "./types.js";

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

interface WireToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface WireMessage {
  role?: string;
  content?: string | null;
  tool_calls?: WireToolCall[];
}

interface ChatPayload {
  model?: string;
  choices?: Array<{ message?: WireMessage; finish_reason?: string }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    /** OpenRouter only, in USD. Absent everywhere else — see `reportedUsd`. */
    cost?: number;
  };
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/**
 * One `Turn` as the message this wire accepts back.
 *
 * `raw` wins when it is there, and on this wire it holds the assistant message
 * that carried `tool_calls`. That message has to be replayed exactly before the
 * `tool` messages answering it; rebuilding it from the neutral fields drops
 * whatever the provider added to it — a `reasoning_content` block, a refusal,
 * a provider-specific id.
 */
function toMessage(turn: Turn): unknown {
  if (turn.raw !== undefined && turn.raw !== null) return turn.raw;

  if (turn.role === "tool") {
    return {
      role: "tool",
      tool_call_id: turn.toolCallId ?? "",
      content: turn.content,
    };
  }

  if (turn.role === "assistant" && turn.toolCalls?.length) {
    return {
      role: "assistant",
      content: turn.content,
      tool_calls: turn.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        // `arguments` goes back out as the string it came in as. It is not
        // re-serialised anywhere on this path, so malformed JSON stays the
        // caller's problem to diagnose rather than becoming a throw in here.
        function: { name: call.name, arguments: call.arguments },
      })),
    };
  }

  return { role: turn.role, content: turn.content };
}

function buildBody(
  request: ChatRequest,
  extraBody: Record<string, unknown>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ...extraBody,
    model: request.model,
    messages: request.turns.map(toMessage),
    // `max_tokens` here, `max_output_tokens` on the Responses wire. Same cap,
    // different spelling.
    max_tokens: request.maxOutputTokens,
  };

  if (request.tools?.length) {
    // Nested under `function` — the Chat spelling, and the mirror image of the
    // flat shape the Responses wire wants.
    body.tools = request.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
    body.tool_choice = "auto";
  }

  // Root level on this wire, and omitted entirely when undefined: a
  // non-reasoning model rejects the field rather than ignoring it.
  if (request.effort) body.reasoning_effort = request.effort;

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

/** Bounded by BOTH the caller's signal and this call's own timeout. */
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

function toolCallsOf(message: WireMessage): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const call of message.tool_calls ?? []) {
    calls.push({
      // `id` verbatim — the provider matches the result to the call by exact
      // string, so a re-minted id orphans the result and the model answers as
      // if the tool never ran.
      id: call.id ?? "",
      name: call.function?.name ?? "",
      // The raw JSON string, never pre-parsed. See `ToolCall` in `./types.ts`.
      arguments: call.function?.arguments ?? "",
    });
  }
  return calls;
}

/**
 * THE mapping. Chat vocabulary in, Responses vocabulary out.
 *
 * `prompt_tokens` → `input_tokens`, `completion_tokens` → `output_tokens`,
 * `prompt_tokens_details.cached_tokens` → `input_tokens_details.cached_tokens`.
 * Forgetting any of the three reports $0 for a call that was really billed,
 * without failing — which is why `provider-adapters.test.ts` pins it directly
 * rather than only through a priced assertion.
 */
function usageOf(payload: ChatPayload): NormalisedUsage {
  const usage = payload.usage ?? {};
  const normalised: NormalisedUsage = {
    input_tokens: usage.prompt_tokens ?? 0,
    output_tokens: usage.completion_tokens ?? 0,
  };
  const cached = usage.prompt_tokens_details?.cached_tokens;
  if (typeof cached === "number") {
    normalised.input_tokens_details = { cached_tokens: cached };
  }
  return normalised;
}

/**
 * What the provider said it charged, or `null` when it said nothing.
 *
 * OpenRouter puts a real figure in `usage.cost` — the charge for the model it
 * actually routed to, which beats any local estimate. DeepSeek reports no cost
 * at all. `null` is never coerced to `0`: once stored, a zero is
 * indistinguishable from a call that really was free.
 */
function reportedUsdOf(payload: ChatPayload): number | null {
  const cost = payload.usage?.cost;
  return typeof cost === "number" && Number.isFinite(cost) ? cost : null;
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

interface CatalogueItem {
  id?: string;
  name?: string;
  created?: number;
  context_length?: number;
  supported_parameters?: string[];
  pricing?: Record<string, string | number | undefined>;
  top_provider?: { context_length?: number; max_completion_tokens?: number };
}

/**
 * A catalogue price, converted into the unit `DiscoveredModel.rate` declares.
 *
 * OpenRouter publishes decimal STRINGS in USD **per token** — `openai/gpt-5.2`
 * reads `"0.00000175"`, and `pricing.ts` already records that times 1e6 this is
 * 1.75, exactly the number the static rate card carries for that model. So the
 * conversion into USD per 1M tokens is a single multiplication, and it belongs
 * here rather than at the call site that would forget it.
 *
 * A NEGATIVE value is a sentinel, not a price: the five `openrouter/auto*` and
 * router models publish `"-1"` because the real price depends on which model the
 * router picks. That becomes `null` — "no published price" — because a negative
 * rate would flow straight into the ledger as a negative charge. `"0"` is left
 * alone: the 17 `:free` models really do cost zero, and that is a published
 * price rather than a missing one.
 */
function usdPerMillion(raw: string | number | undefined): number | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  if (typeof raw === "string" && raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return null;
  return value * 1_000_000;
}

function rateOf(item: CatalogueItem): DiscoveredModel["rate"] {
  const pricing = item.pricing;
  if (!pricing) return null;

  const input = usdPerMillion(pricing.prompt);
  const output = usdPerMillion(pricing.completion);
  if (input === null || output === null) return null;

  return {
    input,
    // 165 of 400 models publish no `input_cache_read`. Falling back to the full
    // input rate says "no cache discount", which is the truth for a provider
    // that does not offer one; falling back to 0 would claim cached input is
    // free and under-bill every cache hit.
    cached_input: usdPerMillion(pricing.input_cache_read) ?? input,
    output,
  };
}

/**
 * One catalogue entry, from either shape this wire serves.
 *
 * Both are read by one parser because DeepSeek's is OpenRouter's minus almost
 * everything: `GET https://api.deepseek.com/v1/models` answers
 * `{object, data:[{id, object, owned_by}]}` — no `created`, no context length,
 * no pricing, no capability list — so its models land here with `released_at`
 * null, `rate` null and `supports_tools` false, all by fact rather than by
 * oversight. Nothing branches on the provider; a field is read when it is there.
 */
function toDiscovered(item: CatalogueItem, provider: ThinkerProvider): DiscoveredModel | null {
  if (!item.id) return null;

  return {
    id: item.id,
    label: item.name ?? item.id,
    context_window: item.context_length ?? item.top_provider?.context_length ?? null,
    max_output_tokens: item.top_provider?.max_completion_tokens ?? null,
    // `supported_parameters` is where OpenRouter says whether a model accepts
    // tools at all — 333 of 400 list "tools", 67 do not. An absent array means
    // the provider did not say, which the contract answers with false.
    supports_tools: (item.supported_parameters ?? []).includes("tools"),
    rate: rateOf(item),
    released_at: isoFromEpochSeconds(item.created),
    provider,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface ChatAdapterConfig {
  provider: ThinkerProvider;
  /** No trailing slash; the adapter appends `/chat/completions` and `/models`. */
  baseUrl: string;
  /** Merged into every request's headers. */
  headers?: Record<string, string>;
  /** Merged into every chat body, under the explicit fields. */
  extraBody?: Record<string, unknown>;
}

export function createOpenAIChatAdapter(config: ChatAdapterConfig): ProviderAdapter {
  const base = config.baseUrl.replace(/\/+$/, "");
  const extraHeaders = config.headers ?? {};
  const extraBody = config.extraBody ?? {};

  return {
    provider: config.provider,
    wire: "openai-chat",

    async chat(request: ChatRequest): Promise<ChatResponse> {
      const payload = (await send(
        `${base}/chat/completions`,
        {
          method: "POST",
          headers: {
            ...extraHeaders,
            Authorization: `Bearer ${providerKey(config.provider)}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(buildBody(request, extraBody)),
        },
        { timeoutMs: request.timeoutMs, signal: request.signal },
      )) as ChatPayload;

      const choice = payload.choices?.[0];
      const message = choice?.message ?? {};

      return {
        // OpenRouter reroutes, so the model that answered is not always the one
        // asked for — and the one that answered is the one that was billed.
        model: payload.model ?? request.model,
        text: message.content ?? "",
        toolCalls: toolCallsOf(message),
        usage: usageOf(payload),
        // The assistant message itself, to be replayed verbatim ahead of the
        // `tool` messages that answer its calls.
        raw: choice?.message ?? null,
        reportedUsd: reportedUsdOf(payload),
        finishReason: choice?.finish_reason,
      };
    },

    async listModels(signal?: AbortSignal): Promise<DiscoveredModel[]> {
      const payload = (await send(
        `${base}/models`,
        {
          method: "GET",
          headers: {
            ...extraHeaders,
            // OMITTED, not empty, when no key is configured — and that is the
            // whole point. `GET https://openrouter.ai/api/v1/models` answers
            // 200 to a request carrying no authentication at all (measured: 400
            // models, no headers), so the catalogue is readable before anyone
            // has typed a key. `providerKey` THROWS a 500 when the key is
            // missing, so asking for it unconditionally emptied the model
            // picker on exactly the machine that still needed to be set up —
            // the one about to ask the operator for that key.
            //
            // The header still goes out whenever there IS one: OpenRouter rate
            // limits an anonymous caller first, and DeepSeek's catalogue
            // requires the key outright. `Bearer ` with an empty key would be
            // worse than no header, because the 401 it earns reads like a
            // revoked key rather than a missing one.
            ...(providerKeyPresent(config.provider)
              ? { Authorization: `Bearer ${providerKey(config.provider)}` }
              : {}),
          },
        },
        { timeoutMs: 30_000, signal },
      )) as { data?: CatalogueItem[] };

      const models: DiscoveredModel[] = [];
      for (const item of payload.data ?? []) {
        const model = toDiscovered(item, config.provider);
        if (model) models.push(model);
      }
      return models;
    },
  };
}

export const openRouterAdapter = createOpenAIChatAdapter({
  provider: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  headers: {
    // OpenRouter attributes traffic by these two and shows them on the app
    // leaderboard. Neither is authentication; both are optional to the API and
    // sent because a request with no identity is the one that gets rate-limited
    // first.
    "HTTP-Referer": "https://github.com/ondokai/explainer",
    "X-Title": "Explainer",
  },
  extraBody: {
    // OpenRouter's current docs call this deprecated and say usage now comes
    // back on every response regardless. Kept because it is documented as
    // having no effect rather than as rejected, so it stays harmless where it
    // is ignored and still works against a gateway on the older behaviour —
    // and `reportedUsd` going quiet is a silent loss of the one real cost
    // figure any provider gives us.
    usage: { include: true },
  },
});

export const deepSeekAdapter = createOpenAIChatAdapter({
  provider: "deepseek",
  // The `v1` here is the API version and has nothing to do with the model
  // version, per DeepSeek's own docs.
  baseUrl: "https://api.deepseek.com/v1",
});
