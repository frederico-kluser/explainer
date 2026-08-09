// Rate card, in USD per 1M tokens, straight from OpenAI's pricing page and the
// model cards (checked 2026-08-01). Everything the app spends money on is
// priced here so the number in the sidebar is a real number and not a vibe.
//
// Realtime bills audio and text at different rates, which is why the usage
// object has to be read per modality rather than by the top-level totals.

export interface ModalityRate {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M cached input tokens. */
  cachedInput: number;
  /** USD per 1M output tokens. */
  output: number;
}

export interface ModelRates {
  text: ModalityRate;
  audio?: ModalityRate;
  image?: ModalityRate;
}

const RATES: Record<string, ModelRates> = {
  "gpt-realtime-2.1": {
    text: { input: 4, cachedInput: 0.4, output: 24 },
    audio: { input: 32, cachedInput: 0.4, output: 64 },
    image: { input: 5, cachedInput: 0.5, output: 0 },
  },
  "gpt-realtime-2.1-mini": {
    text: { input: 0.6, cachedInput: 0.06, output: 2.4 },
    audio: { input: 10, cachedInput: 0.3, output: 20 },
    image: { input: 0.8, cachedInput: 0.08, output: 0 },
  },
  "gpt-realtime-2": {
    text: { input: 4, cachedInput: 0.4, output: 24 },
    audio: { input: 32, cachedInput: 0.4, output: 64 },
  },
  "gpt-realtime": {
    text: { input: 4, cachedInput: 0.4, output: 16 },
    audio: { input: 32, cachedInput: 0.4, output: 64 },
  },
  "gpt-realtime-mini": {
    text: { input: 0.6, cachedInput: 0.06, output: 2.4 },
    audio: { input: 10, cachedInput: 0.3, output: 20 },
  },
  "gpt-5.2": { text: { input: 1.75, cachedInput: 0.175, output: 14 } },
  "gpt-5.2-mini": { text: { input: 0.35, cachedInput: 0.035, output: 2.8 } },
};

/** Hosted web search: $10 per 1000 calls, plus the model's own token cost. */
export const WEB_SEARCH_CALL_USD = 0.01;

/** Fall back to the base model when a dated snapshot is in play. */
export function ratesFor(model: string): ModelRates | null {
  if (RATES[model]) return RATES[model];
  const base = model.replace(/-\d{4}-\d{2}-\d{2}$/, "");
  return RATES[base] ?? null;
}

// ---------------------------------------------------------------------------
// Realtime
// ---------------------------------------------------------------------------

/** The `usage` object the Realtime API attaches to every `response.done`. */
export interface RealtimeUsage {
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  input_token_details?: {
    text_tokens?: number;
    audio_tokens?: number;
    image_tokens?: number;
    cached_tokens?: number;
    cached_tokens_details?: {
      text_tokens?: number;
      audio_tokens?: number;
      image_tokens?: number;
    };
  };
  output_token_details?: {
    text_tokens?: number;
    audio_tokens?: number;
  };
}

export interface PricedUsage {
  usd: number;
  input_tokens: number;
  output_tokens: number;
  audio_tokens: number;
  cached_tokens: number;
}

const per1M = (tokens: number, rate: number) => (tokens / 1_000_000) * rate;

/**
 * Price one realtime response.
 *
 * `input_token_details` counts *all* input tokens per modality, cached ones
 * included, so the cached share is subtracted before applying the full rate —
 * otherwise a long session with heavy caching reads far more expensive than it
 * actually was.
 */
