import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from "vitest";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

// HOME first: `sandbox.ts` freezes its homedir()-derived roots at module load
// and `thinker-roster.ts` resolves ROSTER_PATH from them, so this file cannot
// be allowed to touch the real ~/.local/share/voice-assistant.
const tmpHome = mkdtempSync(join(tmpdir(), "explainer-composition-test-"));
process.env.HOME = tmpHome;

// The defaults follow the environment, and half the assertions below compare a
// roster against them.
delete process.env.OPENAI_DEEPTHINK_MODEL;
delete process.env.OPENAI_TEXT_MODEL;
delete process.env.DEEP_THINK_THINKERS;

// Captured before anything stubs the global: the route cases below talk to a
// real socket, and they must keep doing so while the adapter cases replace
// `fetch` wholesale.
const realFetch = globalThis.fetch.bind(globalThis);

const { adapterFor, ALL_PROVIDERS } = await import("../services/providers/index.js");
const {
  clearProviderKey,
  providerKey,
  providerKeyPresent,
  providerKeyStatus,
  setProviderKey,
} = await import("../services/providers/keys.js");
const providerKeysRouter = (await import("../routes/provider-keys.js")).default;
const { errorHandler } = await import("../middleware/error-handler.js");
const { getRoster, setRoster, forgetRoster, ROSTER_PATH } = await import(
  "../services/thinker-roster.js"
);
const { priceWithRate } = await import("../services/pricing.js");
const { MAX_THINKERS } = await import("../types/thinker-roster.js");
type ChatRequest = import("../services/providers/types.js").ChatRequest;
type ThinkerProvider = import("../types/thinker-roster.js").ThinkerProvider;
type ModelChoice = import("../types/thinker-roster.js").ModelChoice;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
//
// Everything here crosses a module boundary on purpose. The three suites that
// already exist test `providers/keys.ts`, `providers/index.ts` and
// `thinker-roster.ts` one at a time, and each is thorough about its own module;
// none of them can see the seam. The seam is where the interesting failure is:
// a key that the setup screen reports as saved but that the next call does not
// use is a bug no single-module test can catch, because both modules are right.

const ENV: Record<ThinkerProvider, string> = {
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
};

const RUNTIME_KEY = "sk-runtime-typed-by-the-user-0123456789";
const ENV_KEY = "sk-stale-value-from-the-shell-9876543210";

interface SeenCall {
  url: string;
  headers: Record<string, string>;
  body?: string;
}

let calls: SeenCall[] = [];

function stub(payload: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init: { headers?: Record<string, string>; body?: string }) => {
      calls.push({ url, headers: init.headers ?? {}, body: init.body });
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify(payload)),
      });
    }),
  );
}

/** A payload each wire reads as a plain successful answer. */
function okPayload(provider: ThinkerProvider): Record<string, unknown> {
  return adapterFor(provider).wire === "openai-responses"
    ? { model: "m", output: [], usage: { input_tokens: 1, output_tokens: 1 } }
    : {
        model: "m",
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      };
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

/** The bearer token the last call actually put on the wire. */
function lastBearer(): string | undefined {
  return calls[calls.length - 1]?.headers.Authorization;
}

/** One chat call through `adapterFor`, answered by the stub. */
async function callThrough(provider: ThinkerProvider): Promise<void> {
  stub(okPayload(provider));
  await adapterFor(provider).chat(request());
}

const saved = new Map<string, string | undefined>();

beforeEach(() => {
  calls = [];
  for (const name of Object.values(ENV)) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
  for (const provider of ALL_PROVIDERS) clearProviderKey(provider);
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const provider of ALL_PROVIDERS) clearProviderKey(provider);
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  saved.clear();
});

// ---------------------------------------------------------------------------
// The route, mounted the way `index.ts` mounts it minus `loopbackOnly`
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use("/api/provider-keys", providerKeysRouter);
app.use(errorHandler);

