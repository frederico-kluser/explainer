import { readFile } from "node:fs/promises";
import { describe, it, expect } from "vitest";
import {
  WEB_SEARCH_CALL_USD,
  priceRealtimeResponse,
  priceTextResponse,
  priceWithRate,
  ratesFor,
  type ResolvedRate,
  type TextUsage,
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

describe("priceWithRate", () => {
  // Spread across the card, the dated-snapshot fallback, and two shapes of
  // model id the roster can carry that the card will never know.
  const models = [
    "gpt-5.2",
    "gpt-5.2-mini",
    "gpt-realtime-2.1",
    "gpt-realtime-2025-08-28",
    "gpt-imaginary",
    "openai/gpt-5.2",
    "deepseek-reasoner",
  ];

  const usages: Array<[string, TextUsage]> = [
    ["empty", {}],
    ["input only", { input_tokens: 1_234 }],
    ["output only", { output_tokens: 987 }],
    ["both", { input_tokens: 1_000_000, output_tokens: 1_000_000 }],
    [
      "fully cached",
      {
        input_tokens: 1_000_000,
        input_tokens_details: { cached_tokens: 1_000_000 },
      },
    ],
    [
      "partly cached",
      {
        input_tokens: 900_001,
        output_tokens: 3,
        input_tokens_details: { cached_tokens: 400_000 },
      },
    ],
    [
      "cached above the input total",
      {
        input_tokens: 400_000,
        input_tokens_details: { cached_tokens: 1_000_000 },
      },
    ],
    ["large", { input_tokens: 1_000_000_000, output_tokens: 250_000_000 }],
  ];

  it("with no rate is exactly priceTextResponse, for every model and usage", () => {
    for (const model of models) {
      for (const [label, usage] of usages) {
        expect(
          priceWithRate(null, model, usage),
          `${model} / ${label}`,
        ).toBe(priceTextResponse(model, usage));
      }
    }
  });

  it("handed the card's own row, agrees with priceTextResponse", () => {
    // The cache rule is written out twice — once per function. This is what
    // catches the two copies drifting apart.
    for (const model of models) {
      const card = ratesFor(model);
      if (!card) continue;
      for (const [label, usage] of usages) {
        expect(
          priceWithRate(card.text, model, usage),
          `${model} / ${label}`,
        ).toBe(priceTextResponse(model, usage));
      }
    }
  });

  it("prices a model the card has never heard of", () => {
    const rate: ResolvedRate = { input: 3, cachedInput: 0.3, output: 12 };

    // The same call with no rate is the silent zero this function exists to fix.
    expect(priceTextResponse("moonshot/kimi-k2.6", { input_tokens: 1 })).toBe(0);

    // 1M in @ $3 + 2M out @ $12 = $27
    expect(
      priceWithRate(rate, "moonshot/kimi-k2.6", {
        input_tokens: 1_000_000,
        output_tokens: 2_000_000,
      }),
    ).toBeCloseTo(27, 6);
  });

  it("prefers the resolved rate over the card when both exist", () => {
    const rate: ResolvedRate = { input: 100, cachedInput: 10, output: 200 };
    const usage: TextUsage = { input_tokens: 1_000_000 };

    expect(priceWithRate(rate, "gpt-5.2", usage)).toBeCloseTo(100, 6);
    expect(priceTextResponse("gpt-5.2", usage)).toBeCloseTo(1.75, 6);
  });

  it("bills the cached share at the cached rate, not twice", () => {
    const rate: ResolvedRate = { input: 4, cachedInput: 0.4, output: 24 };

    // 200k fresh @ $4/1M + 800k cached @ $0.40/1M = $0.80 + $0.32
    expect(
      priceWithRate(rate, "some/model", {
        input_tokens: 1_000_000,
        input_tokens_details: { cached_tokens: 800_000 },
      }),
    ).toBeCloseTo(0.8 + 0.32, 6);
  });

  it("clamps a cached count that exceeds the input total", () => {
    const rate: ResolvedRate = { input: 4, cachedInput: 0.4, output: 24 };

    // Nothing fresh to bill, so only the cached tokens cost anything.
    expect(
      priceWithRate(rate, "some/model", {
        input_tokens: 400_000,
        input_tokens_details: { cached_tokens: 1_000_000 },
      }),
    ).toBeCloseTo(0.4, 6);
  });

  it("survives an empty usage object", () => {
    expect(
      priceWithRate({ input: 4, cachedInput: 0.4, output: 24 }, "some/model", {}),
    ).toBe(0);
  });

  it("prices a partial usage without inventing the missing half", () => {
    const rate: ResolvedRate = { input: 4, cachedInput: 0.4, output: 24 };

    expect(
      priceWithRate(rate, "some/model", { input_tokens: 500_000 }),
    ).toBeCloseTo(2, 6);
    expect(
      priceWithRate(rate, "some/model", { output_tokens: 500_000 }),
    ).toBeCloseTo(12, 6);
  });

  it("stays linear at the token counts ten thinkers can reach", () => {
    const rate: ResolvedRate = { input: 1.75, cachedInput: 0.175, output: 14 };

    // 1G in @ $1.75/1M + 500M out @ $14/1M = $1750 + $7000
    expect(
      priceWithRate(rate, "openai/gpt-5.2", {
        input_tokens: 1_000_000_000,
        output_tokens: 500_000_000,
      }),
    ).toBeCloseTo(8_750, 6);
  });

  it("returns zero for a rate of zeros, and says so rather than falling back", () => {
    const free: ResolvedRate = { input: 0, cachedInput: 0, output: 0 };

    // A genuinely free model must not be mistaken for "no rate" and re-routed
    // to the card, which would put a price on it.
    expect(
      priceWithRate(free, "gpt-5.2", {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
      }),
    ).toBe(0);
  });
});

describe("the static rate card", () => {
  it("has not grown into a copy of three providers' catalogues", async () => {
    // priceWithRate exists so a discovered rate never has to be pasted in here.
    // Ten thinkers across three providers would otherwise turn this literal
    // into a hand-maintained catalogue that is wrong the week after it lands.
    const source = await readFile(
      new URL("../services/pricing.ts", import.meta.url),
      "utf8",
    );
    const start = source.indexOf("const RATES");
    const card = source.slice(start, source.indexOf("\n};", start));

    expect(start).toBeGreaterThan(-1);
    expect(card.match(/^ {2}"[^"]+":/gm)).toHaveLength(7);
  });

  it("still does not recognise a provider-prefixed model id", () => {
    expect(ratesFor("openai/gpt-5.2")).toBeNull();
    expect(ratesFor("deepseek-reasoner")).toBeNull();
  });
});
