import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

// HOME to a temp dir BEFORE the first runtime import: the catalogue reaches the
// adapters, which pull in `openai.ts` for `OpenAIError`, which reaches
// `costs.ts` and then storage — and `sandbox.ts` freezes its homedir()-derived
// roots at module load. Same technique as `provider-adapters.test.ts`, and the
// reason this file cannot touch the real ~/.local/share/voice-assistant.
const tmpHome = mkdtempSync(join(tmpdir(), "explainer-model-catalog-test-"));
process.env.HOME = tmpHome;

// Captured before anything stubs the global, so the route cases below can still
// talk to their own loopback server while every provider call is intercepted.
const realFetch = globalThis.fetch;

const express = (await import("express")).default;
const { errorHandler } = await import("../middleware/error-handler.js");
const modelsRouter = (await import("../routes/models.js")).default;
const { listCatalog, clearCatalogCache, defaultMinYear } = await import(
  "../services/model-catalog.js"
);
const { clearProviderKey } = await import("../services/providers/keys.js");
type CatalogResult = import("../services/model-catalog.js").CatalogResult;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const OPENAI_URL = "https://api.openai.com/v1/models";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/models";
const DEEPSEEK_URL = "https://api.deepseek.com/v1/models";

interface SeenCall {
  url: string;
  headers: Record<string, string>;
}

let calls: SeenCall[] = [];

interface Reply {
  status: number;
  body: unknown;
}

function ok(body: unknown): Reply {
  return { status: 200, body };
}

function fails(status: number, body: unknown): Reply {
  return { status, body };
}

/**
 * Answers each catalogue URL with its own payload; a URL with no entry 404s.
 *
 * Loopback URLs pass through to the real `fetch` untouched, so the route cases
 * can drive the actual Express app while the provider calls underneath it stay
 * offline. Without that, stubbing the global would break the test's own HTTP
 * client along with the code under test.
 */
function stubCatalogues(routes: Record<string, Reply>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: { headers?: Record<string, string> }) => {
      if (typeof url === "string" && url.startsWith("http://127.0.0.1")) {
        return realFetch(url, init as RequestInit);
      }

      calls.push({ url, headers: init?.headers ?? {} });
      const found = routes[url];
      if (!found) {
        return Promise.resolve({
          ok: false,
          status: 404,
          text: () => Promise.resolve('{"error":{"message":"sem stub para essa URL"}}'),
        });
      }
      return Promise.resolve({
        ok: found.status >= 200 && found.status < 300,
        status: found.status,
        text: () => Promise.resolve(JSON.stringify(found.body)),
      });
    }),
  );
}

function epochOf(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}

function urlsAsked(): string[] {
  return calls.map((call) => call.url);
}

function byId(result: CatalogResult, id: string) {
  return result.models.find((model) => model.id === id);
}

function statusOf(result: CatalogResult, provider: string) {
  return result.providers.find((one) => one.provider === provider)!;
}

// ---------------------------------------------------------------------------
// Fixtures — shapes trimmed from live catalogue responses
// ---------------------------------------------------------------------------

