import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// HOME to a temp dir BEFORE the first runtime import: the adapters pull in
// `openai.ts` for `OpenAIError`, which reaches `costs.ts` and then storage, and
// `sandbox.ts` freezes its homedir()-derived roots at module load. Same
// technique as `openai.test.ts`, and the reason this file cannot touch the real
// ~/.local/share/voice-assistant.
const tmpHome = mkdtempSync(join(tmpdir(), "explainer-adapters-test-"));
process.env.HOME = tmpHome;

const { adapterFor, ALL_PROVIDERS } = await import("../services/providers/index.js");
const { createOpenAIChatAdapter } = await import("../services/providers/openai-chat.js");
const { priceTextResponse, priceWithRate } = await import("../services/pricing.js");
type ChatRequest = import("../services/providers/types.js").ChatRequest;
type TextUsage = import("../services/pricing.js").TextUsage;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface SeenCall {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body?: string;
}

let calls: SeenCall[] = [];

/** Answer every call with `payload`. Nothing opens a socket. */
function stub(payload: unknown, { ok = true, status = 200 } = {}): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => {
      calls.push({
        url,
        method: init.method,
        headers: init.headers ?? {},
        body: init.body,
      });
      return Promise.resolve({
        ok,
        status,
        text: () => Promise.resolve(JSON.stringify(payload)),
      });
    }),
  );
}

/**
 * A call that never answers and only settles when it is aborted — the shape a
 * real hung provider has, and the only way the timeout and the caller's signal
 * can be proven to actually stop one.
 */
function stubHanging(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init: { signal?: AbortSignal }) => {
      calls.push({ url, headers: {} });
      return new Promise((_resolve, reject) => {
        const fail = () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        };
        if (init.signal?.aborted) return fail();
        init.signal?.addEventListener("abort", fail, { once: true });
      });
    }),
  );
}

function lastBody(): Record<string, unknown> {
  return JSON.parse(calls[calls.length - 1]?.body ?? "{}") as Record<string, unknown>;
}

function request(over: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: "test-model",
    turns: [{ role: "user", content: "e ai?" }],
    maxOutputTokens: 256,
    timeoutMs: 5_000,
    signal: new AbortController().signal,
    ...over,
  };
}

beforeEach(() => {
  calls = [];
  process.env.OPENAI_API_KEY = "sk-openai-not-real";
  process.env.OPENROUTER_API_KEY = "sk-or-not-real";
  process.env.DEEPSEEK_API_KEY = "sk-ds-not-real";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
});

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe("adapterFor", () => {
  it("routes each provider to the wire it actually speaks", () => {
    expect(adapterFor("openai").wire).toBe("openai-responses");
    expect(adapterFor("openrouter").wire).toBe("openai-chat");
    expect(adapterFor("deepseek").wire).toBe("openai-chat");
  });

  it("keeps provider and wire as separate answers", () => {
    // Two providers share one wire; `provider` still names whose key pays.
    expect(adapterFor("openrouter").provider).toBe("openrouter");
    expect(adapterFor("deepseek").provider).toBe("deepseek");
    expect(adapterFor("openrouter").wire).toBe(adapterFor("deepseek").wire);
  });

  it("lists every provider, and every one of them resolves", () => {
    expect(ALL_PROVIDERS).toEqual(["openai", "openrouter", "deepseek"]);
    for (const provider of ALL_PROVIDERS) {
      expect(adapterFor(provider).provider).toBe(provider);
    }
  });
});

// ---------------------------------------------------------------------------
// The usage mapping — the test that stops a real charge reading $0
// ---------------------------------------------------------------------------

