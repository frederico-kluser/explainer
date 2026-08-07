import { describe, it, expect } from "vitest";
import {
  WEB_SEARCH_CALL_USD,
  priceRealtimeResponse,
  priceTextResponse,
  ratesFor,
} from "../services/pricing.js";

describe("ratesFor", () => {
  it("knows the realtime model and its mini", () => {
    expect(ratesFor("gpt-realtime-2.1")?.audio?.output).toBe(64);
    expect(ratesFor("gpt-realtime-2.1-mini")?.audio?.output).toBe(20);
  });

  it("falls back to the base model for a dated snapshot", () => {
    expect(ratesFor("gpt-realtime-2025-08-28")?.audio?.input).toBe(32);
  });

  it("returns null for a model it has never heard of", () => {
    expect(ratesFor("gpt-imaginary")).toBeNull();
  });
});

describe("priceRealtimeResponse", () => {
  it("prices each modality at its own rate", () => {
    // 1M audio in @ $32 + 1M text in @ $4 + 1M audio out @ $64 = $100
    const priced = priceRealtimeResponse("gpt-realtime-2.1", {
      input_tokens: 2_000_000,
      output_tokens: 1_000_000,
      input_token_details: { text_tokens: 1_000_000, audio_tokens: 1_000_000 },
      output_token_details: { audio_tokens: 1_000_000 },
    });

    expect(priced.usd).toBeCloseTo(100, 6);
  });

  it("bills the cached share at the cached rate, not twice", () => {
    // input_token_details counts cached tokens too, so charging the full rate on
    // the whole figure would overstate a long session badly.
    const priced = priceRealtimeResponse("gpt-realtime-2.1", {
      input_tokens: 1_000_000,
      input_token_details: {
        text_tokens: 1_000_000,
        cached_tokens: 800_000,
        cached_tokens_details: { text_tokens: 800_000 },
      },
    });

    // 200k fresh @ $4/1M + 800k cached @ $0.40/1M = $0.80 + $0.32
    expect(priced.usd).toBeCloseTo(0.8 + 0.32, 6);
  });

  it("reports tokens but no price for an unknown model", () => {
    const priced = priceRealtimeResponse("gpt-imaginary", {
      input_tokens: 100,
      output_tokens: 50,
    });
    expect(priced.usd).toBe(0);
    expect(priced.input_tokens).toBe(100);
  });

  it("survives an empty usage object", () => {
    expect(priceRealtimeResponse("gpt-realtime-2.1", {}).usd).toBe(0);
  });
});

describe("priceTextResponse", () => {
  it("prices the Responses API call used by web search", () => {
    // 1M in @ $1.75 + 1M out @ $14
    expect(
      priceTextResponse("gpt-5.2", {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
      }),
    ).toBeCloseTo(15.75, 6);
  });

  it("discounts cached input", () => {
    expect(
      priceTextResponse("gpt-5.2", {
        input_tokens: 1_000_000,
        input_tokens_details: { cached_tokens: 1_000_000 },
      }),
    ).toBeCloseTo(0.175, 6);
  });
});

describe("WEB_SEARCH_CALL_USD", () => {
  it("matches the published $10 per 1000 calls", () => {
    expect(WEB_SEARCH_CALL_USD * 1000).toBeCloseTo(10, 6);
  });
});

