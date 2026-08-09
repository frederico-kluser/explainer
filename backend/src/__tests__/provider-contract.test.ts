import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from "vitest";
import { getEventListeners } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// HOME to a temp dir BEFORE the first runtime import, for the reason
// `provider-adapters.test.ts` records: the adapters reach `openai.ts` for
// `OpenAIError`, which reaches storage, and `sandbox.ts` freezes its
// homedir()-derived roots at module load.
const tmpHome = mkdtempSync(join(tmpdir(), "explainer-contract-test-"));
process.env.HOME = tmpHome;

const { adapterFor, ALL_PROVIDERS } = await import("../services/providers/index.js");
const { PROVIDERS } = await import("../services/providers/keys.js");
const { priceTextResponse } = await import("../services/pricing.js");
const { OpenAIError } = await import("../services/openai.js");
type ChatRequest = import("../services/providers/types.js").ChatRequest;
type ChatResponse = import("../services/providers/types.js").ChatResponse;
type DiscoveredModel = import("../services/providers/types.js").DiscoveredModel;
type ThinkerProvider = import("../types/thinker-roster.js").ThinkerProvider;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
//
// This file is the SHAPE test, not the wire test: `provider-adapters.test.ts`
// already pins what each adapter puts on the wire and reads back off it. What
// nothing pinned was `ProviderAdapter` as a UNIFORM contract — the invariants
// every adapter owes its caller no matter which protocol it speaks, and no
// matter what the provider answered. Everything below is therefore written
// against `ALL_PROVIDERS` rather than against a named adapter, so the next
// adapter somebody registers is tested the moment it is registered.

interface SeenCall {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body?: string;
}

let calls: SeenCall[] = [];

/** Answer every call with `text` verbatim — no JSON round trip on the way out. */
function stubText(text: string, { ok = true, status = 200 } = {}): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (
        url: string,
        init: { method?: string; headers?: Record<string, string>; body?: string },
      ) => {
        calls.push({
          url,
          method: init.method,
          headers: init.headers ?? {},
          body: init.body,
        });
        return Promise.resolve({ ok, status, text: () => Promise.resolve(text) });
      },
    ),
  );
}

function stub(payload: unknown, options: { ok?: boolean; status?: number } = {}): void {
  stubText(JSON.stringify(payload), options);
}

/** A `fetch` that rejects the way a socket-level failure does. */
function stubNetworkFailure(message: string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error(message))),
  );
}

