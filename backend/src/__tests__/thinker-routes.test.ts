import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import express from "express";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import type { ConfigTestEnvelope, RosterEnvelope } from "../routes/thinkers.js";
import type {
  ModelChoice,
  ThinkerProvider,
  ThinkerRoster,
  ThinkerSlot,
} from "../types/thinker-roster.js";

// `sandbox.ts` freezes its homedir()-derived roots at module load, so HOME has
// to point at a temp dir BEFORE anything imports it — same technique as
// `thinker-roster.test.ts` and `storage.test.ts`. Everything the store touches
// therefore lands under `tmpHome`, never in the developer's real
// `~/.local/share/voice-assistant/`; the first case below asserts exactly that
// rather than trusting the arrangement, which is why the real value is captured
// before it is replaced.
const realHome = process.env.HOME;
const tmpHome = mkdtempSync(join(tmpdir(), "thinker-routes-test-"));
process.env.HOME = tmpHome;

// The defaults follow the environment on purpose, so pin it: without this a
// developer with OPENAI_TEXT_MODEL exported reads a different default model and
// the round-trip assertions stop meaning anything.
delete process.env.OPENAI_DEEPTHINK_MODEL;
delete process.env.OPENAI_TEXT_MODEL;
delete process.env.DEEP_THINK_THINKERS;

const { default: thinkersRouter } = await import("../routes/thinkers.js");
const { ROSTER_PATH, forgetRoster } = await import(
  "../services/thinker-roster.js"
);
const { setProviderKey, clearProviderKey } = await import(
  "../services/providers/keys.js"
);
const { errorHandler } = await import("../middleware/error-handler.js");
const { MAX_THINKERS } = await import("../types/thinker-roster.js");

// ---------------------------------------------------------------------------
// Isolation
// ---------------------------------------------------------------------------

const ENV: Record<ThinkerProvider, string> = {
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
};

const PROVIDERS = Object.keys(ENV) as ThinkerProvider[];

// Long enough to clear the module's 20-character floor.
const A_KEY = "sk-test-key-for-the-roster-routes-0123456789";

// These variables are usually populated in the developer's real shell, and a
// key that leaked in would make "no key configured" cases green for the wrong
// reason. Cleared before each case and restored EXACTLY afterwards — undefined
// back to deleted, "" back to empty.
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const name of Object.values(ENV)) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
  for (const provider of PROVIDERS) clearProviderKey(provider);

  // A roster left on disk by the previous case would be the state this one
  // starts from. Both halves are needed: the file, and the copy the store keeps
  // in memory.
  rmSync(ROSTER_PATH, { force: true });
  forgetRoster();
});

afterEach(() => {
  for (const provider of PROVIDERS) clearProviderKey(provider);
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  saved.clear();
});

// ---------------------------------------------------------------------------
// The app, mounted the way `index.ts` mounts it
// ---------------------------------------------------------------------------
//
// `express.json()` with its default `strict: true` is part of the contract under
// test: it is what turns a bare `42` or `"nope"` into a 400 before the router is
// reached. `errorHandler` is included for the same reason.

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use("/api/thinkers", thinkersRouter);
app.use(errorHandler);