const server: Server = app.listen(0);
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}/api/provider-keys`;

afterAll(() => {
  server.close();
  rmSync(tmpHome, { recursive: true, force: true });
});

function put(provider: string, body: unknown): Promise<Response> {
  return realFetch(`${base}/${provider}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function del(provider: string): Promise<Response> {
  return realFetch(`${base}/${provider}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// keys.ts × index.ts — the key the screen reports is the key the call sends
// ---------------------------------------------------------------------------

describe.each(ALL_PROVIDERS)("a runtime key reaches the wire: %s", (provider) => {
  it("is used by the very next call, with no restart in between", async () => {
    // The whole reason `providers/keys.ts` exists as one resolver. The adapter
    // never sees the store; it calls `providerKey(provider)` while building the
    // header, so a key typed a moment ago is on the next request by
    // construction. Assert it on the HEADER, not on `providerKey`: a resolver
    // that answered correctly while the adapter had captured the key at import
    // would pass every existing test in `provider-keys.test.ts`.
    expect(providerKeyPresent(provider)).toBe(false);

    setProviderKey(provider, RUNTIME_KEY);
    await callThrough(provider);

    expect(lastBearer()).toBe(`Bearer ${RUNTIME_KEY}`);
  });

  it("beats an environment variable on the wire, not just in the resolver", async () => {
    process.env[ENV[provider]] = ENV_KEY;
    setProviderKey(provider, RUNTIME_KEY);

    await callThrough(provider);

    expect(lastBearer()).toBe(`Bearer ${RUNTIME_KEY}`);
    expect(lastBearer()).not.toContain(ENV_KEY);
  });

  it("falls back to the environment on the wire once it is cleared", async () => {
    process.env[ENV[provider]] = ENV_KEY;
    setProviderKey(provider, RUNTIME_KEY);
    await callThrough(provider);
    expect(lastBearer()).toBe(`Bearer ${RUNTIME_KEY}`);

    clearProviderKey(provider);
    await callThrough(provider);

    // Clearing what the user typed does not unconfigure a provider the shell
    // already supplied, and the call proves it rather than the status flag.
    expect(lastBearer()).toBe(`Bearer ${ENV_KEY}`);
  });

  it("rotates between two calls in the same process", async () => {
    setProviderKey(provider, `${RUNTIME_KEY}-first`);
    await callThrough(provider);
    const first = lastBearer();

    setProviderKey(provider, `${RUNTIME_KEY}-second`);
    await callThrough(provider);

    expect(first).toBe(`Bearer ${RUNTIME_KEY}-first`);
    expect(lastBearer()).toBe(`Bearer ${RUNTIME_KEY}-second`);
  });

  it("resolves the same key for listModels as for chat", async () => {
    // Discovery and the round go through two different call sites in the
    // adapter; only one resolver stands behind both.
    setProviderKey(provider, RUNTIME_KEY);

    stub({ data: [] });
    await adapterFor(provider).listModels();
    const forDiscovery = lastBearer();
    await callThrough(provider);

    expect(forDiscovery).toBe(`Bearer ${RUNTIME_KEY}`);
    expect(lastBearer()).toBe(`Bearer ${RUNTIME_KEY}`);
  });

  it("refuses to call at all, and opens no socket, when neither source has one", async () => {
    stub(okPayload(provider));

    await expect(adapterFor(provider).chat(request())).rejects.toMatchObject({
      status: 500,
      message: expect.stringContaining(ENV[provider]) as unknown as string,
    });
    expect(calls).toHaveLength(0);
  });

  it("agrees with what providerKeyStatus reports, in all three states", async () => {
    // The claim the setup screen makes and the behaviour the round gets, pinned
    // against each other. A screen that says "runtime" while the call sends the
    // environment key is the exact bug the precedence rule was written to stop,
    // and neither module can notice it alone.
    expect(providerKeyStatus(provider)).toMatchObject({ present: false, source: null });

    process.env[ENV[provider]] = ENV_KEY;
    expect(providerKeyStatus(provider)).toMatchObject({ present: true, source: "env" });
    await callThrough(provider);
    expect(lastBearer()).toBe(`Bearer ${ENV_KEY}`);

    setProviderKey(provider, RUNTIME_KEY);
    expect(providerKeyStatus(provider)).toMatchObject({ present: true, source: "runtime" });
    await callThrough(provider);
    expect(lastBearer()).toBe(`Bearer ${RUNTIME_KEY}`);
  });
});

describe("keys stay on their own provider", () => {
  it("never sends one provider's key to another's host", async () => {
    // `adapterFor` routes by provider and `providerKey` is keyed by the same
    // name; nothing checks that the two agree. A single map lookup off by one
    // would send OpenRouter's key to DeepSeek, which 401s far from here.
    for (const provider of ALL_PROVIDERS) {
      setProviderKey(provider, `${RUNTIME_KEY}-${provider}`);
    }

    for (const provider of ALL_PROVIDERS) {
      await callThrough(provider);
      expect(lastBearer()).toBe(`Bearer ${RUNTIME_KEY}-${provider}`);
      for (const other of ALL_PROVIDERS) {
        if (other === provider) continue;
        expect(lastBearer()).not.toContain(`-${other}`);
      }
    }
  });

  it("leaves the other two unconfigured when only one is set", async () => {
    setProviderKey("openrouter", RUNTIME_KEY);
    stub(okPayload("deepseek"));

    await expect(adapterFor("deepseek").chat(request())).rejects.toMatchObject({ status: 500 });
    expect(calls).toHaveLength(0);
    // And the one that IS configured still works, so the refusal above is about
    // the provider and not about the store being broken.
    await callThrough("openrouter");
    expect(lastBearer()).toBe(`Bearer ${RUNTIME_KEY}`);
  });
});

// ---------------------------------------------------------------------------
// routes/provider-keys.ts × index.ts — the setup screen to the wire
// ---------------------------------------------------------------------------

describe("the HTTP route feeds the adapter", () => {
  it("makes a provider callable through a PUT, end to end", async () => {
    // The user story the route was added for, as one path: no key anywhere, the
    // user types one into the setup screen, and the very next model call
    // carries it — no restart, no file, no second source of truth.
    expect(providerKeyPresent("openrouter")).toBe(false);

    const res = await put("openrouter", { key: RUNTIME_KEY });
    expect(res.status).toBe(200);

    await callThrough("openrouter");
    expect(lastBearer()).toBe(`Bearer ${RUNTIME_KEY}`);
  });

  it("takes it away again through a DELETE", async () => {
    await put("deepseek", { key: RUNTIME_KEY });
    await callThrough("deepseek");
    expect(lastBearer()).toBe(`Bearer ${RUNTIME_KEY}`);

    const res = await del("deepseek");
    expect(res.status).toBe(200);

    calls = [];
    stub(okPayload("deepseek"));
    await expect(adapterFor("deepseek").chat(request())).rejects.toMatchObject({ status: 500 });
    expect(calls).toHaveLength(0);
  });

  it("leaves the environment underneath a DELETE, and the call proves it", async () => {
    process.env.OPENROUTER_API_KEY = ENV_KEY;
    await put("openrouter", { key: RUNTIME_KEY });
    await del("openrouter");

    await callThrough("openrouter");

    expect(lastBearer()).toBe(`Bearer ${ENV_KEY}`);
  });

  it("does not change what the wire carries when it rejects the key", async () => {
    // A 400 has to be inert. Storing a rejected value — or clearing the good
    // one on the way to rejecting — would take a working provider offline at
    // the moment the user was trying to fix it.
    await put("openai", { key: RUNTIME_KEY });

    for (const bad of [{ key: "" }, { key: "short" }, { key: 42 }, {}, { key: "a\r\nb" }]) {
      const res = await put("openai", bad);
      expect(res.status).toBe(400);
    }

    await callThrough("openai");
    expect(lastBearer()).toBe(`Bearer ${RUNTIME_KEY}`);
  });

  it("never lets a key reach the wire for a provider the route refused", async () => {
    const res = await put("anthropic", { key: RUNTIME_KEY });

    expect(res.status).toBe(400);
    for (const provider of ALL_PROVIDERS) {
      expect(providerKeyPresent(provider)).toBe(false);
    }
  });

  it("keeps the key out of the error a failed provider call produces", async () => {
    // The 401 body comes from the provider and travels to the client through
    // `errorHandler`. Nothing in the chain should have interpolated the key.
    await put("openrouter", { key: RUNTIME_KEY });
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 401,
          text: () => Promise.resolve('{"error":{"message":"Incorrect API key provided"}}'),
        }),
      ),
    );

    let thrown: unknown;
    try {
      await adapterFor("openrouter").chat(request());
    } catch (err) {
      thrown = err;
    }

    expect((thrown as Error).message).not.toContain(RUNTIME_KEY);
    expect(JSON.stringify(thrown)).not.toContain(RUNTIME_KEY);
  });
});

// ---------------------------------------------------------------------------
// thinker-roster.ts × index.ts × keys.ts
// ---------------------------------------------------------------------------

function choice(provider: ThinkerProvider, model: string): ModelChoice {
  return { provider, model, context_window: null, supports_tools: true, rate: null };
}

describe("a stored roster routes to an adapter", () => {
  it("resolves an adapter for every provider a roster can hold", async () => {
    // The roster stores a provider name; the registry turns it into something
    // callable. The two vocabularies are declared separately and on purpose —
    // `thinker-roster.ts:62` says so — so this is the assertion that they still
    // line up after a round trip through disk.
    for (const provider of ALL_PROVIDERS) {
      await setRoster({ master: choice(provider, `${provider}-model`) });
      forgetRoster();

      const roster = await getRoster();
      expect(roster.master.provider).toBe(provider);

      const adapter = adapterFor(roster.master.provider);
      expect(adapter.provider).toBe(provider);
      expect(typeof adapter.chat).toBe("function");
    }
  });

  it("reads a roster pointing at a provider with no key at all, without throwing", async () => {
    // The store's job is to hand back what was chosen; deciding whether it can
    // be PAID for belongs to the layer that calls. A store that consulted the
    // key resolver would make the settings screen unreadable on the machine
    // that most needs it — the one where nothing is configured yet.
    for (const provider of ALL_PROVIDERS) {
      expect(providerKeyPresent(provider)).toBe(false);
    }

    await setRoster({
      master: choice("deepseek", "deepseek-v4-pro"),
      planner: choice("openrouter", "openrouter/auto"),
      slots: Array.from({ length: MAX_THINKERS }, (_, i) => ({
        index: i + 1,
        enabled: true,
        model: choice("openrouter", `slot-${i + 1}`),
      })),
    });
    forgetRoster();

    const roster = await getRoster();

    expect(roster.master.provider).toBe("deepseek");
    expect(roster.planner.provider).toBe("openrouter");
    expect(roster.slots).toHaveLength(MAX_THINKERS);
    // Unpaid, but readable — and the failure arrives only when somebody calls.
    expect(providerKeyPresent(roster.master.provider)).toBe(false);
    stub(okPayload(roster.master.provider));
    await expect(
      adapterFor(roster.master.provider).chat(request({ model: roster.master.model })),
    ).rejects.toMatchObject({ status: 500 });
    expect(calls).toHaveLength(0);
  });

  it("calls the model the roster stored, with the key that roster's provider needs", async () => {
    await setRoster({ master: choice("openrouter", "deepseek/deepseek-v4-pro") });
    setProviderKey("openrouter", RUNTIME_KEY);
    const roster = await getRoster();

    stub(okPayload("openrouter"));
    await adapterFor(roster.master.provider).chat(request({ model: roster.master.model }));

    expect(lastBearer()).toBe(`Bearer ${RUNTIME_KEY}`);
    expect(calls[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(
      (JSON.parse(calls[0]!.body ?? "{}") as { model?: string }).model,
    ).toBe("deepseek/deepseek-v4-pro");
  });

  it("never writes a key into the roster file", async () => {
    // Two stores, one of which is persisted and one of which deliberately is
    // not. `providers/keys.ts` refuses disk because this process has no
    // encryption boundary; the roster file sits in the same DATA_ROOT that
    // refusal is about, so a key finding its way onto a choice would land
    // exactly where the comment says nothing is guarding.
    setProviderKey("openrouter", RUNTIME_KEY);
    await setRoster({ master: choice("openrouter", "openrouter/auto") });

    const { readFileSync } = await import("node:fs");
    const bytes = readFileSync(ROSTER_PATH, "utf-8");

    expect(bytes).not.toContain(RUNTIME_KEY);
    expect(bytes).not.toContain("sk-");
  });
});

// ---------------------------------------------------------------------------
// The money path, end to end
// ---------------------------------------------------------------------------

describe("discovery to roster to bill", () => {
  it("prices a real call with the rate discovery found, through the roster", async () => {
    // The one path the whole wave exists to make possible, joined up: the
    // catalogue publishes a per-token price, the adapter converts it to USD per
    // 1M, the roster stores it on the choice, the call reports tokens in the
    // Responses vocabulary, and `priceWithRate` turns the two into money —
    // without `services/pricing.ts` ever having heard of the model. Each half
    // is pinned elsewhere; nothing pinned that they compose.
    setProviderKey("openrouter", RUNTIME_KEY);

    stub({
      data: [
        {
          id: "vendor/unknown-to-the-rate-card",
          name: "Unknown",
          context_length: 200_000,
          pricing: { prompt: "0.000004", completion: "0.000024", input_cache_read: "0.0000004" },
          supported_parameters: ["tools"],
        },
      ],
    });
    const discovered = (await adapterFor("openrouter").listModels())[0]!;
    // `toBeCloseTo` rather than `toEqual`: the conversion is a multiplication
    // by 1e6 on a decimal string, so 0.0000004 lands on 0.39999999999999997.
    expect(discovered.rate!.input).toBeCloseTo(4, 12);
    expect(discovered.rate!.cached_input).toBeCloseTo(0.4, 12);
    expect(discovered.rate!.output).toBeCloseTo(24, 12);

    await setRoster({
      master: {
        provider: discovered.provider,
        model: discovered.id,
        context_window: discovered.context_window,
        supports_tools: discovered.supports_tools,
        rate: discovered.rate,
      },
    });
    forgetRoster();
    const stored = (await getRoster()).master;
    // Byte-identical after the round trip through disk: the rate is stored, not
    // recomputed, so this compares against what discovery actually produced.
    expect(stored.rate).toEqual(discovered.rate);

    stub({
      model: stored.model,
      choices: [{ message: { content: "ok" } }],
      usage: {
        prompt_tokens: 1_000_000,
        completion_tokens: 0,
        prompt_tokens_details: { cached_tokens: 800_000 },
      },
    });
    const answer = await adapterFor(stored.provider).chat(request({ model: stored.model }));

    // 200k fresh @ $4/1M + 800k cached @ $0.40/1M. The rate card has never
    // heard of this model, so a roster that lost the rate — or an adapter that
    // lost the cached share — would silently bill $0 or $4.00 instead.
    const priced = priceWithRate(
      {
        input: stored.rate!.input,
        cachedInput: stored.rate!.cached_input,
        output: stored.rate!.output,
      },
      answer.model,
      answer.usage,
    );
    expect(priced).toBeCloseTo(0.8 + 0.32, 9);
    expect(priceWithRate(null, answer.model, answer.usage)).toBe(0);
  });

  it("keeps a provider-reported charge distinguishable from an estimate", async () => {
    // OpenRouter's own figure is for the model it actually routed to, which
    // beats any local estimate — and `null` from the other two has to stay
    // `null` all the way to the ledger, because a 0 there is a free call.
    setProviderKey("openrouter", RUNTIME_KEY);
    setProviderKey("deepseek", RUNTIME_KEY);

    stub({
      model: "deepseek/deepseek-v4-pro",
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 194, completion_tokens: 2, cost: 0.000071 },
    });
    const routed = await adapterFor("openrouter").chat(request({ model: "openrouter/auto" }));

    stub({
      model: "deepseek-v4-pro",
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 194, completion_tokens: 2 },
    });
    const direct = await adapterFor("deepseek").chat(request());

    expect(routed.reportedUsd).toBe(0.000071);
    // The model that answered, not the alias that was asked for: that is the
    // id the charge above belongs to.
    expect(routed.model).toBe("deepseek/deepseek-v4-pro");
    expect(direct.reportedUsd).toBeNull();
    expect(direct.reportedUsd).not.toBe(0);
  });
});

describe("providerKey and the resolver are the only door", () => {
  it("reads nothing at import time, on any provider", async () => {
    // All three variables were unset when this module's import graph resolved.
    // A value observable now can only have been read at call time — and the
    // assertion is on the WIRE, because that is where an adapter that captured
    // a key into a closure would still look correct to `providerKey`.
    for (const provider of ALL_PROVIDERS) {
      process.env[ENV[provider]] = `${ENV_KEY}-${provider}`;
      await callThrough(provider);
      expect(lastBearer()).toBe(`Bearer ${ENV_KEY}-${provider}`);
      expect(providerKey(provider)).toBe(`${ENV_KEY}-${provider}`);
    }
  });
});