export function priceRealtimeResponse(
  model: string,
  usage: RealtimeUsage,
): PricedUsage {
  const rates = ratesFor(model);
  const input = usage.input_token_details ?? {};
  const output = usage.output_token_details ?? {};
  const cached = input.cached_tokens_details ?? {};

  const cachedText = cached.text_tokens ?? 0;
  const cachedAudio = cached.audio_tokens ?? 0;
  const cachedImage = cached.image_tokens ?? 0;

  const freshText = Math.max(0, (input.text_tokens ?? 0) - cachedText);
  const freshAudio = Math.max(0, (input.audio_tokens ?? 0) - cachedAudio);
  const freshImage = Math.max(0, (input.image_tokens ?? 0) - cachedImage);

  const summary: PricedUsage = {
    usd: 0,
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    audio_tokens: (input.audio_tokens ?? 0) + (output.audio_tokens ?? 0),
    cached_tokens: input.cached_tokens ?? cachedText + cachedAudio + cachedImage,
  };

  if (!rates) return summary; // unknown model: report tokens, claim no price

  summary.usd =
    per1M(freshText, rates.text.input) +
    per1M(cachedText, rates.text.cachedInput) +
    per1M(output.text_tokens ?? 0, rates.text.output) +
    (rates.audio
      ? per1M(freshAudio, rates.audio.input) +
        per1M(cachedAudio, rates.audio.cachedInput) +
        per1M(output.audio_tokens ?? 0, rates.audio.output)
      : 0) +
    (rates.image
      ? per1M(freshImage, rates.image.input) +
        per1M(cachedImage, rates.image.cachedInput)
      : 0);

  return summary;
}

// ---------------------------------------------------------------------------
// Responses API (web search, titles)
// ---------------------------------------------------------------------------

export interface TextUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
}

export function priceTextResponse(model: string, usage: TextUsage): number {
  const rates = ratesFor(model);
  if (!rates) return 0;

  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  const fresh = Math.max(0, (usage.input_tokens ?? 0) - cached);

  return (
    per1M(fresh, rates.text.input) +
    per1M(cached, rates.text.cachedInput) +
    per1M(usage.output_tokens ?? 0, rates.text.output)
  );
}

// ---------------------------------------------------------------------------
// Caller-resolved rates
// ---------------------------------------------------------------------------

/**
 * A text rate the caller resolved elsewhere, in **USD per 1M tokens** — the
 * same unit as the static card above, so a row of `RATES` and a `ResolvedRate`
 * are interchangeable.
 *
 * The unit is not arbitrary: OpenRouter's catalogue (`GET /api/v1/models`)
 * publishes `pricing.prompt` as a decimal string in USD *per token*, and
 * `openai/gpt-5.2` reads `"0.00000175"` there — times 1e6 that is 1.75, exactly
 * the number the card above already carries for that model. Multiplying a
 * catalogue price by 1e6 is the whole conversion into this unit.
 */
export interface ResolvedRate {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M cached input tokens. */
  cachedInput: number;
  /** USD per 1M output tokens. */
  output: number;
}

/**
 * Price a text response against a rate the **caller** resolved, falling back to
 * the static card when it has none.
 *
 * A roster of thinkers can name models this file has never heard of, and
 * `priceTextResponse` answers 0 for those — the silent zero documented in
 * `tracking-costs-and-credits`. This is how a discovered rate gets used without
 * growing the card into a mirror of three providers' catalogues.
 *
 * Price comes from three sources, in this order, and only the last two are
 * here:
 *
 * 1. the cost the provider itself reported — OpenRouter returns `usage.cost` in
 *    USD on every response. That figure is already final, has no rate behind it
 *    to pass in, and so never reaches this function;
 * 2. `rate`: discovered from the provider's catalogue and cached on the roster;
 * 3. the static card, reached by passing `rate` as `null`.
 *
 * That is why this is a second function rather than a wider `priceTextResponse`:
 * source 1 has nothing to hand it, so the callers are genuinely different.
 *
 * `priceWithRate(null, model, usage)` delegates, so it is identical to
 * `priceTextResponse(model, usage)` by construction and not merely in practice.
 */
export function priceWithRate(
  rate: ResolvedRate | null,
  model: string,
  usage: TextUsage,
): number {
  if (!rate) return priceTextResponse(model, usage);

  // Same rule as priceTextResponse: input_tokens already counts the cached
  // ones, so the cached share comes off before the full rate applies and is
  // then billed at the cached rate. Charging both would bill it twice.
  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  const fresh = Math.max(0, (usage.input_tokens ?? 0) - cached);

  return (
    per1M(fresh, rate.input) +
    per1M(cached, rate.cachedInput) +
    per1M(usage.output_tokens ?? 0, rate.output)
  );
}