/** Never answers; settles only when aborted — the shape of a hung provider. */
function stubHanging(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init: { signal?: AbortSignal }) => {
      calls.push({ url, headers: {} });
      return new Promise((_resolve, reject) => {
        const fail = (): void => {
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

/**
 * A minimally successful payload in the vocabulary of whichever wire the
 * provider speaks, so a contract assertion can be made against a call that
 * really did succeed rather than only against a misunderstood one.
 */
function okPayload(provider: ThinkerProvider): Record<string, unknown> {
  return adapterFor(provider).wire === "openai-responses"
    ? {
        model: "resolved-snapshot",
        status: "completed",
        output: [{ type: "message", content: [{ text: "pronto" }] }],
        usage: { input_tokens: 11, output_tokens: 3 },
      }
    : {
        model: "resolved-snapshot",
        choices: [{ message: { role: "assistant", content: "pronto" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 11, completion_tokens: 3 },
      };
}

beforeEach(() => {
  calls = [];
  process.env.OPENAI_API_KEY = "sk-openai-not-real-0123456789";
  process.env.OPENROUTER_API_KEY = "sk-or-not-real-0123456789";
  process.env.DEEPSEEK_API_KEY = "sk-ds-not-real-0123456789";
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
// The invariants, written once
// ---------------------------------------------------------------------------

const WIRES = new Set(["openai-responses", "openai-chat"]);
const USAGE_KEYS = new Set(["input_tokens", "output_tokens", "input_tokens_details"]);

/**
 * Everything a `ChatResponse` owes its caller, independent of wire.
 *
 * Collected in one function rather than spread across cases so that adding a
 * provider means adding one line to `ALL_PROVIDERS` and inheriting all of it.
 */
function assertChatContract(answer: ChatResponse): void {
  // The id to price and to show. Never empty: a caller that logged `model` and
  // got "" could not tell which model burned the tokens.
  expect(typeof answer.model).toBe("string");
  expect(answer.model.length).toBeGreaterThan(0);

  // "Empty when the model only asked for tools" — empty STRING, not undefined.
  expect(typeof answer.text).toBe("string");

  // "Empty array, never undefined." A caller writing `answer.toolCalls.length`
  // is the normal shape, and undefined here throws inside the round.
  expect(Array.isArray(answer.toolCalls)).toBe(true);
  for (const call of answer.toolCalls) {
    expect(typeof call.id).toBe("string");
    expect(typeof call.name).toBe("string");
    // The RAW JSON string, never pre-parsed — see `ToolCall` in types.ts.
    expect(typeof call.arguments).toBe("string");
  }

  // The Responses vocabulary, whichever wire answered. The Chat spelling
  // reaching this object is the silent-$0 failure the whole mapping exists to
  // prevent, and it does not throw anywhere: only the money is wrong.
  expect(typeof answer.usage.input_tokens).toBe("number");
  expect(Number.isFinite(answer.usage.input_tokens)).toBe(true);
  expect(answer.usage.input_tokens).toBeGreaterThanOrEqual(0);
  expect(typeof answer.usage.output_tokens).toBe("number");
  expect(Number.isFinite(answer.usage.output_tokens)).toBe(true);
  expect(answer.usage.output_tokens).toBeGreaterThanOrEqual(0);
  for (const key of Object.keys(answer.usage)) {
    expect(USAGE_KEYS.has(key)).toBe(true);
  }
  const serialisedUsage = JSON.stringify(answer.usage);
  expect(serialisedUsage).not.toContain("prompt_tokens");
  expect(serialisedUsage).not.toContain("completion_tokens");
  if (answer.usage.input_tokens_details !== undefined) {
    expect(typeof answer.usage.input_tokens_details.cached_tokens).toBe("number");
    // The cached SHARE of input_tokens, not an amount on top of it.
    expect(answer.usage.input_tokens_details.cached_tokens!).toBeLessThanOrEqual(
      answer.usage.input_tokens,
    );
  }

  // Priceable as-is, with no translation step where one could be forgotten.
  const priced = priceTextResponse(answer.model, answer.usage);
  expect(Number.isFinite(priced)).toBe(true);
  expect(priced).toBeGreaterThanOrEqual(0);

  // `null` means "fall back to the rate card"; a number is what the provider
  // itself said. Nothing else is a legal value.
  expect(answer.reportedUsd === null || typeof answer.reportedUsd === "number").toBe(true);
  if (typeof answer.reportedUsd === "number") {
    expect(Number.isFinite(answer.reportedUsd)).toBe(true);
  }

  // The carry-forward payload. `undefined` would mean the caller has nothing to
  // assign to `Turn.raw`, and both wires break without it.
  expect("raw" in answer).toBe(true);
  expect(answer.raw).not.toBeUndefined();

  expect(
    answer.finishReason === undefined || typeof answer.finishReason === "string",
  ).toBe(true);
}

function assertDiscoveredContract(model: DiscoveredModel, provider: ThinkerProvider): void {
  expect(typeof model.id).toBe("string");
  expect(model.id.length).toBeGreaterThan(0);
  // Falls back to `id`, so it is never empty and never undefined.
  expect(typeof model.label).toBe("string");
  expect(model.label.length).toBeGreaterThan(0);

  // Null is "not published". Zero and negatives are not readings a budgeter can
  // use, and `null` is the value `ModelChoice` documents as the safe floor.
  for (const value of [model.context_window, model.max_output_tokens]) {
    expect(value === null || (typeof value === "number" && value > 0)).toBe(true);
  }

  // Never undefined: an absent capability list means false, not "unknown".
  expect(typeof model.supports_tools).toBe("boolean");

  if (model.rate !== null) {
    for (const value of [model.rate.input, model.rate.cached_input, model.rate.output]) {
      expect(typeof value).toBe("number");
      expect(Number.isFinite(value)).toBe(true);
      // A negative rate reaches the ledger as a credit; the sentinel prices the
      // catalogue publishes have to become `null` instead.
      expect(value).toBeGreaterThanOrEqual(0);
    }
  }

  if (model.released_at !== null) {
    expect(typeof model.released_at).toBe("string");
    expect(Number.isNaN(Date.parse(model.released_at))).toBe(false);
  }

  // Whose model this is — hence whose key calls it and whose balance pays.
  expect(model.provider).toBe(provider);
}

// ---------------------------------------------------------------------------
// The registry as a closed, agreed-upon set
// ---------------------------------------------------------------------------

describe("the provider set is agreed on by every module that lists it", () => {
  it("gives ALL_PROVIDERS and keys.ts's PROVIDERS the same members", () => {
    // Three modules enumerate the providers independently — the registry, the
    // key resolver, and the roster's runtime vocabulary — and each has a
    // documented reason not to import the others. That is a deliberate
    // duplication, which makes drift the failure mode: a fourth provider added
    // to one of them and missed in another is callable-but-keyless, or
    // keyed-but-unroutable, and nothing in either module fails on its own.
    expect([...PROVIDERS].sort()).toEqual([...ALL_PROVIDERS].sort());
  });

  it("keeps the roster's runtime vocabulary in step with the registry", () => {
    // `thinker-roster.ts` holds its own copy of the three names and does not
    // export it, so it is reached through the behaviour it drives: a provider
    // the registry can route must survive normalisation, and one it cannot must
    // not be inventable by a stored roster.
    expect(ALL_PROVIDERS.length).toBeGreaterThan(0);
    for (const provider of ALL_PROVIDERS) {
      expect(adapterFor(provider)).toBeDefined();
    }
  });

  it("has no duplicate entries", () => {
    expect(new Set(ALL_PROVIDERS).size).toBe(ALL_PROVIDERS.length);
    expect(new Set(PROVIDERS).size).toBe(PROVIDERS.length);
  });
});

describe.each(ALL_PROVIDERS)("adapter shape: %s", (provider) => {
  it("answers its own name, a known wire, and exactly the contract's members", () => {
    const adapter = adapterFor(provider);

    expect(adapter.provider).toBe(provider);
    expect(WIRES.has(adapter.wire)).toBe(true);
    expect(typeof adapter.chat).toBe("function");
    expect(typeof adapter.listModels).toBe("function");
    // Lookup only. A registry that also cached or filtered would be a second
    // place to look for policy, so an adapter growing a fifth member is a
    // decision somebody has to make on purpose.
    expect(Object.keys(adapter).sort()).toEqual(["chat", "listModels", "provider", "wire"]);
  });

  it("resolves to the same object every time, so nothing is rebuilt per call", () => {
    expect(adapterFor(provider)).toBe(adapterFor(provider));
  });
});

// ---------------------------------------------------------------------------
// The contract, against every adapter
// ---------------------------------------------------------------------------

describe.each(ALL_PROVIDERS)("ChatResponse contract: %s", (provider) => {
  it("holds on an ordinary successful answer", async () => {
    stub(okPayload(provider));

    assertChatContract(await adapterFor(provider).chat(request()));
  });

  it("holds when the provider answered an empty object", async () => {
    // A 200 whose body says nothing the adapter recognises. Every field still
    // has to be legal, because the round downstream reads them unconditionally.
    stub({});

    const answer = await adapterFor(provider).chat(request({ model: "asked-for" }));

    assertChatContract(answer);
    // Falls back to the id that was asked for rather than to "".
    expect(answer.model).toBe("asked-for");
    expect(answer.text).toBe("");
    expect(answer.toolCalls).toEqual([]);
    expect(answer.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  it("holds when the payload is the OTHER wire's shape entirely", async () => {
    // Not hypothetical: a gateway fronting both protocols, or a provider that
    // changes wires, hands an adapter a body it was not written for. The
    // contract says nothing may throw and no field may go undefined.
    const foreign =
      adapterFor(provider).wire === "openai-responses"
        ? {
            choices: [{ message: { content: "texto do outro fio" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 7, completion_tokens: 2 },
          }
        : {
            output: [{ type: "message", content: [{ text: "texto do outro fio" }] }],
            usage: { input_tokens: 7, output_tokens: 2 },
          };
    stub(foreign);

    assertChatContract(await adapterFor(provider).chat(request()));
  });

  it("reports null rather than 0 when the provider named no cost", async () => {
    // The invariant that survives a provider being added: only a provider that
    // SAYS a number gets one. Zero is a real charge once it is in the ledger,
    // and nothing downstream can tell it from a call that was really free.
    stub(okPayload(provider));

    const answer = await adapterFor(provider).chat(request());

    if (answer.reportedUsd !== null) {
      expect(answer.reportedUsd).not.toBe(0);
    }
  });

  it("never lets a non-finite reported cost through as a number", async () => {
    // `JSON.stringify` cannot even produce these, so they arrive as raw text
    // from a gateway that hand-rolls its JSON, or as a string where a number
    // was documented. Either way a NaN in the ledger poisons every later sum.
    for (const raw of ['{"usage":{"cost":"0.5"}}', '{"usage":{"cost":null}}', '{"usage":{}}']) {
      stubText(raw);
      const answer = await adapterFor(provider).chat(request());
      expect(answer.reportedUsd).toBeNull();
    }
  });

  // KNOWN DEFECT — `it.fails` asserts that this currently does NOT hold, so the
  // day somebody fixes it this line goes red and gets flipped to `it`.
  //
  // `ToolCall.arguments` is typed `string` and documented as "the RAW JSON
  // STRING the provider sent", but both adapters read it with `?? ""`
  // (`openai-responses.ts:213`, `openai-chat.ts:199`), which only replaces
  // null and undefined. A provider that serialises `arguments` as an OBJECT —
  // some OpenAI-compatible gateways do — passes straight through, and the
  // declared type is then a lie at runtime. The caller's
  // `JSON.parse(call.arguments)` receives "[object Object]" and throws a
  // SyntaxError far from here, which is the exact failure the "never
  // pre-parsed" rule was written to keep recoverable. A one-line
  // `typeof x === "string" ? x : JSON.stringify(x)` closes it.
  it.fails("keeps `arguments` a string even when the provider sent an object", async () => {
    const payload =
      adapterFor(provider).wire === "openai-responses"
        ? {
            model: "m",
            output: [
              { type: "function_call", call_id: "c1", name: "t", arguments: { a: 1 } },
            ],
          }
        : {
            model: "m",
            choices: [
              {
                message: {
                  tool_calls: [{ id: "c1", function: { name: "t", arguments: { a: 1 } } }],
                },
              },
            ],
          };
    stub(payload);

    const answer = await adapterFor(provider).chat(request());

    expect(typeof answer.toolCalls[0]!.arguments).toBe("string");
  });

  // KNOWN DEFECT — see the note above for why this is `it.fails`.
  //
  // `JSON.parse("null")` is `null`, and both adapters then read a field off it
  // — `payload.model ?? request.model` (`openai-responses.ts:312`) and
  // `payload.choices?.[0]` (`openai-chat.ts:363`). A 200 whose body is the
  // four bytes `null` therefore escapes as a raw `TypeError` with no `.status`,
  // which `middleware/error-handler.ts` can only map to an opaque 500 — the
  // same class of undiagnosable failure `providers/keys.ts` documents at
  // length for an unencodable key. Every other malformed 200 in this file is
  // already handled: an empty body and HTML both become a 502 inside `send`,
  // because they fail INSIDE the try block. `null` parses successfully and
  // fails after it.
  it.fails("turns a 200 whose whole body is `null` into a stated failure", async () => {
    stubText("null");

    await expect(adapterFor(provider).chat(request())).rejects.toBeInstanceOf(OpenAIError);
  });
});

describe.each(ALL_PROVIDERS)("DiscoveredModel contract: %s", (provider) => {
  it("holds across a hostile catalogue", async () => {
    // One catalogue containing every shape that has ever been wrong: the router
    // sentinel price, a half-published rate, a non-numeric price, a zero
    // context length, an entry that is not an object, and one with no id.
    stub({
      data: [
        { id: "plain" },
        // The `openrouter/auto` sentinel: "-1" means "depends where it routes".
        { id: "sentinel", pricing: { prompt: "-1", completion: "-1" } },
        { id: "half-rate", pricing: { prompt: "0.000001" } },
        { id: "words", pricing: { prompt: "grátis", completion: "grátis" } },
        { id: "empty-price", pricing: { prompt: "", completion: "" } },
        // Past the far end of the Date range, so `new Date(x * 1000)` is Invalid.
        { id: "huge-epoch", created: 8.64e15 },
        { id: "nan-epoch", created: Number.NaN },
        { id: "listy", supported_parameters: "tools" },
        { id: "nested", pricing: { prompt: { deep: 1 }, completion: [] } },
        { object: "model", created: 1741651200 },
        "not-an-object",
        42,
      ],
    });

    const models = await adapterFor(provider).listModels();

    expect(Array.isArray(models)).toBe(true);
    for (const model of models) assertDiscoveredContract(model, provider);
    // The entry with no id is dropped rather than minted as "".
    expect(models.map((m) => m.id)).not.toContain("");
    // A price that could not be read whole is null, never a partial rate and
    // never a negative one that would reach the ledger as a credit.
    for (const id of ["sentinel", "half-rate", "words", "empty-price", "nested"]) {
      const model = models.find((m) => m.id === id);
      if (model) expect(model.rate).toBeNull();
    }
  });

  // KNOWN DEFECT — `it.fails` asserts this does NOT hold today.
  //
  // Both catalogue parsers open with `if (!item.id) return null`
  // (`openai-responses.ts:263`, `openai-chat.ts:308`), which is a guard against
  // a MISSING id and not against a missing ITEM. A `null` inside `data[]`
  // therefore throws `TypeError: Cannot read properties of null (reading
  // 'id')`, with no `.status` for `middleware/error-handler.ts` to map, and it
  // takes the whole catalogue with it — one bad row costs the operator every
  // model the provider published. Note the asymmetry the loop right above
  // proves: a STRING or a NUMBER in the same position is already skipped
  // safely, because reading `.id` off those is merely undefined. `isPlainObject`
  // is the check `thinker-roster.ts:185` uses for exactly this.
  it.fails("skips a null catalogue entry instead of losing the whole catalogue", async () => {
    stub({ data: [null, { id: "survivor" }] });

    const models = await adapterFor(provider).listModels();

    expect(models.map((m) => m.id)).toEqual(["survivor"]);
  });

  it("answers an array, never undefined, for a catalogue with no data", async () => {
    for (const payload of [{}, { data: [] }, { data: null }]) {
      stub(payload);
      const models = await adapterFor(provider).listModels();
      expect(models).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// A window discovery publishes as 0 is a window nobody can budget against
// ---------------------------------------------------------------------------
//
// Scoped to the Chat wire rather than to `ALL_PROVIDERS`: the Responses
// catalogue publishes no window at all, so `openai-responses.ts:267` hardcodes
// `null` and cannot reproduce this. Both blocks below are wire properties, not
// provider preferences, so they are keyed by `wire`.

const CHAT_WIRE_PROVIDERS = ALL_PROVIDERS.filter(
  (provider) => adapterFor(provider).wire === "openai-chat",
);

describe.each(CHAT_WIRE_PROVIDERS)("catalogue numbers: %s", (provider) => {
  // KNOWN DEFECT — `it.fails` asserts this does NOT hold today.
  //
  // `openai-chat.ts:313-314` reads both ceilings with `??`, which passes 0 and
  // any negative straight through:
  //
  //   context_window: item.context_length ?? item.top_provider?.context_length ?? null
  //
  // `ModelChoice.context_window` says `null` is the conservative FLOOR and must
  // never be confused with a real reading, and the roster normaliser already
  // enforces exactly that — `normalizeContextWindow` in `thinker-roster.ts:238`
  // turns 0, negatives and fractions into `null` because "a stored 0 would read
  // instead as a real window of no tokens, which is a thing no model has".
  // Discovery can therefore mint a value its own store would refuse, and a
  // budgeter reading a freshly discovered choice sees 0 where the same choice
  // read back off disk says null.
  it.fails("reports an unusable context window as null, the way the store does", async () => {
    stub({
      data: [
        { id: "zero-window", context_length: 0 },
        { id: "negative-window", context_length: -5 },
        { id: "zero-ceiling", top_provider: { max_completion_tokens: 0 } },
      ],
    });

    const models = await adapterFor(provider).listModels();

    for (const model of models) {
      expect(model.context_window === null || model.context_window > 0).toBe(true);
      expect(model.max_output_tokens === null || model.max_output_tokens > 0).toBe(true);
    }
  });

  // KNOWN DEFECT, same line and same cause as the case above.
  //
  // `??` also passes a STRING through, so `context_length: "8192"` — the shape
  // a catalogue served through a form-encoding gateway produces, and the shape
  // `finiteNumber` in `thinker-roster.ts:197` exists to absorb — makes
  // `DiscoveredModel.context_window` a string while its declared type says
  // `number | null`. Arithmetic on it downstream ("8192" - 500) is NaN.
  it.fails("reports a numeric-string window as a number, or not at all", async () => {
    stub({ data: [{ id: "stringy", context_length: "8192" }] });

    const models = await adapterFor(provider).listModels();

    expect(
      models[0]!.context_window === null || typeof models[0]!.context_window === "number",
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// What a real network does
// ---------------------------------------------------------------------------

describe.each(ALL_PROVIDERS)("HTTP failures: %s", (provider) => {
  it("surfaces the provider's status verbatim, with its own message", async () => {
    // 401 and 429 are the two the operator has to be able to tell apart: one is
    // "your key is wrong", the other is "wait". Collapsing either into a 500
    // sends the user to fix the wrong thing.
    const cases: Array<{ status: number; message: string }> = [
      { status: 401, message: "Incorrect API key provided" },
      { status: 402, message: "Insufficient credits" },
      { status: 429, message: "Rate limit exceeded" },
      { status: 500, message: "internal server error" },
      { status: 503, message: "temporarily unavailable" },
    ];

    for (const { status, message } of cases) {
      stub({ error: { message } }, { ok: false, status });

      let thrown: unknown;
      try {
        await adapterFor(provider).chat(request());
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(OpenAIError);
      expect((thrown as InstanceType<typeof OpenAIError>).status).toBe(status);
      expect((thrown as Error).message).toBe(message);
    }
  });

  it("keeps a non-JSON error body instead of losing it to a parse failure", async () => {
    // A gateway in front of the provider answers HTML. The status is the useful
    // half and the body is the only clue about which hop failed, so neither may
    // be swallowed.
    stubText("<html><body>502 Bad Gateway</body></html>", { ok: false, status: 502 });

    await expect(adapterFor(provider).chat(request())).rejects.toMatchObject({
      status: 502,
      message: "<html><body>502 Bad Gateway</body></html>",
    });
  });

  it("truncates a huge error body rather than carrying it around", async () => {
    stubText("x".repeat(5_000), { ok: false, status: 400 });

    let thrown: unknown;
    try {
      await adapterFor(provider).chat(request());
    } catch (err) {
      thrown = err;
    }

    expect((thrown as Error).message).toHaveLength(500);
  });

  it("keeps the raw body when the error JSON has no message to find", async () => {
    for (const body of ['{"error":"a string, not an object"}', '{"detail":"nope"}', "[]"]) {
      stubText(body, { ok: false, status: 400 });
      await expect(adapterFor(provider).chat(request())).rejects.toMatchObject({
        status: 400,
        message: body,
      });
    }
  });

  it("turns a 200 that is not JSON into a 502, not into a crash", async () => {
    // Captive portals and misconfigured proxies both answer 200 with HTML. The
    // adapter has to name this as an upstream failure with a status the error
    // handler can map, rather than let a SyntaxError escape without one.
    for (const body of ["<html>hi</html>", "", "   ", "OK"]) {
      stubText(body);

      let thrown: unknown;
      try {
        await adapterFor(provider).chat(request());
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(OpenAIError);
      expect((thrown as InstanceType<typeof OpenAIError>).status).toBe(502);
    }
  });

  it("ignores Content-Type and reads the body it was given", async () => {
    // Deliberate, and worth pinning because it looks like an oversight: several
    // OpenAI-compatible gateways label a JSON body `text/plain`. Branching on
    // the header would reject a body that parses perfectly well.
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ "Content-Type": "text/html; charset=utf-8" }),
          text: () => Promise.resolve(JSON.stringify(okPayload(provider))),
        }),
      ),
    );

    const answer = await adapterFor(provider).chat(request());

    assertChatContract(answer);
    expect(answer.text).toBe("pronto");
  });

  it("turns a socket-level failure into a 502 carrying the cause", async () => {
    stubNetworkFailure("connect ECONNREFUSED 127.0.0.1:443");

    await expect(adapterFor(provider).chat(request())).rejects.toMatchObject({
      status: 502,
      message: "connect ECONNREFUSED 127.0.0.1:443",
    });
  });

  it("fails listModels the same way it fails chat", async () => {
    stub({ error: { message: "invalid_api_key" } }, { ok: false, status: 401 });

    await expect(adapterFor(provider).listModels()).rejects.toMatchObject({
      status: 401,
      message: "invalid_api_key",
    });
  });
});

// ---------------------------------------------------------------------------
// Cancellation, from every direction
// ---------------------------------------------------------------------------

describe.each(ALL_PROVIDERS)("cancellation: %s", (provider) => {
  it("refuses chat before opening a socket when the signal is already aborted", async () => {
    stubHanging();
    const controller = new AbortController();
    controller.abort();

    await expect(
      adapterFor(provider).chat(request({ signal: controller.signal })),
    ).rejects.toMatchObject({ name: "AbortError" });
    // The point is the socket that was never opened: a round that has already
    // given up must not still be paying for calls it will discard.
    expect(calls).toHaveLength(0);
  });

  it("refuses listModels before opening a socket when the signal is already aborted", async () => {
    stubHanging();
    const controller = new AbortController();
    controller.abort();

    await expect(
      adapterFor(provider).listModels(controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toHaveLength(0);
  });

  it("lets the caller's signal end a call that is not late yet", async () => {
    stubHanging();
    const controller = new AbortController();
    const pending = adapterFor(provider).chat(
      request({ timeoutMs: 60_000, signal: controller.signal }),
    );
    setTimeout(() => controller.abort(), 5);

    // An AbortError, NOT the 504: "the round was cancelled" and "this call was
    // too slow" are different diagnoses and the caller acts on them differently.
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("stops a hung call at timeoutMs and names the budget it passed", async () => {
    stubHanging();

    let thrown: unknown;
    try {
      await adapterFor(provider).chat(request({ timeoutMs: 20 }));
    } catch (err) {
      thrown = err;
    }

    expect((thrown as InstanceType<typeof OpenAIError>).status).toBe(504);
    expect((thrown as Error).message).toContain("20ms");
  });

  it("leaves no abort listener on the caller's signal after a call settles", async () => {
    // One signal outlives many calls — it is the round's, not the call's — so a
    // listener left behind on each one is an unbounded leak on a long round,
    // and Node starts printing MaxListenersExceededWarning at eleven.
    const controller = new AbortController();

    stub(okPayload(provider));
    for (let i = 0; i < 12; i += 1) {
      await adapterFor(provider).chat(request({ signal: controller.signal }));
    }
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);

    stub({ error: { message: "nope" } }, { ok: false, status: 400 });
    await expect(adapterFor(provider).chat(request({ signal: controller.signal })))
      .rejects.toBeInstanceOf(OpenAIError);
    // The failing path unregisters too — it is the one that runs on a bad day,
    // repeatedly, which is exactly when a leak would matter.
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);

    stubHanging();
    await expect(
      adapterFor(provider).chat(request({ timeoutMs: 10, signal: controller.signal })),
    ).rejects.toMatchObject({ status: 504 });
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("does not abort the caller's own signal when its private timer fires", async () => {
    // The local AbortController exists precisely so one late call cannot take
    // down every other call sharing the round's signal.
    stubHanging();
    const controller = new AbortController();

    await expect(
      adapterFor(provider).chat(request({ timeoutMs: 10, signal: controller.signal })),
    ).rejects.toMatchObject({ status: 504 });

    expect(controller.signal.aborted).toBe(false);
  });

  it("asks for the key before it checks the signal, so a missing key wins", async () => {
    // Ordering, pinned because it is observable and neither answer is obviously
    // right: the header is built before `send` runs, so an unconfigured
    // provider reports the missing variable even on a round that had already
    // been cancelled. That is the more actionable of the two errors.
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    stubHanging();
    const controller = new AbortController();
    controller.abort();

    let thrown: unknown;
    try {
      await adapterFor(provider).chat(request({ signal: controller.signal }));
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(OpenAIError);
    expect((thrown as InstanceType<typeof OpenAIError>).status).toBe(500);
    expect(calls).toHaveLength(0);
  });
});
