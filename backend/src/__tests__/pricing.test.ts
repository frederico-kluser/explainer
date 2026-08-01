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