const OPENROUTER_CATALOGUE = {
  data: [
    {
      id: "anthropic/claude-opus-5",
      name: "Anthropic: Claude Opus 5",
      created: epochOf("2026-03-11T00:00:00Z"),
      context_length: 1_000_000,
      pricing: { prompt: "0.000005", completion: "0.000025", input_cache_read: "0.0000005" },
      top_provider: { context_length: 1_000_000, max_completion_tokens: 64_000 },
      supported_parameters: ["tools"],
    },
    {
      // The case that made `keep` necessary: the roster already points at a
      // 2025 model, and a hard 2026 filter hides the very option in use.
      id: "openai/gpt-5.2",
      name: "OpenAI: GPT-5.2",
      created: epochOf("2025-12-10T00:00:00Z"),
      context_length: 400_000,
      pricing: { prompt: "0.00000175", completion: "0.000014" },
      top_provider: { context_length: 400_000, max_completion_tokens: 128_000 },
      supported_parameters: ["tools"],
    },
    {
      // Publishes "-1": the price depends on where the router lands.
      id: "openrouter/auto",
      name: "Auto Router",
      created: epochOf("2026-01-05T00:00:00Z"),
      context_length: 2_000_000,
      pricing: { prompt: "-1", completion: "-1" },
      top_provider: { context_length: 2_000_000, max_completion_tokens: null },
      supported_parameters: ["tools"],
    },
    {
      // Publishes "0": really free, which is a price and not a gap.
      id: "inclusionai/ling-3.0-tiny:free",
      name: "inclusionAI: Ling 3.0 Tiny (free)",
      created: epochOf("2026-02-01T00:00:00Z"),
      context_length: 262_144,
      pricing: { prompt: "0", completion: "0" },
      top_provider: { context_length: 262_144, max_completion_tokens: 32_768 },
      supported_parameters: ["tools"],
    },
    {
      id: "meta/llama-legado",
      name: "Meta: Llama Legado (Ração)",
      created: epochOf("2024-06-01T00:00:00Z"),
      context_length: 8_192,
      pricing: { prompt: "0.0000001", completion: "0.0000002" },
      top_provider: { context_length: 8_192, max_completion_tokens: null },
      supported_parameters: [],
    },
  ],
};

// No `created` anywhere — DeepSeek's catalogue publishes id/object/owned_by and
// nothing else, which is why `year: null` has to mean something here.
const DEEPSEEK_CATALOGUE = {
  object: "list",
  data: [
    { id: "deepseek-v4-pro", object: "model", owned_by: "deepseek" },
    { id: "deepseek-v4-flash", object: "model", owned_by: "deepseek" },
  ],
};

const OPENAI_CATALOGUE = {
  object: "list",
  data: [{ id: "gpt-5.2-mini", object: "model", created: epochOf("2025-12-10T00:00:00Z") }],
};

function stubAllThree(): void {
  stubCatalogues({
    [OPENROUTER_URL]: ok(OPENROUTER_CATALOGUE),
    [DEEPSEEK_URL]: ok(DEEPSEEK_CATALOGUE),
    [OPENAI_URL]: ok(OPENAI_CATALOGUE),
  });
}

/** Every provider callable, for the cases that are not about missing keys. */
function withAllKeys(): void {
  process.env.OPENAI_API_KEY = "sk-openai-not-real";
  process.env.OPENROUTER_API_KEY = "sk-or-not-real";
  process.env.DEEPSEEK_API_KEY = "sk-ds-not-real";
}