const server: Server = app.listen(0);
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}/api/thinkers`;

afterAll(() => {
  server.close();
  rmSync(tmpHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function choice(model: string, provider: ThinkerProvider = "openai"): ModelChoice {
  return {
    provider,
    model,
    context_window: null,
    supports_tools: true,
    rate: null,
  };
}

async function get(): Promise<{ res: Response; body: RosterEnvelope }> {
  const res = await fetch(base);
  return { res, body: (await res.json()) as RosterEnvelope };
}

/** The raw response, for the cases that assert on a status other than 200. */
function putRaw(body: unknown): Promise<Response> {
  return fetch(base, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function put(body: unknown): Promise<{ res: Response; body: RosterEnvelope }> {
  const res = await putRaw(body);
  return { res, body: (await res.json()) as RosterEnvelope };
}

async function reset(): Promise<{ res: Response; body: RosterEnvelope }> {
  const res = await fetch(`${base}/reset`, { method: "POST" });
  return { res, body: (await res.json()) as RosterEnvelope };
}

function readStoredRoster(): ThinkerRoster {
  return JSON.parse(readFileSync(ROSTER_PATH, "utf-8")) as ThinkerRoster;
}

/** The current ten rows with one of them replaced — a `slots` patch is a whole list. */
async function slotsWith(index: number, patch: Partial<ThinkerSlot>): Promise<ThinkerSlot[]> {
  const { body } = await get();
  return body.roster.slots.map((slot) =>
    slot.index === index ? { ...slot, ...patch } : slot,
  );
}

// ---------------------------------------------------------------------------
// GET /api/thinkers
// ---------------------------------------------------------------------------

describe("test isolation", () => {
  it("keeps every write inside the temp HOME, never the real data directory", () => {
    // The premise the whole file rests on, asserted rather than assumed: if
    // `sandbox.ts` ever stopped deriving DATA_ROOT from HOME, every case below
    // would start writing into the developer's own roster and still pass.
    expect(ROSTER_PATH.startsWith(tmpHome)).toBe(true);
    if (realHome) expect(ROSTER_PATH.startsWith(realHome)).toBe(false);
  });
});

describe("GET /api/thinkers", () => {
  it("answers with all MAX_THINKERS slots, including the disabled ones", async () => {
    const { res, body } = await get();

    expect(res.status).toBe(200);
    expect(body.roster.version).toBe(1);
    expect(body.roster.slots).toHaveLength(MAX_THINKERS);
    expect(body.roster.slots.map((slot) => slot.index)).toEqual(
      Array.from({ length: MAX_THINKERS }, (_, i) => i + 1),
    );

    // The disabled rows are the point: a list of "only the enabled ones" would
    // still be ten items long on a default roster, so the assertion has to be
    // that a switched-off row is here AND still carries its model.
    const off = body.roster.slots.filter((slot) => !slot.enabled);
    expect(off.length).toBeGreaterThan(0);
    for (const slot of off) expect(slot.model.model).toBe("deepseek-v4-pro");
  });

  it("reports the key status of all three providers in the same response", async () => {
    // The reason the two travel together: the UI has to draw "slot 3 uses
    // OpenRouter" and "OpenRouter has no key" at the same time, or it shows a
    // roster that does not run.
    process.env.OPENAI_API_KEY = A_KEY;
    process.env.DEEPSEEK_API_KEY = A_KEY;
    setProviderKey("deepseek", A_KEY);

    const { body } = await get();
    const by = new Map(body.providers.map((row) => [row.provider, row]));

    expect(body.providers).toHaveLength(3);
    expect(by.get("openai")).toMatchObject({
      env_var: "OPENAI_API_KEY",
      present: true,
      source: "env",
    });
    expect(by.get("deepseek")).toMatchObject({ present: true, source: "runtime" });
    expect(by.get("openrouter")).toMatchObject({ present: false, source: null });
    for (const row of body.providers) expect(row.console_url).toMatch(/^https:\/\//);
  });

  it("does not create the roster file just by being read", async () => {
    expect(existsSync(ROSTER_PATH)).toBe(false);
    await get();
    expect(existsSync(ROSTER_PATH)).toBe(false);
  });

  it("never puts a provider key in the response", async () => {
    // Asserted on the raw text, not on a parsed field: a key added to some
    // future field would still pass a per-field check.
    process.env.OPENAI_API_KEY = A_KEY;
    process.env.DEEPSEEK_API_KEY = A_KEY;
    setProviderKey("openrouter", A_KEY);

    const text = await (await fetch(base)).text();

    expect(text).not.toContain(A_KEY);
    expect(text).not.toContain("sk-");
  });
});

// ---------------------------------------------------------------------------
// PUT /api/thinkers
// ---------------------------------------------------------------------------

describe("PUT /api/thinkers", () => {
  it("accepts a partial patch and leaves what it did not mention alone", async () => {
    // What the UI sends when the operator flips one switch. Everything else on
    // the screen has to survive it.
    await put({
      master: choice("master-do-operador"),
      planner: choice("planner-do-operador"),
      slots: await slotsWith(7, { enabled: false, model: choice("mine-7") }),
    });

    const { res, body } = await put({ master: choice("master-novo") });

    expect(res.status).toBe(200);
    expect(body.roster.master.model).toBe("master-novo");
    expect(body.roster.planner.model).toBe("planner-do-operador");
    expect(body.roster.slots).toHaveLength(MAX_THINKERS);
    expect(body.roster.slots[6]!.model.model).toBe("mine-7");
    expect(body.roster.slots[6]!.enabled).toBe(false);

    // And that is what is on disk, not just what was echoed back.
    const stored = readStoredRoster();
    expect(stored.master.model).toBe("master-novo");
    expect(stored.planner.model).toBe("planner-do-operador");
    expect(stored.slots[6]!.model.model).toBe("mine-7");
  });

  it("accepts a patch of a single field", async () => {
    const { res, body } = await put({ planner: choice("so-o-planner") });

    expect(res.status).toBe(200);
    expect(body.roster.planner.model).toBe("so-o-planner");
    expect(body.roster.master.model).toBe("deepseek-v4-pro");
    expect(body.roster.slots).toHaveLength(MAX_THINKERS);
  });

  it("answers 422 for a version it does not speak, and writes nothing", async () => {
    await put({ master: choice("modelo-do-operador") });
    const before = readFileSync(ROSTER_PATH, "utf-8");

    const res = await putRaw({
      version: 2,
      master: choice("modelo-de-outro-protocolo"),
    });
    const body = (await res.json()) as { error: string };

    expect(res.status).toBe(422);
    // pt-BR, and it names the version this build speaks — a client that got the
    // protocol wrong cannot act on "unsupported version".
    expect(body.error).toContain("versão 1");
    expect(body.error).toContain("Nada foi salvo");

    // The half that matters, and the one a status-only assertion would miss: the
    // bytes on disk are the ones from before the refused request.
    expect(readFileSync(ROSTER_PATH, "utf-8")).toBe(before);

    forgetRoster();
    const { body: after } = await get();
    expect(after.roster.master.model).toBe("modelo-do-operador");
  });

  it("answers 422 for every version that is present and is not 1", async () => {
    await put({ master: choice("modelo-do-operador") });
    const before = readFileSync(ROSTER_PATH, "utf-8");

    // `null` is included deliberately: it is present, and a client that names
    // the field is claiming to know the protocol. A client that does not know
    // omits the key — the case below.
    for (const version of [2, 0, "1", null, 1.5, true]) {
      const res = await putRaw({ version, master: choice("nao-deve-entrar") });
      expect(res.status).toBe(422);
    }

    expect(readFileSync(ROSTER_PATH, "utf-8")).toBe(before);
  });

  it("accepts a patch with no version at all", async () => {
    // The store pins `version: 1` on the merge, so an omitted version is not a
    // missing one — it is the normal shape of a patch.
    const { res, body } = await put({ master: choice("sem-versao") });

    expect(res.status).toBe(200);
    expect(body.roster.version).toBe(1);
    expect(body.roster.master.model).toBe("sem-versao");
    expect(readStoredRoster().master.model).toBe("sem-versao");
  });

  it("keeps the current slots when the patch's slots is not a list", async () => {
    await put({ slots: await slotsWith(7, { model: choice("mine-7") }) });

    // Unreadable is not empty: a `null` treated as "an empty list" would hand
    // back the ten default rows and persist them over the operator's choices.
    for (const junk of [null, {}, "slots", 7, true]) {
      const { res, body } = await put({ slots: junk });
      expect(res.status).toBe(200);
      expect(body.roster.slots).toHaveLength(MAX_THINKERS);
      expect(body.roster.slots[6]!.model.model).toBe("mine-7");
    }

    expect(readStoredRoster().slots[6]!.model.model).toBe("mine-7");
  });

  it("answers 400 for a body that is not an object", async () => {
    // The array is the case this router's own guard catches — `express.json()`
    // accepts it, so nothing upstream would have.
    const res = await putRaw([{ master: choice("x") }]);
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toHaveProperty("error");

    // The scalars never reach the router: body-parser's default `strict: true`
    // refuses a JSON root that is not an object or an array, and `errorHandler`
    // maps it. Pinned anyway, because the status the caller sees is what the
    // contract promises, not which layer produced it.
    for (const body of ["nope", 42, null, true]) {
      expect((await putRaw(body)).status).toBe(400);
    }

    expect(existsSync(ROSTER_PATH)).toBe(false);
  });

  it("round-trips: what a PUT saved is what the next GET returns", async () => {
    const written = await put({
      master: {
        provider: "deepseek",
        model: "deepseek-v4-pro",
        effort: "high",
        context_window: 128_000,
        supports_tools: true,
        rate: { input: 0.28, cached_input: 0.028, output: 0.42 },
      },
      planner: choice("gpt-5.2-mini"),
      slots: await slotsWith(9, {
        enabled: false,
        model: choice("modelo-guardado"),
        angle: "custo",
      }),
    });

    // Off the disk, not out of the store's cache: the point of a round trip is
    // that the bytes survive.
    forgetRoster();
    const { body } = await get();

    expect(body.roster.master).toEqual(written.body.roster.master);
    expect(body.roster.planner).toEqual(written.body.roster.planner);
    expect(body.roster.slots).toEqual(written.body.roster.slots);
    expect(body.roster.slots[8]!.enabled).toBe(false);
    expect(body.roster.slots[8]!.model.model).toBe("modelo-guardado");
    expect(body.roster.slots[8]!.angle).toBe("custo");
  });
});

// ---------------------------------------------------------------------------
// The warning the store deliberately does not raise
// ---------------------------------------------------------------------------

describe("provider-key warnings", () => {
  it("saves a slot pointing at a provider with no key, and says so", async () => {
    // Not a rejection: the operator may be building the roster before pasting
    // the key. Saved in silence is the worse of the two failures.
    process.env.OPENAI_API_KEY = A_KEY;
    process.env.DEEPSEEK_API_KEY = A_KEY;
    process.env.DEEPSEEK_API_KEY = A_KEY;

    const { res, body } = await put({
      slots: await slotsWith(3, {
        enabled: true,
        model: choice("x-ai/grok-4", "openrouter"),
      }),
    });

    expect(res.status).toBe(200);
    expect(body.roster.slots[2]!.model.provider).toBe("openrouter");
    expect(readStoredRoster().slots[2]!.model.provider).toBe("openrouter");

    expect(body.warnings).toHaveLength(1);
    const warning = body.warnings[0]!;
    expect(warning).toMatchObject({
      code: "provider_key_missing",
      role: "thinker",
      provider: "openrouter",
      slot_index: 3,
    });
    // pt-BR, and actionable: which variable, and where the key comes from.
    expect(warning.message).toContain("pensador 3");
    expect(warning.message).toContain("OPENROUTER_API_KEY");
    expect(warning.message).toContain("openrouter.ai/keys");
  });

  it("warns about the master and the planner without a slot_index", async () => {
    setProviderKey("openai", A_KEY);

    const { body } = await put({
      master: choice("deepseek-v4-pro", "deepseek"),
      planner: choice("x-ai/grok-4", "openrouter"),
      slots: Array.from({ length: MAX_THINKERS }, (_, i) => ({
        index: i + 1,
        enabled: false,
        model: choice("deepseek-v4-pro", "deepseek"),
      })),
    });

    const by = new Map(body.warnings.map((warning) => [warning.role, warning]));
    expect(body.warnings).toHaveLength(2);
    expect(by.get("master")).toMatchObject({ provider: "deepseek" });
    expect(by.get("planner")).toMatchObject({ provider: "openrouter" });
    // `role` exists precisely so these two are distinguishable: an absent
    // `slot_index` alone would only say "not a thinker".
    expect(by.get("master")).not.toHaveProperty("slot_index");
    expect(by.get("planner")).not.toHaveProperty("slot_index");
    expect(by.get("master")!.message).toContain("DEEPSEEK_API_KEY");
  });

  it("stays quiet when every chosen provider has a key", async () => {
    for (const provider of PROVIDERS) setProviderKey(provider, A_KEY);

    const { body } = await put({
      master: choice("deepseek-v4-pro", "deepseek"),
      slots: await slotsWith(2, {
        enabled: true,
        model: choice("x-ai/grok-4", "openrouter"),
      }),
    });

    expect(body.warnings).toEqual([]);
  });

  it("does not warn about a disabled slot", async () => {
    // A disabled slot keeps its model and the round never calls it, so a key it
    // would not use is not a problem the operator has to fix now.
    process.env.OPENAI_API_KEY = A_KEY;
    process.env.DEEPSEEK_API_KEY = A_KEY;

    const { body } = await put({
      slots: await slotsWith(10, {
        enabled: false,
        model: choice("x-ai/grok-4", "openrouter"),
      }),
    });

    expect(body.roster.slots[9]!.model.provider).toBe("openrouter");
    expect(body.warnings).toEqual([]);
  });

  it("reports the warnings on a plain GET too, not only after a write", async () => {
    // The roster on disk can point at a provider whose key was never pasted —
    // or was exported in a shell that is gone. A screen that only learned about
    // it after the operator saved something would show a green roster that does
    // not run.
    process.env.OPENAI_API_KEY = A_KEY;
    process.env.DEEPSEEK_API_KEY = A_KEY;
    await put({
      slots: await slotsWith(1, {
        enabled: true,
        model: choice("x-ai/grok-4", "openrouter"),
      }),
    });

    forgetRoster();
    const { body } = await get();

    expect(body.warnings).toHaveLength(1);
    expect(body.warnings[0]).toMatchObject({
      role: "thinker",
      provider: "openrouter",
      slot_index: 1,
    });
  });

  it("warns once per row, so the UI can mark each one", async () => {
    process.env.OPENAI_API_KEY = A_KEY;
    process.env.DEEPSEEK_API_KEY = A_KEY;
    const { body: current } = await get();

    const { body } = await put({
      slots: current.roster.slots.map((slot) =>
        slot.index <= 3
          ? { ...slot, enabled: true, model: choice("x-ai/grok-4", "openrouter") }
          : slot,
      ),
    });

    expect(body.warnings.map((warning) => warning.slot_index)).toEqual([1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// POST /api/thinkers/reset
// ---------------------------------------------------------------------------

describe("POST /api/thinkers/reset", () => {
  it("puts the roster back to the defaults", async () => {
    await put({
      master: choice("deepseek-v4-pro", "deepseek"),
      planner: choice("x-ai/grok-4", "openrouter"),
      slots: await slotsWith(7, { enabled: false, model: choice("mine-7") }),
    });

    const { res, body } = await reset();

    expect(res.status).toBe(200);
    expect(body.roster.master).toMatchObject({ provider: "deepseek", model: "deepseek-v4-pro" });
    expect(body.roster.planner).toMatchObject({ provider: "deepseek", model: "deepseek-v4-pro" });
    expect(body.roster.slots).toHaveLength(MAX_THINKERS);
    expect(body.roster.slots.map((slot) => slot.model.model)).toEqual(
      Array.from({ length: MAX_THINKERS }, () => "deepseek-v4-pro"),
    );
    // `DEEP_THINK_THINKERS` is unset here, so the default is .env.example's 4.
    expect(body.roster.slots.filter((slot) => slot.enabled)).toHaveLength(4);
  });

  it("persists the reset instead of only reporting it", async () => {
    await put({ master: choice("deepseek-v4-pro", "deepseek") });
    await reset();

    expect(readStoredRoster().master.model).toBe("deepseek-v4-pro");

    forgetRoster();
    const { body } = await get();
    expect(body.roster.master.model).toBe("deepseek-v4-pro");
  });
});

// ---------------------------------------------------------------------------
// POST /api/thinkers/test
// ---------------------------------------------------------------------------

describe("POST /api/thinkers/test", () => {
  // The route runs the REAL adapters, so the provider APIs are faked at the
  // fetch layer with payloads shaped like each wire — the same technique as
  // `deep-think.test.ts`. Requests are recorded so the assertions can prove
  // what actually went out: how many calls, to whom, and with which effort.
  type Body = Record<string, unknown>;
  const requests: Body[] = [];
  const urls: string[] = [];
  /** Non-null makes the fake answer with the provider's error message. */
  let failWith: { status: number; message: string } | null = null;

  const responsesPayload: Body = {
    model: "gpt-5.2-mini",
    usage: { input_tokens: 3, output_tokens: 2 },
    output: [
      { type: "message", content: [{ type: "output_text", text: "pong" }] },
    ],
  };
  const chatPayload: Body = {
    model: "deepseek-v4-pro",
    choices: [
      { index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  };

  const savedBaseUrl = process.env.OPENAI_BASE_URL;
  // The stubbed fetch below must not eat the test's OWN calls to the local
  // server — those have to reach Express for the route to run at all. Only
  // provider URLs are faked; everything local passes through to the real fetch.
  const realFetch = globalThis.fetch.bind(globalThis);

  beforeEach(() => {
    requests.length = 0;
    urls.length = 0;
    failWith = null;
    // Pinned so the wire assertions can name the exact URL; a shell carrying
    // OPENAI_BASE_URL would otherwise move the Responses endpoint.
    delete process.env.OPENAI_BASE_URL;

    vi.stubGlobal(
      "fetch",
      async (url: unknown, init?: { body?: string }) => {
        if (String(url).includes("127.0.0.1")) {
          return realFetch(String(url), init as RequestInit);
        }
        urls.push(String(url));
        const body = JSON.parse(init?.body ?? "{}") as Body;
        requests.push(body);
        if (failWith) {
          // A const copy, because TS will not narrow the outer `let` inside
          // the nested `text` closure below.
          const failure = failWith;
          return {
            ok: false,
            status: failure.status,
            text: async () =>
              JSON.stringify({ error: { message: failure.message } }),
          };
        }
        // The two wires by model id — the only providers these cases call.
        const payload = String(body.model).includes("deepseek")
          ? chatPayload
          : responsesPayload;
        return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (savedBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = savedBaseUrl;
  });

  function post(body: unknown): Promise<Response> {
    return fetch(`${base}/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("skips a config whose provider has no key, and calls nothing", async () => {
    const res = await post({
      configs: [choice("gpt-5.2-mini", "openai")],
    });
    const body = (await res.json()) as ConfigTestEnvelope;

    expect(res.status).toBe(200);
    expect(body).toEqual({
      results: { "openai::gpt-5.2-mini::default": "skipped" },
      errors: { "openai::gpt-5.2-mini::default": "Sem chave configurada" },
    });
    // The half that matters: no key must mean no call, not a call that 401s.
    expect(urls).toEqual([]);
  });

  it("deduplicates identical configs into one call", async () => {
    setProviderKey("openai", A_KEY);
    const config = choice("gpt-5.2-mini", "openai");

    const res = await post({ configs: [config, config, config] });
    const body = (await res.json()) as ConfigTestEnvelope;

    expect(res.status).toBe(200);
    expect(body.results).toEqual({ "openai::gpt-5.2-mini::default": "ok" });
    expect(body.errors).toEqual({});
    expect(urls).toHaveLength(1);
    expect(requests).toHaveLength(1);
  });

  it("treats each effort as its own config, absent effort keyed as 'default'", async () => {
    setProviderKey("openai", A_KEY);

    const res = await post({
      configs: [
        { provider: "openai", model: "gpt-5.2-mini", effort: "high" },
        { provider: "openai", model: "gpt-5.2-mini" },
        { provider: "openai", model: "gpt-5.2-mini", effort: "high" },
      ],
    });
    const body = (await res.json()) as ConfigTestEnvelope;

    expect(Object.keys(body.results).sort()).toEqual([
      "openai::gpt-5.2-mini::default",
      "openai::gpt-5.2-mini::high",
    ]);
    expect(Object.values(body.results)).toEqual(["ok", "ok"]);
    expect(urls).toHaveLength(2);
  });

  it("answers ok on both wires, sending effort on the field each wire expects", async () => {
    setProviderKey("openai", A_KEY);
    setProviderKey("deepseek", A_KEY);

    const res = await post({
      configs: [
        { provider: "openai", model: "gpt-5.2-mini", effort: "high" },
        { provider: "deepseek", model: "deepseek-v4-pro", effort: "max" },
      ],
    });
    const body = (await res.json()) as ConfigTestEnvelope;

    expect(res.status).toBe(200);
    expect(body.results).toEqual({
      "openai::gpt-5.2-mini::high": "ok",
      "deepseek::deepseek-v4-pro::max": "ok",
    });

    // Two unique configs, two calls, one per wire.
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("/responses");
    expect(urls[1]).toContain("/chat/completions");

    // The ping and the ceilings, on the Responses wire...
    expect(requests[0]).toMatchObject({
      model: "gpt-5.2-mini",
      input: [{ role: "user", content: "ping" }],
      max_output_tokens: 10,
      reasoning: { effort: "high" },
    });
    // ...and on the Chat wire, where the same three ride under different names.
    expect(requests[1]).toMatchObject({
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 10,
      reasoning_effort: "max",
    });
  });

  it("sends no reasoning field when the config has no effort", async () => {
    setProviderKey("openai", A_KEY);

    await post({ configs: [choice("gpt-5.2-mini", "openai")] });

    // Absent means "send nothing", not "send a default": a non-reasoning model
    // rejects the field outright.
    expect(requests[0]).not.toHaveProperty("reasoning");
  });

  it("reports error, with the provider's own message, when the call fails", async () => {
    setProviderKey("deepseek", A_KEY);
    failWith = { status: 401, message: "Invalid API key" };

    const res = await post({
      configs: [{ provider: "deepseek", model: "deepseek-v4-pro" }],
    });
    const body = (await res.json()) as ConfigTestEnvelope;

    expect(res.status).toBe(200);
    expect(body.results).toEqual({ "deepseek::deepseek-v4-pro::default": "error" });
    // The provider's words, not a translation that could blame the wrong thing.
    expect(body.errors).toEqual({ "deepseek::deepseek-v4-pro::default": "Invalid API key" });
  });

  it("mixes verdicts in one answer: skipped where no key, ok where there is", async () => {
    setProviderKey("openai", A_KEY);

    const res = await post({
      configs: [
        { provider: "openai", model: "gpt-5.2-mini" },
        { provider: "openrouter", model: "x-ai/grok-4" },
      ],
    });
    const body = (await res.json()) as ConfigTestEnvelope;

    expect(body.results).toEqual({
      "openai::gpt-5.2-mini::default": "ok",
      "openrouter::x-ai/grok-4::default": "skipped",
    });
    expect(urls).toHaveLength(1);
  });

  it("never reads or writes the roster", async () => {
    setProviderKey("openai", A_KEY);

    await post({ configs: [choice("gpt-5.2-mini", "openai")] });

    // The endpoint tests configs that are not saved yet, so the file must not
    // come into existence through it.
    expect(existsSync(ROSTER_PATH)).toBe(false);
  });

  it("answers 400 for a body that is not an object or has no configs list", async () => {
    for (const body of [
      [{ provider: "openai" }],
      42,
      "nope",
      { configs: "not-a-list" },
      {},
      null,
    ]) {
      const res = await post(body);
      expect(res.status).toBe(400);
    }
    expect(urls).toEqual([]);
  });

  it("refuses an entry that cannot be tested as sent, naming its index", async () => {
    // Each entry names a field the route cannot test as received: an unknown
    // provider would pick the wrong key, a non-string model or an unknown
    // effort would go out verbatim, a non-object entry has no fields at all.
    const badConfigs: unknown[][] = [
      [{ provider: "not-a-provider", model: "x" }],
      [{ provider: "openai", model: "   " }],
      [{ provider: "openai", model: 42 }],
      [{ provider: "openai", model: "x", effort: "turbo" }],
      [{ provider: "openai" }],
      ["uma-string"],
      [null],
      [{ provider: "openai", model: "ok", effort: "max" }, { model: "no-provider" }],
    ];

    for (const configs of badConfigs) {
      const res = await post({ configs });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/configs\[(0|1)\]/);
    }
    expect(urls).toEqual([]);
  });
});

