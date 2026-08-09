// === The provider contract ===
//
// One interface, two adapters: `/v1/responses` (OpenAI) and OpenAI-compatible
// `/chat/completions` (OpenRouter, DeepSeek). Everything above this line — the
// roster, the fan-out, the budgeter — is written against these types and never
// learns which wire is in play.
//
// Types only, like `types/thinker-roster.ts` and `types/deep-tools.ts`:
// behaviour here would make this a second place to look for it.

import type {
  ReasoningEffort,
  ThinkerProvider,
  WireProtocol,
} from "../../types/thinker-roster.js";

/**
 * A function the model may call.
 *
 * `parameters` is a JSON Schema object, passed through to the provider
 * unchanged. It is `Record<string, unknown>` rather than a modelled schema type
 * because the adapter never inspects it — narrowing it here would buy no safety
 * and would reject the vendor-specific keywords each provider accepts.
 */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * One call the model asked for.
 */
export interface ToolCall {
  /**
   * Echoed back VERBATIM on the tool result, never regenerated.
   *
   * The two wires disagree on the field it arrives in — `call_id` on a Responses
   * function-call item, `id` on a Chat `tool_calls[]` entry — and the adapter
   * absorbs that difference into this one field. What it must not absorb is the
   * VALUE: the provider matches the result to the call by exact string, so a
   * reformatted or re-minted id orphans the result and the model answers as if
   * the tool never ran.
   */
  id: string;
  name: string;
  /**
   * The arguments as the RAW JSON STRING the provider sent. Never pre-parsed.
   *
   * Two reasons, and both are failures the caller cannot recover from if this
   * field arrives as an object. First, a model streams arguments as text and can
   * emit malformed JSON; parsing here turns the caller's recoverable "the model
   * sent me garbage" into a throw inside the adapter, far from the retry. Second,
   * the caller may need the bytes verbatim — to log them, or to hand them back
   * in a carry-forward `raw` turn — and a parse/re-stringify round trip does not
   * preserve key order or numeric formatting.
   */
  arguments: string;
}

/**
 * Who is speaking in a turn.
 *
 * `tool` is a tool RESULT going back to the model, not a tool being offered.
 */
export type TurnRole = "system" | "user" | "assistant" | "tool";

/**
 * One entry in the conversation handed to the model.
 *
 * The neutral fields cover what both wires agree on. What they do not agree on
 * rides in `raw` — see the warning on that field, which is the single most
 * load-bearing part of this interface.
 */
export interface Turn {
  role: TurnRole;
  /** Plain text. Empty string on an assistant turn that was only tool calls. */
  content: string;
  /**
   * The `ToolCall.id` this turn answers. Required when `role` is `"tool"`;
   * meaningless otherwise.
   */
  toolCallId?: string;
  /** Set on an assistant turn that asked for tools, in the order requested. */
  toolCalls?: ToolCall[];
  /**
   * Provider-native items carried forward from the response that produced this
   * turn. OPAQUE: the caller stores it and hands it back, and only the adapter
   * that minted it may read it.
   *
   * This field is not a convenience. Both wires break without it, in different
   * ways:
   *
   * - **Responses API**: a reasoning model returns `reasoning` items alongside
   *   its message, and those items MUST be replayed on the next request of the
   *   same exchange. DROPPING THEM BREAKS THE CALL — the API rejects a
   *   follow-up whose function-call output has no reasoning item preceding it.
   *   The encrypted reasoning payload is not reconstructible from `text`, so
   *   there is nothing the caller could rebuild it from.
   * - **Chat Completions**: the assistant message carrying `tool_calls` has to
   *   be replayed exactly before the `tool` messages that answer it. Rebuilding
   *   it from the neutral fields drops whatever the provider added to it.
   *
   * Neither payload fits the neutral shape, and flattening either one into it
   * would mean inventing a union of two vendor formats that the layer above has
   * no use for. So the contract is: keep it, do not read it, give it back.
   */
  raw?: unknown;
}

/**
 * One call to a model.
 */
export interface ChatRequest {
  /** The provider's own id, exactly as the roster stored it. */
  model: string;
  turns: Turn[];
  /**
   * Omitted or empty means a plain completion. A model whose
   * `DiscoveredModel.supports_tools` is false must be called without this.
   */
  tools?: ToolSpec[];
  /** Cap on generated tokens. Reasoning tokens count against it. */
  maxOutputTokens: number;
  /**
   * Where the reasoning budget lands differs by wire — `reasoning.effort` on
   * Responses, `reasoning_effort` on Chat — and the adapter places it. Undefined
   * means "send nothing", which is not the same as sending a default: a
   * non-reasoning model rejects the field outright.
   */
  effort?: ReasoningEffort;
  /** Deadline for this one call. The adapter owns the timer. */
  timeoutMs: number;
  /**
   * Cancellation from above — the round's own deadline, or the caller giving up.
   * Separate from `timeoutMs` because the two fire for different reasons and the
   * round must be able to stop a call that is still inside its own budget.
   */
  signal: AbortSignal;
}