describe("priceRealtimeResponse edge cases", () => {
  it("prices a text-only model (no audio/image rates)", () => {
    // gpt-5.2 only has text rates — audio and image rates are undefined.
    const priced = priceRealtimeResponse("gpt-5.2", {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      input_token_details: { text_tokens: 1_000_000 },
      output_token_details: { text_tokens: 1_000_000 },
    });

    // 1M in @ $1.75 + 1M out @ $14 = $15.75
    expect(priced.usd).toBeCloseTo(15.75, 6);
    // Audio tokens should be 0 since the model has no audio rates.
    expect(priced.audio_tokens).toBe(0);
  });

  it("prices a model with image rates", () => {
    // gpt-realtime-2.1 has image rates: $5/M input, $0.50/M cached
    const priced = priceRealtimeResponse("gpt-realtime-2.1", {
      input_tokens: 1_000_000,
      input_token_details: {
        image_tokens: 1_000_000,
      },
    });

    // 1M image in @ $5/M = $5.00
    expect(priced.usd).toBeCloseTo(5.0, 6);
  });

  it("prices a model without image rates by not charging for image", () => {
    // gpt-realtime-2 has no image rates defined.
    const priced = priceRealtimeResponse("gpt-realtime-2", {
      input_tokens: 1_000_000,
      input_token_details: {
        image_tokens: 1_000_000,
        text_tokens: 1_000_000,
      },
    });

    // Only text: 1M @ $4 = $4. No image charge.
    expect(priced.usd).toBeCloseTo(4.0, 6);
  });

  it("prices cached image tokens at the cached rate", () => {
    const priced = priceRealtimeResponse("gpt-realtime-2.1", {
      input_tokens: 1_000_000,
      input_token_details: {
        image_tokens: 1_000_000,
        cached_tokens: 500_000,
        cached_tokens_details: { image_tokens: 500_000 },
      },
    });

    // 500k fresh @ $5/M + 500k cached @ $0.50/M = $2.50 + $0.25 = $2.75
    expect(priced.usd).toBeCloseTo(2.75, 6);
  });

  it("clamps negative token counts to 0 (fresh cannot go negative)", () => {
    // cached_tokens_details reports more than input_token_details — a data bug.
    // The Math.max prevents negative fresh counts.
    const priced = priceRealtimeResponse("gpt-realtime-2.1", {
      input_tokens: 100,
      input_token_details: {
        text_tokens: 100,
        cached_tokens: 200,
        cached_tokens_details: { text_tokens: 200 },
      },
    });

    // Fresh text = max(0, 100-200) = 0 ; cached text = 200
    // 0 fresh @ $4 + 200 cached @ $0.40 = $0.00008
    expect(priced.usd).toBeCloseTo((200 / 1_000_000) * 0.4, 10);
    expect(priced.input_tokens).toBe(100);
  });

  it("reports audio_tokens from input and output details", () => {
    const priced = priceRealtimeResponse("gpt-realtime-2.1", {
      input_token_details: { audio_tokens: 300 },
      output_token_details: { audio_tokens: 700 },
    });

    expect(priced.audio_tokens).toBe(1000);
  });
});

describe("ratesFor with DeepSeek models", () => {
  it("resolves deepseek-chat with correct rates", () => {
    const rates = ratesFor("deepseek-chat");
    expect(rates).not.toBeNull();
    expect(rates!.text.input).toBe(0.27);
    expect(rates!.text.cachedInput).toBe(0.27);
    expect(rates!.text.output).toBe(1.1);
  });

  it("resolves deepseek-reasoner with correct rates", () => {
    const rates = ratesFor("deepseek-reasoner");
    expect(rates).not.toBeNull();
    expect(rates!.text.input).toBe(0.55);
    expect(rates!.text.cachedInput).toBe(0.55);
    expect(rates!.text.output).toBe(2.19);
  });
});

describe("priceTextResponse edge cases", () => {
  it("returns 0 for zero tokens", () => {
    expect(priceTextResponse("gpt-5.2", {})).toBe(0);
    expect(priceTextResponse("gpt-5.2", {
      input_tokens: 0,
      output_tokens: 0,
    })).toBe(0);
  });

  it("handles partial cached input details", () => {
    const usd = priceTextResponse("gpt-5.2", {
      input_tokens: 1_000_000,
      output_tokens: 0,
      input_tokens_details: { cached_tokens: 500_000 },
    });

    // 500k fresh @ $1.75 + 500k cached @ $0.175 = $0.875 + $0.0875 = $0.9625
    expect(usd).toBeCloseTo(0.9625, 6);
  });

  it("returns 0 for unknown model", () => {
    expect(priceTextResponse("nonexistent-model", {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    })).toBe(0);
  });

  it("discounts cached input for deepseek-chat", () => {
    // DeepSeek chat: cachedInput = input = $0.27, so cached and fresh cost the same.
    const usdNoCache = priceTextResponse("deepseek-chat", {
      input_tokens: 1_000_000,
      output_tokens: 0,
    });
    const usdCached = priceTextResponse("deepseek-chat", {
      input_tokens: 1_000_000,
      output_tokens: 0,
      input_tokens_details: { cached_tokens: 1_000_000 },
    });

    // Both should be $0.27 since cached rate equals input rate for DeepSeek.
    expect(usdNoCache).toBeCloseTo(0.27, 6);
    expect(usdCached).toBeCloseTo(0.27, 6);
  });
});
