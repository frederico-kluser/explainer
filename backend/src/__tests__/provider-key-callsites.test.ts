import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ThinkerProvider } from "../types/thinker-roster.js";

// The hole this file exists to keep shut.
//
// `PUT /api/provider-keys/openrouter` answered `{present:true,source:"runtime"}`
// and `GET /api/credits` answered `OPENROUTER_API_KEY não está definida` in the
// same breath, because the store from wave 1 was real and every caller still
// read `process.env` directly. `provider-keys.test.ts` proves the store; this
// file proves the CALLERS go through it — the assertions all sit one layer out,
// on what reached the wire, since that is where the old code and the new one
// disagree.
//
// Nothing here opens a socket: `fetch` is stubbed and every case asserts on the
// `Authorization` header the stub saw.

// HOME first, before any runtime import: `openai.ts` pulls in `costs.ts` and
// `memory.ts` pulls in `sandbox.ts`, which freezes its homedir()-derived roots
// at module load. Same technique as `openai.test.ts` and `memory.test.ts`.
const tmpHome = mkdtempSync(join(tmpdir(), "explainer-key-callsites-test-"));
process.env.HOME = tmpHome;

// The four variables in play, cleared before the modules load so nothing below
// can pass by borrowing the developer's real shell.
const VARS = [
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "DEEPSEEK_API_KEY",
  "OPENAI_ADMIN_KEY",
] as const;

const saved = new Map<string, string | undefined>();
for (const name of VARS) {
  saved.set(name, process.env[name]);
  delete process.env[name];
}

const openai = await import("../services/openai.js");
const credits = await import("../services/credits.js");
const memory = await import("../services/memory.js");
const mermaid = await import("../services/mermaid.js");
const keys = await import("../services/providers/keys.js");

const PROVIDERS: ThinkerProvider[] = ["openai", "openrouter", "deepseek"];

// Long enough to clear the store's floor, and shaped like the real thing.
const TYPED = {
  openai: "sk-proj-typed-into-the-setup-screen-0123456789",
  openrouter: "sk-or-v1-typed-into-the-setup-screen-01234567",
  deepseek: "sk-ds-typed-into-the-setup-screen-0123456789",
} as const;

const STALE_ENV = "sk-stale-value-the-shell-was-carrying-012345";
const ADMIN_KEY = "sk-admin-only-this-one-reads-the-costs-api-1";

interface SeenCall {
  url: string;
  authorization: string | undefined;
}

let seen: SeenCall[] = [];

/** Answer any request with a canned body, and record what it carried. */
function stubFetch(body: (url: string) => unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: unknown, init?: { headers?: Record<string, string> }) => {
      const url = String(input);
      seen.push({ url, authorization: init?.headers?.Authorization });
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify(body(url))),
      });
    }),
  );
}

/** What each provider's balance endpoint answers when it is reached. */
function creditsBody(url: string): unknown {
  if (url.includes("openrouter.ai")) {
    return { data: { total_credits: 20, total_usage: 5 } };
  }
  if (url.includes("deepseek.com")) {
    return { balance_infos: [{ currency: "USD", total_balance: "42.50" }] };
  }
  return { data: [{ results: [{ amount: { value: 1.25 } }] }] };
}

function callTo(fragment: string): SeenCall | undefined {
  return seen.find((call) => call.url.includes(fragment));
}

function row(all: Awaited<ReturnType<typeof credits.getCredits>>, provider: string) {
  return all.find((entry) => entry.provider === provider)!;
}

const SESSION = {
  type: "realtime",
  model: "gpt-realtime-2.1",
  instructions: "fale em portugues",
} as const;

beforeEach(() => {
  seen = [];
  for (const name of VARS) delete process.env[name];
  // A runtime key now OUTRANKS the environment, so one left behind by an
  // earlier case would mask every assertion below it and the suite would still
  // be green.
  for (const provider of PROVIDERS) keys.clearProviderKey(provider);
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const provider of PROVIDERS) keys.clearProviderKey(provider);
});