// The default state is the machine the operator is actually holding: no keys
// configured at all, about to be asked for one. Each case adds only what it
// needs, so nothing passes by accident on a key it never declared.
beforeEach(() => {
  calls = [];
  clearCatalogCache();
  for (const provider of ["openai", "openrouter", "deepseek"] as const) {
    clearProviderKey(provider);
  }
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.MODEL_MIN_YEAR;
  delete process.env.MODEL_CATALOG_TTL_MS;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  server.close();
  rmSync(tmpHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The blocking bug: OpenRouter is readable with no key at all
// ---------------------------------------------------------------------------

describe("discovery without a key", () => {
  it("lists the OpenRouter catalogue when no key is configured anywhere", async () => {
    // No OPENROUTER_API_KEY, no runtime key. This is the machine the feature
    // exists for: the setup screen is asking for a key and the model picker
    // behind it still has to be full.
    stubCatalogues({ [OPENROUTER_URL]: ok(OPENROUTER_CATALOGUE) });

    const result = await listCatalog({ providers: ["openrouter"], minYear: 0 });

    expect(statusOf(result, "openrouter").status).toBe("ok");
    expect(result.models).toHaveLength(5);
    expect(urlsAsked()).toEqual([OPENROUTER_URL]);
  });

  it("omits the Authorization header entirely rather than sending an empty one", async () => {
    stubCatalogues({ [OPENROUTER_URL]: ok(OPENROUTER_CATALOGUE) });

    await listCatalog({ providers: ["openrouter"], minYear: 0 });

    // Absent, not "Bearer ". An empty bearer earns a 401 that reads like a
    // revoked key rather than a missing one.
    expect(calls[0]!.headers.Authorization).toBeUndefined();
    expect("Authorization" in calls[0]!.headers).toBe(false);
    // The attribution headers are not authentication and still go out.
    expect(calls[0]!.headers["X-Title"]).toBe("Explainer");
  });

  it("identifies itself when a key IS configured, for the better rate limits", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-not-real";
    stubCatalogues({ [OPENROUTER_URL]: ok(OPENROUTER_CATALOGUE) });

    await listCatalog({ providers: ["openrouter"], minYear: 0 });

    expect(calls[0]!.headers.Authorization).toBe("Bearer sk-or-not-real");
  });

  it("skips the providers whose catalogue needs a key, without a round trip", async () => {
    stubAllThree();

    const result = await listCatalog({ minYear: 0 });

    expect(statusOf(result, "openai").status).toBe("skipped");
    expect(statusOf(result, "openai").note).toContain("OPENAI_API_KEY");
    expect(statusOf(result, "deepseek").status).toBe("skipped");
    expect(statusOf(result, "deepseek").note).toContain("DEEPSEEK_API_KEY");
    // Only OpenRouter was asked; the other two would only have collected a 401.
    expect(urlsAsked()).toEqual([OPENROUTER_URL]);
    expect(result.models.every((model) => model.provider === "openrouter")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// One provider failing must not take the others with it
// ---------------------------------------------------------------------------

describe("partial failure", () => {
  it("reports the failed provider and keeps the rest of the catalogue", async () => {
    withAllKeys();
    stubCatalogues({
      [OPENROUTER_URL]: ok(OPENROUTER_CATALOGUE),
      [DEEPSEEK_URL]: ok(DEEPSEEK_CATALOGUE),
      [OPENAI_URL]: fails(401, { error: { message: "Incorrect API key provided" } }),
    });

    const result = await listCatalog({ minYear: 0 });

    expect(statusOf(result, "openai").status).toBe("error");
    expect(statusOf(result, "openai").note).toContain("Incorrect API key provided");
    expect(statusOf(result, "openai").count).toBe(0);
    expect(statusOf(result, "openrouter").status).toBe("ok");
    expect(statusOf(result, "deepseek").status).toBe("ok");
    expect(byId(result, "anthropic/claude-opus-5")).toBeDefined();
    expect(byId(result, "deepseek-v4-pro")).toBeDefined();
  });

  it("counts what each provider answered, and totals to the sum", async () => {
    withAllKeys();
    stubAllThree();

    const result = await listCatalog({ minYear: 2026 });

    expect(statusOf(result, "openrouter").count).toBe(5);
    expect(statusOf(result, "deepseek").count).toBe(2);
    expect(statusOf(result, "openai").count).toBe(1);
    // `count` is what the provider answered, before filtering, so the totals
    // reconcile and a short list cannot be mistaken for a small provider.
    expect(result.total).toBe(8);
    expect(result.filtered).toBe(result.models.length);
    expect(result.filtered).toBe(5);
  });

  it("does not cache a failure, so a key pasted a second later takes effect", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-not-real";
    stubCatalogues({ [OPENROUTER_URL]: fails(500, { error: { message: "upstream down" } }) });
    const first = await listCatalog({ providers: ["openrouter"], minYear: 0 });
    expect(statusOf(first, "openrouter").status).toBe("error");

    vi.unstubAllGlobals();
    calls = [];
    stubCatalogues({ [OPENROUTER_URL]: ok(OPENROUTER_CATALOGUE) });
    const second = await listCatalog({ providers: ["openrouter"], minYear: 0 });

    expect(statusOf(second, "openrouter").status).toBe("ok");
    expect(calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The year filter
// ---------------------------------------------------------------------------

describe("the year filter", () => {
  it("keeps 2026+ and drops everything older, by default", async () => {
    stubCatalogues({ [OPENROUTER_URL]: ok(OPENROUTER_CATALOGUE) });

    const result = await listCatalog({ providers: ["openrouter"] });

    expect(result.min_year).toBe(2026);
    expect(result.models.map((model) => model.id).sort()).toEqual([
      "anthropic/claude-opus-5",
      "inclusionai/ling-3.0-tiny:free",
      "openrouter/auto",
    ]);
    // The 2025 and the 2024 model are gone, and gone is the point.
    expect(byId(result, "openai/gpt-5.2")).toBeUndefined();
    expect(byId(result, "meta/llama-legado")).toBeUndefined();
  });

  it("takes the default from MODEL_MIN_YEAR, so 2027 does not need a code change", async () => {
    process.env.MODEL_MIN_YEAR = "2025";
    stubCatalogues({ [OPENROUTER_URL]: ok(OPENROUTER_CATALOGUE) });

    const result = await listCatalog({ providers: ["openrouter"] });

    expect(defaultMinYear()).toBe(2025);
    expect(result.min_year).toBe(2025);
    expect(byId(result, "openai/gpt-5.2")).toBeDefined();
    expect(byId(result, "meta/llama-legado")).toBeUndefined();
  });

  it("falls back to 2026 when MODEL_MIN_YEAR is unreadable", async () => {
    process.env.MODEL_MIN_YEAR = "recente";

    expect(defaultMinYear()).toBe(2026);
  });

  it("honours an explicit minimum year over the default", async () => {
    process.env.MODEL_MIN_YEAR = "2026";
    stubCatalogues({ [OPENROUTER_URL]: ok(OPENROUTER_CATALOGUE) });

    const result = await listCatalog({ providers: ["openrouter"], minYear: 2024 });

    expect(result.min_year).toBe(2024);
    expect(result.models).toHaveLength(5);
  });

  it("filters nothing when min_year is 0", async () => {
    stubCatalogues({ [OPENROUTER_URL]: ok(OPENROUTER_CATALOGUE) });

    const result = await listCatalog({ providers: ["openrouter"], minYear: 0 });

    expect(result.min_year).toBe(0);
    expect(result.models).toHaveLength(5);
    expect(byId(result, "meta/llama-legado")!.year).toBe(2024);
  });

  it("reads the year in UTC, so a 31 December model does not slip a year", async () => {
    stubCatalogues({
      [OPENROUTER_URL]: ok({
        data: [
          {
            id: "edge/new-years-eve",
            name: "Edge: New Year's Eve",
            created: epochOf("2025-12-31T23:30:00Z"),
            pricing: { prompt: "0.000001", completion: "0.000002" },
          },
        ],
      }),
    });

    const result = await listCatalog({ providers: ["openrouter"], minYear: 0 });

    expect(byId(result, "edge/new-years-eve")!.year).toBe(2025);
  });
});

// ---------------------------------------------------------------------------
// Models with no date at all
// ---------------------------------------------------------------------------

describe("undated models", () => {
  it("carries year null, and never the minimum year, for a provider with no dates", async () => {
    process.env.DEEPSEEK_API_KEY = "sk-ds-not-real";
    stubCatalogues({ [DEEPSEEK_URL]: ok(DEEPSEEK_CATALOGUE) });

    const result = await listCatalog({ providers: ["deepseek"], minYear: 2026 });

    expect(result.models).toHaveLength(2);
    expect(result.models.every((model) => model.year === null)).toBe(true);
    // The lie this guards against: counting an unknown date as the current year
    // would pass DeepSeek's whole catalogue off as new.
    expect(result.models.some((model) => model.year === 2026)).toBe(false);
    expect(result.models.every((model) => model.released_at === null)).toBe(true);
  });

  it("keeps undated models by default, because dropping them empties DeepSeek", async () => {
    process.env.DEEPSEEK_API_KEY = "sk-ds-not-real";
    stubCatalogues({ [DEEPSEEK_URL]: ok(DEEPSEEK_CATALOGUE) });

    const result = await listCatalog({ providers: ["deepseek"] });

    expect(result.models.map((model) => model.id)).toEqual([
      "deepseek-v4-pro",
      "deepseek-v4-flash",
    ]);
  });

  it("drops them when include_undated is false, even with no year filter at all", async () => {
    process.env.DEEPSEEK_API_KEY = "sk-ds-not-real";
    stubCatalogues({ [DEEPSEEK_URL]: ok(DEEPSEEK_CATALOGUE) });

    // min_year 0 means no year test, so anything surviving here would have
    // survived as an unknown date rather than as a passing year.
    const result = await listCatalog({
      providers: ["deepseek"],
      minYear: 0,
      includeUndated: false,
    });

    expect(result.models).toHaveLength(0);
    expect(result.total).toBe(2);
    expect(statusOf(result, "deepseek").status).toBe("ok");
  });

  it("drops only the undated ones, leaving the dated filter untouched", async () => {
    process.env.DEEPSEEK_API_KEY = "sk-ds-not-real";
    stubCatalogues({
      [OPENROUTER_URL]: ok(OPENROUTER_CATALOGUE),
      [DEEPSEEK_URL]: ok(DEEPSEEK_CATALOGUE),
    });

    const result = await listCatalog({
      providers: ["openrouter", "deepseek"],
      minYear: 2026,
      includeUndated: false,
    });

    expect(result.models.every((model) => model.provider === "openrouter")).toBe(true);
    expect(result.models).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// keep — the selected model is always offered
// ---------------------------------------------------------------------------

describe("keep", () => {
  it("lets an already-chosen 2025 model through a 2026 filter, and says why", async () => {
    stubCatalogues({ [OPENROUTER_URL]: ok(OPENROUTER_CATALOGUE) });

    const result = await listCatalog({
      providers: ["openrouter"],
      minYear: 2026,
      keep: ["openai/gpt-5.2"],
    });

    const kept = byId(result, "openai/gpt-5.2")!;
    expect(kept.year).toBe(2025);
    // Without this the select renders a `value` that is not among its own
    // `options`, which is the classic empty-combobox bug.
    expect(kept.kept_by_selection).toBe(true);
    expect(result.models).toHaveLength(4);
  });

  it("does not mark a model that passed the filter on its own merits", async () => {
    stubCatalogues({ [OPENROUTER_URL]: ok(OPENROUTER_CATALOGUE) });

    const result = await listCatalog({
      providers: ["openrouter"],
      minYear: 2026,
      keep: ["anthropic/claude-opus-5", "openai/gpt-5.2"],
    });

    // `kept_by_selection` means "here BECAUSE it was selected", so it is false
    // for a 2026 model that needed no help.
    expect(byId(result, "anthropic/claude-opus-5")!.kept_by_selection).toBe(false);
    expect(byId(result, "openai/gpt-5.2")!.kept_by_selection).toBe(true);
    expect(result.models.filter((model) => model.kept_by_selection)).toHaveLength(1);
  });

  it("ignores an id that no provider offers, rather than inventing an entry", async () => {
    stubCatalogues({ [OPENROUTER_URL]: ok(OPENROUTER_CATALOGUE) });

    const result = await listCatalog({
      providers: ["openrouter"],
      minYear: 2026,
      keep: ["nobody/ghost-model"],
    });

    expect(result.models).toHaveLength(3);
    expect(byId(result, "nobody/ghost-model")).toBeUndefined();
  });

  it("rescues a model whose id reaches the catalogue with a provider prefix it did not have in the roster", async () => {
    // The roster stores ids as the operator typed them — "gpt-5.2" without a
    // prefix (OpenAI's own catalogue answers bare ids).  The OpenRouter
    // catalogue answers the SAME model as "openai/gpt-5.2".  Without
    // normalisation, `keep` fails in the exact scenario it was built for: one
    // provider is unreachable (no key yet, like the task says — "uma vez não
    // tendo chave"), and the only catalogue available spells the id
    // differently than the roster expects.
    stubCatalogues({ [OPENROUTER_URL]: ok(OPENROUTER_CATALOGUE) });

    const result = await listCatalog({
      providers: ["openrouter"],
      minYear: 2026,
      keep: ["gpt-5.2"], // bare — the id the roster carries
    });

    const kept = byId(result, "openai/gpt-5.2")!;
    expect(kept).toBeDefined();
    expect(kept.year).toBe(2025);
    expect(kept.kept_by_selection).toBe(true);
    // The id on the wire is still what the catalogue answered; we do not
    // rewrite it — the roster accepts both spellings.
    expect(kept.id).toBe("openai/gpt-5.2");
  });

  it("does not override a search the user just typed", async () => {
    stubCatalogues({ [OPENROUTER_URL]: ok(OPENROUTER_CATALOGUE) });

    const result = await listCatalog({
      providers: ["openrouter"],
      minYear: 2026,
      keep: ["openai/gpt-5.2"],
      q: "claude",
    });

    // `keep` crosses the year filter, which the user never typed. It does not
    // cross `q`, which they are typing right now and watching.
    expect(result.models.map((model) => model.id)).toEqual(["anthropic/claude-opus-5"]);
  });
});

// ---------------------------------------------------------------------------
// Price: a missing price and a free price are not the same thing
// ---------------------------------------------------------------------------

describe("rate", () => {
  it("keeps an unpriced router distinct from a genuinely free model", async () => {
    stubCatalogues({ [OPENROUTER_URL]: ok(OPENROUTER_CATALOGUE) });

    const result = await listCatalog({ providers: ["openrouter"], minYear: 0 });

    const auto = byId(result, "openrouter/auto")!;
    const free = byId(result, "inclusionai/ling-3.0-tiny:free")!;

    // A router whose price depends on where it lands publishes "-1"; a `:free`
    // model publishes a real zero. Collapsing either into the other makes an
    // unknown price look free, or a free model look unpriceable.
    expect(auto.rate).toBeNull();
    expect(free.rate).toEqual({ input: 0, cached_input: 0, output: 0 });
    expect(free.rate).not.toBeNull();
    expect(auto.rate).not.toEqual({ input: 0, cached_input: 0, output: 0 });
  });

  it("passes a real rate through in USD per 1M tokens, without re-scaling it", async () => {
    stubCatalogues({ [OPENROUTER_URL]: ok(OPENROUTER_CATALOGUE) });

    const result = await listCatalog({ providers: ["openrouter"], minYear: 0 });
    const opus = byId(result, "anthropic/claude-opus-5")!;

    // The adapter already multiplied by 1e6. A second multiplication here would
    // report a $5/1M model at $5,000,000/1M and nothing would throw.
    expect(opus.rate!.input).toBeCloseTo(5, 9);
    expect(opus.rate!.output).toBeCloseTo(25, 9);
    expect(opus.rate!.cached_input).toBeCloseTo(0.5, 9);
  });

  it("leaves a provider that publishes no prices at null across the board", async () => {
    process.env.DEEPSEEK_API_KEY = "sk-ds-not-real";
    stubCatalogues({ [DEEPSEEK_URL]: ok(DEEPSEEK_CATALOGUE) });

    const result = await listCatalog({ providers: ["deepseek"], minYear: 0 });

    expect(result.models.every((model) => model.rate === null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

describe("cache", () => {
  it("serves the second call without a second round trip", async () => {
    stubCatalogues({ [OPENROUTER_URL]: ok(OPENROUTER_CATALOGUE) });

    const first = await listCatalog({ providers: ["openrouter"], minYear: 0 });
    expect(calls).toHaveLength(1);

    const second = await listCatalog({ providers: ["openrouter"], minYear: 0 });

    expect(calls).toHaveLength(1);
    expect(second.models.map((model) => model.id)).toEqual(
      first.models.map((model) => model.id),
    );
    expect(statusOf(second, "openrouter").status).toBe("ok");
  });

  it("re-filters the cached list, so a different query does not need a refetch", async () => {
    stubCatalogues({ [OPENROUTER_URL]: ok(OPENROUTER_CATALOGUE) });

    await listCatalog({ providers: ["openrouter"], minYear: 0 });
    const narrower = await listCatalog({ providers: ["openrouter"], minYear: 2026 });

    expect(calls).toHaveLength(1);
    expect(narrower.models).toHaveLength(3);
  });

  it("goes back to the provider when refresh is asked for", async () => {
    stubCatalogues({ [OPENROUTER_URL]: ok(OPENROUTER_CATALOGUE) });

    await listCatalog({ providers: ["openrouter"], minYear: 0 });
    await listCatalog({ providers: ["openrouter"], minYear: 0, refresh: true });

    expect(calls).toHaveLength(2);
  });

  it("asks a repeated provider once, so the select gets no duplicate options", async () => {
    stubCatalogues({ [OPENROUTER_URL]: ok(OPENROUTER_CATALOGUE) });

    const result = await listCatalog({
      providers: ["openrouter", "openrouter"],
      minYear: 0,
    });

    expect(urlsAsked()).toEqual([OPENROUTER_URL]);
    expect(result.providers).toHaveLength(1);
    expect(result.models).toHaveLength(5);
  });

  it("caches per provider, so one cached list does not stand in for another", async () => {
    process.env.DEEPSEEK_API_KEY = "sk-ds-not-real";
    stubCatalogues({
      [OPENROUTER_URL]: ok(OPENROUTER_CATALOGUE),
      [DEEPSEEK_URL]: ok(DEEPSEEK_CATALOGUE),
    });

    await listCatalog({ providers: ["openrouter"], minYear: 0 });
    expect(urlsAsked()).toEqual([OPENROUTER_URL]);

    const both = await listCatalog({ providers: ["openrouter", "deepseek"], minYear: 0 });

    // Only the provider that was missing gets asked; OpenRouter is reused.
    expect(urlsAsked()).toEqual([OPENROUTER_URL, DEEPSEEK_URL]);
    expect(both.models).toHaveLength(7);
  });

  it("refetches once the TTL has passed", async () => {
    process.env.MODEL_CATALOG_TTL_MS = "0";
    stubCatalogues({ [OPENROUTER_URL]: ok(OPENROUTER_CATALOGUE) });

    await listCatalog({ providers: ["openrouter"], minYear: 0 });
    await listCatalog({ providers: ["openrouter"], minYear: 0 });

    // A zero TTL is already expired, so the entry is never reused. This is the
    // knob proving the TTL is read at call time rather than frozen at import.
    expect(calls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

describe("search", () => {
  it("matches past case and past accents, in both directions", async () => {
    stubCatalogues({ [OPENROUTER_URL]: ok(OPENROUTER_CATALOGUE) });

    for (const needle of ["ração", "RAÇÃO", "racao", "RaCaO"]) {
      clearCatalogCache();
      const result = await listCatalog({ providers: ["openrouter"], minYear: 0, q: needle });
      expect(result.models.map((model) => model.id)).toEqual(["meta/llama-legado"]);
    }
  });

  it("searches the id as well as the label", async () => {
    stubCatalogues({ [OPENROUTER_URL]: ok(OPENROUTER_CATALOGUE) });

    const result = await listCatalog({ providers: ["openrouter"], minYear: 0, q: "inclusionai/" });

    expect(result.models.map((model) => model.id)).toEqual(["inclusionai/ling-3.0-tiny:free"]);
  });

  it("treats an empty or blank query as no search at all", async () => {
    stubCatalogues({ [OPENROUTER_URL]: ok(OPENROUTER_CATALOGUE) });

    const blank = await listCatalog({ providers: ["openrouter"], minYear: 0, q: "   " });

    expect(blank.models).toHaveLength(5);
  });

  it("answers an empty list, not everything, when nothing matches", async () => {
    stubCatalogues({ [OPENROUTER_URL]: ok(OPENROUTER_CATALOGUE) });

    const result = await listCatalog({ providers: ["openrouter"], minYear: 0, q: "não existe" });

    expect(result.models).toHaveLength(0);
    expect(result.filtered).toBe(0);
    expect(result.total).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// GET /api/models
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());
app.use("/api/models", modelsRouter);
app.use(errorHandler);

const server: Server = app.listen(0);
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}/api/models`;

async function get(query = ""): Promise<CatalogResult> {
  const response = await realFetch(`${base}${query}`);
  expect(response.status).toBe(200);
  return (await response.json()) as CatalogResult;
}

describe("GET /api/models", () => {
  it("answers the whole contract: models, providers, min_year, total, filtered", async () => {
    stubCatalogues({ [OPENROUTER_URL]: ok(OPENROUTER_CATALOGUE) });

    const body = await get();

    expect(body.min_year).toBe(2026);
    expect(body.total).toBe(5);
    expect(body.filtered).toBe(3);
    expect(body.models).toHaveLength(3);
    expect(body.providers.map((one) => one.provider)).toEqual([
      "openai",
      "openrouter",
      "deepseek",
    ]);
    expect(body.models[0]).toHaveProperty("year");
    expect(body.models[0]).toHaveProperty("kept_by_selection");
    expect(body.models[0]).toHaveProperty("provider");
  });

  it("narrows to one provider on request", async () => {
    stubCatalogues({ [OPENROUTER_URL]: ok(OPENROUTER_CATALOGUE) });

    const body = await get("?provider=openrouter");

    expect(body.providers).toHaveLength(1);
    expect(body.providers[0]!.provider).toBe("openrouter");
  });

  it("clamps a nonsense min_year to the default instead of answering 400", async () => {
    stubCatalogues({ [OPENROUTER_URL]: ok(OPENROUTER_CATALOGUE) });

    const body = await get("?provider=openrouter&min_year=recente");

    expect(body.min_year).toBe(2026);
    expect(body.models).toHaveLength(3);
  });

  it("clamps a negative min_year to zero", async () => {
    stubCatalogues({ [OPENROUTER_URL]: ok(OPENROUTER_CATALOGUE) });

    const body = await get("?provider=openrouter&min_year=-40");

    expect(body.min_year).toBe(0);
    expect(body.models).toHaveLength(5);
  });

  it("turns off the filter with min_year=0", async () => {
    stubCatalogues({ [OPENROUTER_URL]: ok(OPENROUTER_CATALOGUE) });

    const body = await get("?provider=openrouter&min_year=0");

    expect(body.min_year).toBe(0);
    expect(body.models).toHaveLength(5);
  });

  it("reads include_undated=false, and defaults it to true", async () => {
    process.env.DEEPSEEK_API_KEY = "sk-ds-not-real";
    stubCatalogues({ [DEEPSEEK_URL]: ok(DEEPSEEK_CATALOGUE) });

    const kept = await get("?provider=deepseek");
    expect(kept.models).toHaveLength(2);

    const dropped = await get("?provider=deepseek&include_undated=false");
    expect(dropped.models).toHaveLength(0);
    expect(dropped.total).toBe(2);
  });

  it("accepts keep as a comma-separated list and marks what it rescued", async () => {
    stubCatalogues({ [OPENROUTER_URL]: ok(OPENROUTER_CATALOGUE) });

    const body = await get("?provider=openrouter&keep=openai/gpt-5.2,nobody/ghost");

    expect(body.models).toHaveLength(4);
    expect(body.models.find((model) => model.id === "openai/gpt-5.2")!.kept_by_selection).toBe(
      true,
    );
  });

  it("searches with q, accents and all", async () => {
    stubCatalogues({ [OPENROUTER_URL]: ok(OPENROUTER_CATALOGUE) });

    const body = await get("?provider=openrouter&min_year=0&q=racao");

    expect(body.models.map((model) => model.id)).toEqual(["meta/llama-legado"]);
  });

  it("busts the cache with refresh=1", async () => {
    stubCatalogues({ [OPENROUTER_URL]: ok(OPENROUTER_CATALOGUE) });

    await get("?provider=openrouter");
    expect(calls).toHaveLength(1);

    await get("?provider=openrouter");
    expect(calls).toHaveLength(1);

    await get("?provider=openrouter&refresh=1");
    expect(calls).toHaveLength(2);
  });

  it("falls back to every provider when the name is not one this build knows", async () => {
    stubCatalogues({ [OPENROUTER_URL]: ok(OPENROUTER_CATALOGUE) });

    const body = await get("?provider=anthropic");

    // A stale bookmark shows the whole catalogue rather than an empty one.
    expect(body.providers).toHaveLength(3);
  });

  it("reports a missing key as skipped, in words the operator can act on", async () => {
    stubCatalogues({ [OPENROUTER_URL]: ok(OPENROUTER_CATALOGUE) });

    const body = await get();

    const openai = body.providers.find((one) => one.provider === "openai")!;
    expect(openai.status).toBe("skipped");
    expect(openai.note).toContain("OPENAI_API_KEY");
    expect(openai.note).toContain("platform.openai.com");
  });

  it("never leaks a key into the response", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-super-secret-value";
    stubCatalogues({ [OPENROUTER_URL]: ok(OPENROUTER_CATALOGUE) });

    const response = await realFetch(`${base}?provider=openrouter`);
    const text = await response.text();

    expect(text).not.toContain("sk-or-super-secret-value");
  });
});