/**
 * Token counts in the **Responses API** vocabulary.
 *
 * THIS IS THE DECISION EVERY ADAPTER HAS TO RESPECT, and it is deliberate:
 * `TextUsage` in `services/pricing.ts` ALREADY has exactly this shape, and both
 * `priceTextResponse` and `services/costs.ts` read it by these field names. A
 * value of this type is therefore priceable as-is, with no translation step
 * where one could be forgotten.
 *
 * Normalising to the Chat Completions vocabulary instead would have meant
 * rewriting the rate card's reader, which ten tests in
 * `__tests__/pricing.test.ts` pin. The cheaper half of the problem is the one
 * that got moved into the adapter.
 *
 * So **the Chat adapter must map**:
 *
 * - `prompt_tokens` → `input_tokens`
 * - `completion_tokens` → `output_tokens`
 * - `prompt_tokens_details.cached_tokens` → `input_tokens_details.cached_tokens`
 *
 * Forgetting that mapping does not fail. `priceTextResponse` reads
 * `usage.input_tokens ?? 0`, finds `undefined`, and reports **$0 for a call that
 * was really billed** — the same silent-zero failure `tracking-costs-and-credits`
 * documents for an unrecognised model id, arriving through a second door. The
 * counts are still in the object under their Chat names, so nothing looks empty
 * on inspection; only the money is wrong.
 */
export interface NormalisedUsage {
  input_tokens: number;
  output_tokens: number;
  /**
   * The cached share of `input_tokens`, NOT an amount on top of it.
   *
   * `priceTextResponse` subtracts it before applying the fresh-input rate, so
   * reporting it as a separate addition double-bills the cached tokens.
   */
  input_tokens_details?: { cached_tokens?: number };
}

/**
 * One answer from a model.
 */
export interface ChatResponse {
  /**
   * The model that actually answered, as the provider reported it — not
   * necessarily the one in `ChatRequest.model`. OpenRouter reroutes, and a
   * provider may resolve an alias to a dated snapshot. This is the id to price
   * and to show, because it is the one that was billed.
   */
  model: string;
  /** Concatenated text. Empty when the model only asked for tools. */
  text: string;
  /** Empty array, never undefined, when the model asked for nothing. */
  toolCalls: ToolCall[];
  usage: NormalisedUsage;
  /**
   * The carry-forward payload for the NEXT turn — assign it to `Turn.raw` on the
   * assistant turn built from this response. Opaque; see `Turn.raw` for why
   * discarding it breaks both wires.
   */
  raw: unknown;
  /**
   * What the provider itself said this call cost, in USD, or `null` when it said
   * nothing.
   *
   * OpenRouter returns a real charge for the model it actually routed to, which
   * beats any local estimate. `null` is the normal case for the others and means
   * "fall back to the rate card" — it does NOT mean free, and must never be
   * coerced to `0` on the way to the ledger, because zero is indistinguishable
   * from a real zero once it is stored.
   */
  reportedUsd: number | null;
  /** Provider-specific: "stop", "length", "tool_calls", … Reported, not parsed. */
  finishReason?: string;
}

/**
 * A model offered by a provider, as discovery found it.
 *
 * The nullable fields are null when the provider's catalogue does not publish
 * them. `ModelChoice` in `types/thinker-roster.ts` documents how the budgeter
 * must read a null `context_window`: as the conservative FLOOR, never as
 * unlimited.
 */
export interface DiscoveredModel {
  /** The id to send back as `ChatRequest.model`, verbatim. */
  id: string;
  /** Human-readable, for the roster UI. Falls back to `id`. */
  label: string;
  context_window: number | null;
  max_output_tokens: number | null;
  /**
   * False takes the WEB away from a thinker on this model; it does not disable
   * the thinker. When the provider does not say, prefer false — offering tools
   * to a model that rejects them fails the whole call, while withholding them
   * only costs that thinker its sources.
   */
  supports_tools: boolean;
  /**
   * USD per 1M tokens. `null` = no published price.
   *
   * Same shape as `ModelChoice.rate`, so discovery can be stored onto a roster
   * slot without reshaping. These are models `services/pricing.ts` has never
   * heard of, and an unknown model there prices at zero in silence — which is
   * why the price travels with the choice instead of being looked up later.
   */
  rate: { input: number; cached_input: number; output: number } | null;
}

/**
 * What every provider integration implements.
 *
 * `provider` and `wire` are separate because they answer different questions:
 * `provider` says whose balance and whose key (`providers/keys.ts`), `wire` says
 * which protocol. Two providers already share one wire, and a provider could
 * change wires without becoming a different provider.
 */
export interface ProviderAdapter {
  provider: ThinkerProvider;
  wire: WireProtocol;
  chat(request: ChatRequest): Promise<ChatResponse>;
  /**
   * The provider's catalogue. Expected to be called rarely and cached onto the
   * roster — it is a per-provider round trip, not something a round should pay.
   */
  listModels(signal?: AbortSignal): Promise<DiscoveredModel[]>;
}