describe("openai-chat usage", () => {
  it("translates the Chat token vocabulary into the one the rate card reads", async () => {
    stub({
      model: "gpt-5.2-mini",
      choices: [{ message: { role: "assistant", content: "pronto" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 1200,
        completion_tokens: 90,
        prompt_tokens_details: { cached_tokens: 400 },
      },
    });

    const answer = await adapterFor("deepseek").chat(request());

    expect(answer.usage).toEqual({
      input_tokens: 1200,
      output_tokens: 90,
      input_tokens_details: { cached_tokens: 400 },
    });
  });

  it("prices to a real number, where the untranslated counts price to $0", async () => {
    stub({
      model: "gpt-5.2-mini",
      choices: [{ message: { content: "pronto" } }],
      usage: { prompt_tokens: 1200, completion_tokens: 90 },
    });

    const answer = await adapterFor("deepseek").chat(request());

    // This is the whole point of the mapping, stated in money rather than in
    // field names: the SAME counts, against the SAME rate card, are worth
    // something once translated and worth nothing when they are not. Nothing
    // throws in the second case and nothing looks empty — only the bill is wrong.
    const untranslated = { prompt_tokens: 1200, completion_tokens: 90 } as unknown as TextUsage;
    expect(priceTextResponse("gpt-5.2-mini", untranslated)).toBe(0);
    expect(priceTextResponse("gpt-5.2-mini", answer.usage)).toBeGreaterThan(0);
  });

  it("carries the cached share so it is not billed at the full input rate", async () => {
    stub({
      model: "whatever",
      choices: [{ message: { content: "ok" } }],
      usage: {
        prompt_tokens: 1_000_000,
        completion_tokens: 0,
        prompt_tokens_details: { cached_tokens: 800_000 },
      },
    });

    const answer = await adapterFor("openrouter").chat(request());
    const rate = { input: 4, cachedInput: 0.4, output: 24 };

    // 200k fresh @ $4/1M + 800k cached @ $0.40/1M. A mapping that dropped
    // `cached_tokens` would bill the whole million at $4 and read $4.00.
    expect(priceWithRate(rate, answer.model, answer.usage)).toBeCloseTo(0.8 + 0.32, 9);
  });

  it("answers zeroed counts, never undefined, when the payload carried no usage", async () => {
    stub({ model: "whatever", choices: [{ message: { content: "ok" } }] });

    const answer = await adapterFor("deepseek").chat(request());

    // `input_tokens: 0` is priceable without a guard; `undefined` is the silent
    // zero arriving through the other door.
    expect(answer.usage.input_tokens).toBe(0);
    expect(answer.usage.output_tokens).toBe(0);
    expect(answer.usage.input_tokens_details).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// reportedUsd
// ---------------------------------------------------------------------------

describe("reportedUsd", () => {
  it("takes OpenRouter's own charge when it reports one", async () => {
    stub({
      model: "deepseek/deepseek-v4-pro",
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 194, completion_tokens: 2, cost: 0.000071 },
    });

    const answer = await adapterFor("openrouter").chat(request());

    expect(answer.reportedUsd).toBe(0.000071);
  });

  it("answers null — never 0 — when the provider reported no cost", async () => {
    stub({
      model: "deepseek-v4-pro",
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 194, completion_tokens: 2 },
    });

    const answer = await adapterFor("deepseek").chat(request());

    // Once stored, a 0 is indistinguishable from a call that really was free,
    // so the absence has to survive as an absence.
    expect(answer.reportedUsd).toBeNull();
    expect(answer.reportedUsd).not.toBe(0);
  });

  it("keeps a genuinely free call as 0, distinct from an unreported one", async () => {
    stub({
      model: "free/model",
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 10, completion_tokens: 1, cost: 0 },
    });

    const answer = await adapterFor("openrouter").chat(request());

    expect(answer.reportedUsd).toBe(0);
    expect(answer.reportedUsd).not.toBeNull();
  });

  it("is null on the Responses wire, because OpenAI reports no cost at all", async () => {
    stub({ model: "gpt-5.2-mini", output: [], usage: { input_tokens: 5, output_tokens: 1 } });

    const answer = await adapterFor("openai").chat(request());

    expect(answer.reportedUsd).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// effort placement
// ---------------------------------------------------------------------------

describe("reasoning effort", () => {
  it("omits the field entirely on both wires when effort is undefined", async () => {
    stub({ model: "m", output: [] });
    await adapterFor("openai").chat(request({ effort: undefined }));
    // Not "reasoning: undefined" — the key must not be in the JSON at all, and
    // `toEqual` on the parsed body is what tells those two apart.
    expect("reasoning" in lastBody()).toBe(false);

    stub({ model: "m", choices: [{ message: { content: "" } }] });
    await adapterFor("deepseek").chat(request({ effort: undefined }));
    expect("reasoning_effort" in lastBody()).toBe(false);
  });

  it("nests it under `reasoning` on the Responses wire", async () => {
    stub({ model: "m", output: [] });

    await adapterFor("openai").chat(request({ effort: "high" }));

    expect(lastBody().reasoning).toEqual({ effort: "high" });
    expect("reasoning_effort" in lastBody()).toBe(false);
  });

  it("puts it at the root as `reasoning_effort` on the Chat wire", async () => {
    stub({ model: "m", choices: [{ message: { content: "" } }] });

    await adapterFor("openrouter").chat(request({ effort: "low" }));

    expect(lastBody().reasoning_effort).toBe("low");
    expect("reasoning" in lastBody()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------

// Deliberately awkward: mixed case, dashes, underscores and padding. A byte of
// this changing is the bug the assertions below exist to catch.
const CALL_ID = "call_AbC-123_XyZ==";
// Key order and `1.50` are the tell: a parse/re-stringify round trip renders it
// `1.5` and may reorder, so byte equality proves no round trip happened.
const RAW_ARGS = '{"query":"preço do dólar","limit":1.50,"alpha":true}';

describe("tool calls", () => {
  it("echoes the Responses `call_id` verbatim and keeps arguments a string", async () => {
    stub({
      model: "gpt-5.2",
      output: [{ type: "function_call", call_id: CALL_ID, name: "brave_search", arguments: RAW_ARGS }],
      usage: { input_tokens: 10, output_tokens: 2 },
    });

    const answer = await adapterFor("openai").chat(request());

    expect(answer.toolCalls).toHaveLength(1);
    const call = answer.toolCalls[0]!;
    expect(call.id).toBe(CALL_ID);
    expect(call.name).toBe("brave_search");
    expect(typeof call.arguments).toBe("string");
    expect(call.arguments).toBe(RAW_ARGS);
  });

  it("echoes the Chat `id` verbatim and keeps arguments a string", async () => {
    stub({
      model: "deepseek-v4-pro",
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: CALL_ID, type: "function", function: { name: "brave_search", arguments: RAW_ARGS } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });

    const answer = await adapterFor("deepseek").chat(request());

    const call = answer.toolCalls[0]!;
    // The two wires disagree on the field name; they must not disagree on the
    // value, because the provider matches the result to the call by exact string.
    expect(call.id).toBe(CALL_ID);
    expect(typeof call.arguments).toBe("string");
    expect(call.arguments).toBe(RAW_ARGS);
    // A null content is an assistant turn that was only tool calls, not a crash.
    expect(answer.text).toBe("");
    expect(answer.finishReason).toBe("tool_calls");
  });

  it("answers an empty array, never undefined, when the model asked for nothing", async () => {
    stub({ model: "m", choices: [{ message: { content: "só texto" } }] });

    const answer = await adapterFor("openrouter").chat(request());

    expect(answer.toolCalls).toEqual([]);
  });

  it("replays `raw` instead of rebuilding the turn it came from", async () => {
    // The Responses wire: reasoning items sit alongside the function_call and
    // the API rejects a follow-up whose function_call_output is not preceded by
    // them. They cannot be rebuilt from `content`, so they can only survive here.
    const carried = [
      { type: "reasoning", id: "rs_1", encrypted_content: "opaque" },
      { type: "function_call", call_id: CALL_ID, name: "brave_search", arguments: RAW_ARGS },
    ];
    stub({ model: "m", output: [] });

    await adapterFor("openai").chat(
      request({
        turns: [
          { role: "user", content: "pergunta" },
          { role: "assistant", content: "", toolCalls: [], raw: carried },
          { role: "tool", content: "resultado", toolCallId: CALL_ID },
        ],
      }),
    );

    expect(lastBody().input).toEqual([
      { role: "user", content: "pergunta" },
      ...carried,
      { type: "function_call_output", call_id: CALL_ID, output: "resultado" },
    ]);
  });

  it("replays the Chat assistant message verbatim ahead of the tool answer", async () => {
    const carried = {
      role: "assistant",
      content: null,
      reasoning_content: "provider-specific, unreachable from the neutral fields",
      tool_calls: [{ id: CALL_ID, type: "function", function: { name: "brave_search", arguments: RAW_ARGS } }],
    };
    stub({ model: "m", choices: [{ message: { content: "" } }] });

    await adapterFor("deepseek").chat(
      request({
        turns: [
          { role: "user", content: "pergunta" },
          { role: "assistant", content: "", raw: carried },
          { role: "tool", content: "resultado", toolCallId: CALL_ID },
        ],
      }),
    );

    expect(lastBody().messages).toEqual([
      { role: "user", content: "pergunta" },
      carried,
      { role: "tool", tool_call_id: CALL_ID, content: "resultado" },
    ]);
  });

  it("hands back a `raw` that can be replayed on the next turn", async () => {
    const output = [{ type: "reasoning", id: "rs_9" }, { type: "message", content: [{ text: "oi" }] }];
    stub({ model: "m", output });

    const answer = await adapterFor("openai").chat(request());

    expect(answer.raw).toEqual(output);
  });
});

// ---------------------------------------------------------------------------
// Request shaping
// ---------------------------------------------------------------------------

describe("request shaping", () => {
  it("caps output under each wire's own spelling", async () => {
    stub({ model: "m", output: [] });
    await adapterFor("openai").chat(request({ maxOutputTokens: 1_400 }));
    expect(lastBody().max_output_tokens).toBe(1_400);
    expect("max_tokens" in lastBody()).toBe(false);

    stub({ model: "m", choices: [{ message: { content: "" } }] });
    await adapterFor("deepseek").chat(request({ maxOutputTokens: 1_400 }));
    expect(lastBody().max_tokens).toBe(1_400);
    expect("max_output_tokens" in lastBody()).toBe(false);
  });

  it("offers tools flat on Responses and nested on Chat", async () => {
    const tools = [{ name: "brave_search", description: "busca", parameters: { type: "object" } }];

    stub({ model: "m", output: [] });
    await adapterFor("openai").chat(request({ tools }));
    // Flat. The nested Chat spelling is accepted here without error while
    // exposing zero tools to the model.
    expect(lastBody().tools).toEqual([
      { type: "function", name: "brave_search", description: "busca", parameters: { type: "object" } },
    ]);

    stub({ model: "m", choices: [{ message: { content: "" } }] });
    await adapterFor("deepseek").chat(request({ tools }));
    expect(lastBody().tools).toEqual([
      {
        type: "function",
        function: { name: "brave_search", description: "busca", parameters: { type: "object" } },
      },
    ]);
  });

  it("sends no tools key at all when the caller offered none", async () => {
    stub({ model: "m", choices: [{ message: { content: "" } }] });

    await adapterFor("deepseek").chat(request({ tools: [] }));

    // A model whose `supports_tools` is false must be called without the key,
    // not with an empty list.
    expect("tools" in lastBody()).toBe(false);
  });

  it("reaches each provider's own URL, with OpenRouter's attribution headers", async () => {
    stub({ model: "m", choices: [{ message: { content: "" } }] });
    await adapterFor("openrouter").chat(request());

    const seen = calls[calls.length - 1]!;
    expect(seen.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(seen.headers["HTTP-Referer"]).toBe("https://github.com/ondokai/explainer");
    expect(seen.headers["X-Title"]).toBe("Explainer");
    expect(seen.headers.Authorization).toBe("Bearer sk-or-not-real");
    expect(lastBody().usage).toEqual({ include: true });

    stub({ model: "m", choices: [{ message: { content: "" } }] });
    await adapterFor("deepseek").chat(request());
    expect(calls[calls.length - 1]!.url).toBe("https://api.deepseek.com/v1/chat/completions");
    expect(calls[calls.length - 1]!.headers.Authorization).toBe("Bearer sk-ds-not-real");

    stub({ model: "m", output: [] });
    await adapterFor("openai").chat(request());
    expect(calls[calls.length - 1]!.url).toBe("https://api.openai.com/v1/responses");
    expect(calls[calls.length - 1]!.headers.Authorization).toBe("Bearer sk-openai-not-real");
  });

  it("honours OPENAI_BASE_URL at call time, trailing slash and all", async () => {
    process.env.OPENAI_BASE_URL = "https://gateway.internal/v1/";
    try {
      stub({ model: "m", output: [] });
      await adapterFor("openai").chat(request());
      expect(calls[calls.length - 1]!.url).toBe("https://gateway.internal/v1/responses");
    } finally {
      delete process.env.OPENAI_BASE_URL;
    }
  });

  it("reports the model that answered, not the one that was asked for", async () => {
    stub({ model: "deepseek/deepseek-v4-pro", choices: [{ message: { content: "ok" } }] });

    // OpenRouter reroutes, and the model that answered is the one that was billed.
    const answer = await adapterFor("openrouter").chat(request({ model: "openrouter/auto" }));

    expect(answer.model).toBe("deepseek/deepseek-v4-pro");
    expect(lastBody().model).toBe("openrouter/auto");
  });
});

// ---------------------------------------------------------------------------
// Catalogues
// ---------------------------------------------------------------------------

describe("listModels: OpenRouter", () => {
  // Trimmed from a live `GET https://openrouter.ai/api/v1/models` response.
  const CATALOGUE = {
    data: [
      {
        id: "deepseek/deepseek-v4-pro",
        name: "DeepSeek: DeepSeek V4 Pro",
        created: 1777000679,
        context_length: 1048576,
        architecture: { input_modalities: ["text"] },
        pricing: {
          prompt: "0.000000435",
          completion: "0.00000087",
          input_cache_read: "0.000000003625",
        },
        top_provider: { context_length: 1048576, max_completion_tokens: 384000, is_moderated: false },
        supported_parameters: ["max_tokens", "reasoning", "reasoning_effort", "tool_choice", "tools"],
      },
      {
        id: "some/no-tools-model",
        name: "Some: No Tools",
        created: 1685232000,
        context_length: 8192,
        pricing: { prompt: "0.0000001", completion: "0.0000006" },
        top_provider: { context_length: 8192, max_completion_tokens: null },
        supported_parameters: ["max_tokens", "temperature"],
      },
      {
        id: "openrouter/auto",
        name: "Auto Router",
        created: 1699401600,
        context_length: 2000000,
        pricing: { prompt: "-1", completion: "-1" },
        top_provider: { context_length: 2000000, max_completion_tokens: null },
        supported_parameters: ["tools"],
      },
      {
        id: "inclusionai/ling-3.0-tiny:free",
        name: "inclusionAI: Ling 3.0 Tiny (free)",
        created: 1786034890,
        context_length: 262144,
        pricing: { prompt: "0", completion: "0" },
        top_provider: { context_length: 262144, max_completion_tokens: 32768 },
        supported_parameters: ["tools"],
      },
    ],
  };

  it("converts the per-token catalogue price into USD per 1M tokens", async () => {
    stub(CATALOGUE);

    const models = await adapterFor("openrouter").listModels();
    const pro = models.find((m) => m.id === "deepseek/deepseek-v4-pro")!;

    // The catalogue publishes decimal strings in USD *per token*; `rate` is USD
    // per 1M. The factor of 1e6 is the adapter's job and nothing downstream
    // repeats it.
    expect(pro.rate).not.toBeNull();
    expect(pro.rate!.input).toBeCloseTo(0.435, 12);
    expect(pro.rate!.output).toBeCloseTo(0.87, 12);
    expect(pro.rate!.cached_input).toBeCloseTo(0.003625, 12);
  });

  it("falls back to the full input rate when no cache-read price is published", async () => {
    stub(CATALOGUE);

    const models = await adapterFor("openrouter").listModels();
    const plain = models.find((m) => m.id === "some/no-tools-model")!;

    // "No published discount" is not "cached input is free" — 0 would under-bill
    // every cache hit on a provider that simply does not offer caching.
    expect(plain.rate!.input).toBeCloseTo(0.1, 12);
    expect(plain.rate!.cached_input).toBe(plain.rate!.input);
  });

  it("reads a negative price as no price, not as a negative charge", async () => {
    stub(CATALOGUE);

    const models = await adapterFor("openrouter").listModels();
    const auto = models.find((m) => m.id === "openrouter/auto")!;

    // The router models publish "-1" because the real price depends on where the
    // request lands. A negative rate would reach the ledger as a credit.
    expect(auto.rate).toBeNull();
  });

  it("keeps a free model's published zero, which is not a missing price", async () => {
    stub(CATALOGUE);

    const models = await adapterFor("openrouter").listModels();
    const free = models.find((m) => m.id === "inclusionai/ling-3.0-tiny:free")!;

    expect(free.rate).toEqual({ input: 0, cached_input: 0, output: 0 });
  });

  it("takes supports_tools from supported_parameters, and false when it is absent", async () => {
    stub(CATALOGUE);

    const models = await adapterFor("openrouter").listModels();

    expect(models.find((m) => m.id === "deepseek/deepseek-v4-pro")!.supports_tools).toBe(true);
    expect(models.find((m) => m.id === "some/no-tools-model")!.supports_tools).toBe(false);
  });

  it("derives released_at from `created`, which is an epoch in SECONDS", async () => {
    stub(CATALOGUE);

    const models = await adapterFor("openrouter").listModels();

    // Read as milliseconds these are all 1970, which is the mistake this pins.
    expect(models.find((m) => m.id === "deepseek/deepseek-v4-pro")!.released_at).toBe(
      "2026-04-24T03:17:59.000Z",
    );
    expect(models.find((m) => m.id === "some/no-tools-model")!.released_at).toBe(
      "2023-05-28T00:00:00.000Z",
    );
  });

  it("carries the window, the output ceiling, the label and the provider", async () => {
    stub(CATALOGUE);

    const models = await adapterFor("openrouter").listModels();
    const pro = models.find((m) => m.id === "deepseek/deepseek-v4-pro")!;

    expect(pro.label).toBe("DeepSeek: DeepSeek V4 Pro");
    expect(pro.context_window).toBe(1048576);
    expect(pro.max_output_tokens).toBe(384000);
    // Without this the unified catalogue cannot tell OpenRouter's
    // `deepseek/deepseek-v4-pro` from DeepSeek's own, nor pick the key to call it.
    expect(pro.provider).toBe("openrouter");
    expect(models.every((m) => m.provider === "openrouter")).toBe(true);
  });

  it("answers null rather than a guess when a ceiling is not published", async () => {
    stub(CATALOGUE);

    const models = await adapterFor("openrouter").listModels();

    expect(models.find((m) => m.id === "some/no-tools-model")!.max_output_tokens).toBeNull();
  });

  it("asks the catalogue over GET, with the key attached", async () => {
    stub(CATALOGUE);

    await adapterFor("openrouter").listModels();

    expect(calls[0]!.url).toBe("https://openrouter.ai/api/v1/models");
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.headers.Authorization).toBe("Bearer sk-or-not-real");
  });
});

describe("listModels: DeepSeek", () => {
  it("reads the bare OpenAI-shaped catalogue without inventing what it omits", async () => {
    // `GET https://api.deepseek.com/v1/models` publishes exactly this and
    // nothing more — no created, no context length, no pricing, no capabilities.
    stub({
      object: "list",
      data: [
        { id: "deepseek-v4-pro", object: "model", owned_by: "deepseek" },
        { id: "deepseek-v4-flash", object: "model", owned_by: "deepseek" },
      ],
    });

    const models = await adapterFor("deepseek").listModels();

    expect(models).toEqual([
      {
        id: "deepseek-v4-pro",
        label: "deepseek-v4-pro",
        context_window: null,
        max_output_tokens: null,
        supports_tools: false,
        rate: null,
        released_at: null,
        provider: "deepseek",
      },
      {
        id: "deepseek-v4-flash",
        label: "deepseek-v4-flash",
        context_window: null,
        max_output_tokens: null,
        supports_tools: false,
        rate: null,
        released_at: null,
        provider: "deepseek",
      },
    ]);
  });

  it("leaves released_at null, which a year filter must decide about explicitly", async () => {
    stub({ data: [{ id: "deepseek-v4-pro", object: "model", owned_by: "deepseek" }] });

    const models = await adapterFor("deepseek").listModels();

    // Null here is "the catalogue does not say", not "old" and not "recent".
    expect(models[0]!.released_at).toBeNull();
  });

  it("hits the DeepSeek catalogue URL", async () => {
    stub({ data: [] });
    await adapterFor("deepseek").listModels();
    expect(calls[0]!.url).toBe("https://api.deepseek.com/v1/models");
  });
});

describe("listModels: OpenAI", () => {
  it("reads id and created, and answers null for everything OpenAI omits", async () => {
    stub({
      object: "list",
      data: [
        { id: "gpt-5.2", object: "model", created: 1741651200, owned_by: "system" },
        { id: "gpt-5.2-mini", object: "model", created: 1741651200, owned_by: "system" },
      ],
    });

    const models = await adapterFor("openai").listModels();

    expect(models[0]).toEqual({
      id: "gpt-5.2",
      label: "gpt-5.2",
      // `/v1/models` publishes no window, no ceiling, no price and no
      // capability list, so these are facts about the catalogue, not gaps.
      context_window: null,
      max_output_tokens: null,
      supports_tools: false,
      rate: null,
      released_at: "2025-03-11T00:00:00.000Z",
      provider: "openai",
    });
    expect(models).toHaveLength(2);
  });

  it("survives a catalogue entry with no created field", async () => {
    stub({ data: [{ id: "gpt-5.2", object: "model" }] });

    const models = await adapterFor("openai").listModels();

    expect(models[0]!.released_at).toBeNull();
  });

  it("skips an entry with no id rather than minting an empty one", async () => {
    stub({ data: [{ object: "model", created: 1741651200 }, { id: "gpt-5.2", created: 1741651200 }] });

    const models = await adapterFor("openai").listModels();

    expect(models.map((m) => m.id)).toEqual(["gpt-5.2"]);
  });

  it("hits the OpenAI catalogue URL over GET", async () => {
    stub({ data: [] });
    await adapterFor("openai").listModels();
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/models");
    expect(calls[0]!.method).toBe("GET");
  });
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

describe("timeouts and cancellation", () => {
  it("stops a hung call at timeoutMs on the Responses wire", async () => {
    stubHanging();

    await expect(adapterFor("openai").chat(request({ timeoutMs: 20 }))).rejects.toMatchObject({
      status: 504,
    });
  });

  it("stops a hung call at timeoutMs on the Chat wire", async () => {
    stubHanging();

    await expect(adapterFor("deepseek").chat(request({ timeoutMs: 20 }))).rejects.toMatchObject({
      status: 504,
    });
  });

  it("lets the caller's signal cancel a call still inside its own budget", async () => {
    stubHanging();
    const controller = new AbortController();
    // Generous timeout: the point is that the signal, not the timer, is what
    // ends this. The round has to be able to stop a call that is not late yet.
    const pending = adapterFor("openrouter").chat(
      request({ timeoutMs: 60_000, signal: controller.signal }),
    );
    setTimeout(() => controller.abort(), 5);

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("refuses before opening a socket when the signal is already aborted", async () => {
    stubHanging();
    const controller = new AbortController();
    controller.abort();

    await expect(
      adapterFor("deepseek").chat(request({ signal: controller.signal })),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toHaveLength(0);
  });

  it("cancels listModels through its signal too", async () => {
    stubHanging();
    const controller = new AbortController();
    const pending = adapterFor("openrouter").listModels(controller.signal);
    setTimeout(() => controller.abort(), 5);

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

// ---------------------------------------------------------------------------
// Errors and keys
// ---------------------------------------------------------------------------

describe("errors", () => {
  it("surfaces the provider's own message and status", async () => {
    stub({ error: { message: "model not found" } }, { ok: false, status: 404 });

    await expect(adapterFor("openrouter").chat(request())).rejects.toMatchObject({
      status: 404,
      message: "model not found",
    });
  });

  it("refuses with a 500 naming the variable when the key is missing", async () => {
    delete process.env.DEEPSEEK_API_KEY;
    stub({ model: "m", choices: [] });

    await expect(adapterFor("deepseek").chat(request())).rejects.toMatchObject({ status: 500 });
    // Resolved through `providers/keys.ts`, so the second key source a later
    // wave adds is picked up here for free.
    expect(calls).toHaveLength(0);
  });
});

describe("createOpenAIChatAdapter", () => {
  it("builds an adapter for any OpenAI-compatible host", async () => {
    const adapter = createOpenAIChatAdapter({
      provider: "deepseek",
      baseUrl: "https://example.test/v1/",
      headers: { "X-Custom": "yes" },
    });
    stub({ model: "m", choices: [{ message: { content: "ok" } }] });

    await adapter.chat(request());

    // The trailing slash is absorbed rather than doubled into `//chat`.
    expect(calls[0]!.url).toBe("https://example.test/v1/chat/completions");
    expect(calls[0]!.headers["X-Custom"]).toBe("yes");
    expect(adapter.wire).toBe("openai-chat");
  });
});