afterAll(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(tmpHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// openai.ts — the realtime mint and the text path
// ---------------------------------------------------------------------------

describe("services/openai.ts reads the key through the resolver", () => {
  it("mints a realtime session with a key typed after boot", async () => {
    // The headline case: `OPENAI_API_KEY` was never exported, the user typed
    // the key into the setup screen, and the very next connect attempt has to
    // work — no restart. Before the migration this threw
    // "OPENAI_API_KEY is not set on the server" at a user staring at the key
    // they had just saved.
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    keys.setProviderKey("openai", TYPED.openai);
    stubFetch(() => ({ value: "ek_test", expires_at: 1, session: {} }));

    const secret = await openai.mintRealtimeClientSecret({ ...SESSION });

    expect(secret.value).toBe("ek_test");
    const mint = callTo("/realtime/client_secrets");
    expect(mint).toBeDefined();
    expect(mint!.authorization).toBe(`Bearer ${TYPED.openai}`);
  });

  it("uses the typed key on the text path as well", async () => {
    keys.setProviderKey("openai", TYPED.openai);
    stubFetch(() => ({
      status: "completed",
      model: "gpt-5.2-mini",
      usage: { input_tokens: 10, output_tokens: 2 },
      output: [{ type: "message", content: [{ text: "pronto" }] }],
    }));

    const completion = await openai.completeText("resuma");

    expect(completion.text).toBe("pronto");
    expect(callTo("/responses")!.authorization).toBe(`Bearer ${TYPED.openai}`);
  });

  it("prefers the typed key over a stale variable from the shell", async () => {
    // The bug the precedence rule exists for: saving a new key and watching the
    // app keep calling with the old one, then blaming the key on screen for the
    // 401. Asserted on the wire because that is the only place it shows.
    process.env.OPENAI_API_KEY = STALE_ENV;
    keys.setProviderKey("openai", TYPED.openai);
    stubFetch(() => ({ value: "ek_test", expires_at: 1, session: {} }));

    await openai.mintRealtimeClientSecret({ ...SESSION });

    expect(callTo("/realtime/client_secrets")!.authorization).toBe(
      `Bearer ${TYPED.openai}`,
    );
    expect(seen.map((call) => call.authorization)).not.toContain(
      `Bearer ${STALE_ENV}`,
    );
  });

  it("falls back to the environment when nothing was typed", async () => {
    // The migration must not cost the deployment that only ever exports a
    // variable, which is still every server install.
    process.env.OPENAI_API_KEY = STALE_ENV;
    stubFetch(() => ({ value: "ek_test", expires_at: 1, session: {} }));

    await openai.mintRealtimeClientSecret({ ...SESSION });

    expect(callTo("/realtime/client_secrets")!.authorization).toBe(
      `Bearer ${STALE_ENV}`,
    );
  });

  it("still refuses to call with no key at all, naming the variable", async () => {
    stubFetch(() => ({}));

    const failure = await openai
      .mintRealtimeClientSecret({ ...SESSION })
      .catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(openai.OpenAIError);
    const err = failure as InstanceType<typeof openai.OpenAIError>;
    expect(err.status).toBe(500);
    // The message moved from English to the resolver's Portuguese one, which
    // also names the console to get a key from. Nothing was spent finding out:
    // the request never left.
    expect(err.message).toContain("OPENAI_API_KEY");
    expect(err.message).toContain("não está definida");
    expect(seen).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// memory.ts — the summariser
// ---------------------------------------------------------------------------

describe("services/memory.ts asks the summariser once a key exists", () => {
  it("skips the model with no key and asks for it with a typed one", async () => {
    const withoutKey = randomUUID();
    await memory.appendMemoryEvents(withoutKey, [
      { kind: "user", text: "Quero entender o pipeline." },
      { kind: "assistant", text: "Ele tem três etapas." },
    ]);
    stubFetch(() => ({
      status: "completed",
      model: "gpt-5.2-mini",
      usage: { input_tokens: 10, output_tokens: 2 },
      output: [{ type: "message", content: [{ text: "Resumo do modelo." }] }],
    }));

    // No key: the deterministic resume, and not one request — the guard is
    // `providerKeyPresent`, so an unconfigured backend must not throw either.
    const before = await memory.buildResume(withoutKey);
    expect(before).not.toBeNull();
    expect(before!.summary).not.toBe("Resumo do modelo.");
    expect(seen).toHaveLength(0);

    keys.setProviderKey("openai", TYPED.openai);

    const withKey = randomUUID();
    await memory.appendMemoryEvents(withKey, [
      { kind: "user", text: "Quero entender o pipeline." },
      { kind: "assistant", text: "Ele tem três etapas." },
    ]);
    const after = await memory.buildResume(withKey);

    expect(after!.summary).toBe("Resumo do modelo.");
    expect(callTo("/responses")!.authorization).toBe(`Bearer ${TYPED.openai}`);
  });
});

// ---------------------------------------------------------------------------
// mermaid.ts — the diagram generator
// ---------------------------------------------------------------------------

describe("services/mermaid.ts reads the key through the resolver", () => {
  const DIAGRAM = 'flowchart TD\n    A["Navegador"] --> B["Backend"]';
  const answer = () => ({
    model: "gpt-5.2-mini",
    status: "completed",
    usage: { input_tokens: 10, output_tokens: 20 },
    output: [
      {
        type: "message",
        content: [{ text: `LEGENDA: Do navegador ao backend.\nDIAGRAMA:\n${DIAGRAM}` }],
      },
    ],
  });

  it("refuses with no key and draws with a typed one", async () => {
    stubFetch(answer);

    const refusal = await mermaid
      .generateMermaid({ instructions: "desenha o fluxo" }, randomUUID(), { attempts: 1 })
      .catch((err: unknown) => err);

    expect((refusal as Error).message).toContain("OPENAI_API_KEY");
    expect(seen).toHaveLength(0);

    keys.setProviderKey("openai", TYPED.openai);
    const diagram = await mermaid.generateMermaid(
      { instructions: "desenha o fluxo" },
      randomUUID(),
      { attempts: 1 },
    );

    expect(diagram.source).toContain("flowchart TD");
    expect(callTo("/responses")!.authorization).toBe(`Bearer ${TYPED.openai}`);
  });
});

// ---------------------------------------------------------------------------
// credits.ts — the two branches that were migrated
// ---------------------------------------------------------------------------

describe("services/credits.ts stops reporting a key the user already saved", () => {
  it("reproduces the old contradiction and shows it gone, for OpenRouter", async () => {
    stubFetch(creditsBody);

    // Step 1 of the adversarial repro, before any key exists.
    const before = row(await credits.getCredits(), "openrouter");
    expect(before.status).toBe("unavailable");
    expect(before.note).toContain("OPENROUTER_API_KEY não está definida.");
    expect(callTo("openrouter.ai")).toBeUndefined();

    // Step 2: exactly what `PUT /api/provider-keys/openrouter` does.
    keys.setProviderKey("openrouter", TYPED.openrouter);
    expect(keys.providerKeyStatus("openrouter")).toMatchObject({
      present: true,
      source: "runtime",
    });

    const after = row(await credits.getCredits(), "openrouter");

    // The two answers agree now: the balance was actually fetched, with the key
    // the user typed.
    expect(after.status).toBe("ok");
    expect(after.note).toBeUndefined();
    expect(after.total_usd).toBe(20);
    expect(after.used_usd).toBe(5);
    expect(after.remaining_usd).toBe(15);
    expect(callTo("openrouter.ai")!.authorization).toBe(`Bearer ${TYPED.openrouter}`);
  });

  it("does the same for DeepSeek", async () => {
    stubFetch(creditsBody);

    const before = row(await credits.getCredits(), "deepseek");
    expect(before.status).toBe("unavailable");
    expect(before.note).toContain("DEEPSEEK_API_KEY não está definida.");
    expect(callTo("deepseek.com")).toBeUndefined();

    keys.setProviderKey("deepseek", TYPED.deepseek);
    const after = row(await credits.getCredits(), "deepseek");

    expect(after.status).toBe("ok");
    expect(after.remaining_usd).toBe(42.5);
    expect(callTo("deepseek.com")!.authorization).toBe(`Bearer ${TYPED.deepseek}`);
  });

  it("keeps reading the environment when that is where the key is", async () => {
    process.env.OPENROUTER_API_KEY = STALE_ENV;
    process.env.DEEPSEEK_API_KEY = STALE_ENV;
    stubFetch(creditsBody);

    const all = await credits.getCredits();

    expect(row(all, "openrouter").status).toBe("ok");
    expect(row(all, "deepseek").status).toBe("ok");
    expect(callTo("openrouter.ai")!.authorization).toBe(`Bearer ${STALE_ENV}`);
    expect(callTo("deepseek.com")!.authorization).toBe(`Bearer ${STALE_ENV}`);
  });

  it("reports rather than throws when no provider is configured", async () => {
    // `getCredits` exists to report. `providerKey` throws a 500 when a key is
    // missing, so a migration that used it unguarded would turn an empty setup
    // screen into a failed request and the panel would show nothing at all.
    stubFetch(creditsBody);

    const all = await credits.getCredits();

    expect(all).toHaveLength(3);
    for (const entry of all) {
      expect(entry.status).toBe("unavailable");
      expect(entry.note).toBeTruthy();
      expect(entry.remaining_usd).toBeNull();
    }
    expect(seen).toHaveLength(0);
  });

  it("does not put a key in what it returns", async () => {
    // These rows are serialised straight into an HTTP response.
    for (const provider of PROVIDERS) keys.setProviderKey(provider, TYPED[provider]);
    process.env.OPENAI_ADMIN_KEY = ADMIN_KEY;
    stubFetch(creditsBody);

    const text = JSON.stringify(await credits.getCredits());

    for (const key of [...Object.values(TYPED), ADMIN_KEY]) {
      expect(text).not.toContain(key);
    }
  });
});

// ---------------------------------------------------------------------------
// The asymmetry — the one branch that must NOT move
// ---------------------------------------------------------------------------

describe("the OpenAI branch of credits.ts keeps its own admin key", () => {
  it("stays unavailable when only the calling key was typed", async () => {
    // Two different keys for OpenAI alone: `OPENAI_API_KEY` calls models,
    // `OPENAI_ADMIN_KEY` reads the Costs API, and the Costs API 401s the first
    // one for want of `api.usage.read`. Anyone "fixing" the asymmetry by
    // pointing this branch at `providerKey("openai")` turns a truthful
    // "unavailable" into a round-trip that fails, and this case is what stops
    // them.
    keys.setProviderKey("openai", TYPED.openai);
    stubFetch(creditsBody);

    const openaiRow = row(await credits.getCredits(), "openai");

    expect(openaiRow.status).toBe("unavailable");
    expect(openaiRow.note).toContain("OPENAI_ADMIN_KEY");
    expect(callTo("api.openai.com")).toBeUndefined();
  });

  it("asks with the admin key, never with the typed calling key", async () => {
    process.env.OPENAI_ADMIN_KEY = ADMIN_KEY;
    keys.setProviderKey("openai", TYPED.openai);
    stubFetch(creditsBody);

    const openaiRow = row(await credits.getCredits(), "openai");

    expect(openaiRow.status).toBe("ok");
    expect(openaiRow.used_usd).toBe(1.25);
    const costsCall = callTo("/v1/organization/costs");
    expect(costsCall).toBeDefined();
    expect(costsCall!.authorization).toBe(`Bearer ${ADMIN_KEY}`);
    expect(costsCall!.authorization).not.toBe(`Bearer ${TYPED.openai}`);
  });

  it("is not made available by the setup screen, only by the variable", async () => {
    // `PUT /api/provider-keys/openai` makes OpenAI CALLABLE. It must not also
    // claim the app can read the organisation's spend.
    stubFetch(creditsBody);
    expect(row(await credits.getCredits(), "openai").status).toBe("unavailable");

    keys.setProviderKey("openai", TYPED.openai);
    seen = [];
    expect(row(await credits.getCredits(), "openai").status).toBe("unavailable");

    keys.clearProviderKey("openai");
    process.env.OPENAI_ADMIN_KEY = ADMIN_KEY;
    seen = [];
    expect(row(await credits.getCredits(), "openai").status).toBe("ok");
  });
});
