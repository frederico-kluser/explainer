import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { MAX_THINKERS, type DeepThinkEvent, type SearchFn } from "../types/deep-tools.js";
import type { ModelChoice, ThinkerSlot } from "../types/thinker-roster.js";
import { ROSTER_PATH, forgetRoster } from "../services/thinker-roster.js";
import { priceTextResponse, type TextUsage } from "../services/pricing.js";

// The engine talks to exactly two things: the Responses API over `fetch`, and a
// `SearchFn`. Both are replaced here, so nothing in this file touches the
// network. The provider adapter sits in the path, but `fetch` is stubbed rather
// than the adapter mocked, so the request building, the carry-forward on
// `Turn.raw`, the tool loop, the `function_call` parsing and the cost
// arithmetic all run for real against payloads shaped like the API's.

// sandbox.ts freezes homedir()-derived roots at module load and the cost ledger
// writes through it, so HOME moves before the first import.
const tmpHome = mkdtempSync(join(tmpdir(), "explainer-deep-think-"));
process.env.HOME = tmpHome;
process.env.OPENAI_API_KEY = "sk-test-nao-e-uma-chave-real";
process.env.OPENAI_DEEPTHINK_MODEL = "gpt-5.2-mini";
// Pinned so the "no roster file" assertions can name the exact OpenAI endpoint;
// the shell running the suite should not decide where a round goes.
delete process.env.OPENAI_BASE_URL;

const mod = await import("../services/deep-think.js");
const costs = await import("../services/costs.js");

const MODEL = "gpt-5.2-mini";
const USAGE = {
  input_tokens: 1_000,
  output_tokens: 400,
  input_tokens_details: { cached_tokens: 0 },
};

type Body = Record<string, unknown>;
type Payload = Record<string, unknown>;

const requests: Body[] = [];
/**
 * Every call the fake API actually answered — which is exactly what a provider
 * charges for. A request that is still in flight when the round is cancelled or
 * times out never lands here, and never should be billed.
 */
const answered: Payload[] = [];
const searchCalls: string[] = [];
/** Where each request went and with which key — the provider-routing assertions. */
const urls: string[] = [];
const auths: string[] = [];
let handler: (body: Body) => Payload | Promise<Payload> = () => textPayload("vazio");

vi.stubGlobal(
  "fetch",
  async (url: unknown, init: { body: string; signal?: AbortSignal; headers?: Record<string, string> }) => {
    urls.push(String(url));
    auths.push(init.headers?.Authorization ?? "");
    const body = JSON.parse(init.body) as Body;
    requests.push(body);
    // An aborted request is dropped rather than answered: a provider does not
    // send — or bill for — an answer nobody is waiting for, and a stub that
    // ignores the signal delivers a cancelled round's answers into whatever
    // test runs next.
    const payload = await Promise.race([handler(body), rejectOnAbort(init.signal)]);
    answered.push(payload);
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  },
);

function rejectOnAbort(signal?: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (!signal) return;
    const fail = () => {
      const err = new Error("A chamada foi abortada.");
      err.name = "AbortError";
      reject(err);
    };
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
}

/** What the provider would put on the invoice for this test. */
function billedByApi(): number {
  return answered.reduce(
    (sum, payload) =>
      sum + priceTextResponse(String(payload.model ?? ""), (payload.usage ?? {}) as TextUsage),
    0,
  );
}

const searchFn: SearchFn = async (query) => {
  searchCalls.push(query);
  return {
    query,
    results: [
      {
        title: "Relatorio de 2026",
        url: "https://exemplo.test/relatorio",
        snippet: "Numeros consolidados do ano.",
      },
    ],
  };
};

// --- payload builders, shaped like the Responses API ------------------------

function textPayload(text: string): Payload {
  return {
    model: MODEL,
    usage: USAGE,
    output: [{ type: "message", content: [{ type: "output_text", text }] }],
  };
}

function searchCallPayload(query: string): Payload {
  return {
    model: MODEL,
    usage: USAGE,
    output: [
      {
        type: "function_call",
        id: `fc_${randomUUID()}`,
        call_id: `call_${randomUUID()}`,
        name: "brave_search",
        arguments: JSON.stringify({ query }),
      },
    ],
  };
}

// --- request inspection -----------------------------------------------------

function stageOf(body: Body): "planner" | "thinker" | "synthesis" {
  // Both wires carry the tool list on `body.tools` when a thinker gets one.
  if (Array.isArray(body.tools)) return "thinker";
  const text = firstUserText(body);
  if (text.includes("resposta consolidada")) return "synthesis";
  // A thinker whose model does not accept tools is called WITHOUT them, so the
  // marker above misses it; its prompt still names the role.
  if (text.includes("Voce e um dos varios pensadores")) return "thinker";
  return "planner";
}

/**
 * The Responses adapter sends `input` as an item array, the Chat adapter sends
 * `messages` — both carry `{ role, content }` — and a stage is told apart by
 * the first user turn's wording, not by the wire.
 */
function firstUserText(body: Body): string {
  const turns = Array.isArray(body.input)
    ? body.input
    : ((body.messages as Array<{ role?: string; content?: string }> | undefined) ?? []);
  return String(turns.find((item) => item.role === "user")?.content ?? "");
}

function thinkerPrompt(body: Body): string {
  return firstUserText(body);
}

function angleOf(prompt: string): string {
  return /O seu angulo e: (.+?)\./.exec(prompt)?.[1] ?? "";
}

function hasToolOutput(body: Body): boolean {
  const input = body.input;
  return (
    Array.isArray(input) &&
    input.some((item) => (item as { type?: string }).type === "function_call_output")
  );
}

// --- bus helper -------------------------------------------------------------

function waitFor(
  jobId: string,
  type: DeepThinkEvent["type"],
  timeoutMs = 10_000,
): Promise<DeepThinkEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timed out waiting for ${type}`));
    }, timeoutMs);

    const unsubscribe = mod.subscribeDeepThink((event) => {
      if (event.job_id !== jobId || event.type !== type) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(event);
    });
  });
}

/** Poll until the round has reached the state a test wants to interrupt. */
function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error("the condition never held"));
      setTimeout(tick, 5);
    };
    tick();
  });
}

/** A call the API answers by never answering: the round has to be torn off it. */
function neverAnswers(): Promise<Payload> {
  return new Promise<Payload>(() => undefined);
}

beforeEach(() => {
  requests.length = 0;
  answered.length = 0;
  searchCalls.length = 0;
  urls.length = 0;
  auths.length = 0;
  delete process.env.DEEP_THINK_MAX_SEARCHES;
});

afterEach(() => {
  // A staged roster must not leak into the next test: everything outside the
  // roster describe block is written against the default (no file).
  rmSync(ROSTER_PATH, { force: true });
  forgetRoster();
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
});

afterAll(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_DEEPTHINK_MODEL;
  rmSync(tmpHome, { recursive: true, force: true });
});

// --- roster staging ---------------------------------------------------------
//
// The engine reads the roster off disk at dispatch time, so a test that wants
// a non-default roster writes the file and drops the service's cache. The
// round and the default both follow the environment: `MODEL` is pinned at the
// top of this file, so a choice that does not override it stays on it.

function rosterChoice(overrides: Partial<ModelChoice> = {}): ModelChoice {
  return {
    provider: "openai",
    model: MODEL,
    context_window: null,
    supports_tools: true,
    rate: null,
    ...overrides,
  };
}

/** Exactly MAX_THINKERS slots in index order; the first `count` enabled. */
function enabledSlots(count: number, model: ModelChoice = rosterChoice()): ThinkerSlot[] {
  return Array.from({ length: MAX_THINKERS }, (_, i) => ({
    index: i + 1,
    enabled: i < count,
    model: { ...model },
  }));
}

function writeRoster(master: ModelChoice, planner: ModelChoice, slots: ThinkerSlot[]): void {
  mkdirSync(dirname(ROSTER_PATH), { recursive: true });
  writeFileSync(
    ROSTER_PATH,
    JSON.stringify({ version: 1, master, planner, slots, updated_at: new Date().toISOString() }),
    "utf-8",
  );
  forgetRoster();
}

describe("dispatchDeepThink", () => {
  it("clamps the thinker count into 1..MAX_THINKERS", async () => {
    handler = () => textPayload("sem plano");
    // All ten slots enabled, so the ceiling tested here is the user's number,
    // not the roster's default of four.
    writeRoster(rosterChoice(), rosterChoice(), enabledSlots(MAX_THINKERS));

    const low = await mod.dispatchDeepThink({
      conversationId: randomUUID(),
      scenario: "vale a pena migrar?",
      thinkerCount: 0,
      searchFn,
    });
    expect(low.thinkers).toHaveLength(1);
    mod.cancelDeepThink(low.id);

    const high = await mod.dispatchDeepThink({
      conversationId: randomUUID(),
      scenario: "vale a pena migrar?",
      thinkerCount: 25,
      searchFn,
    });
    expect(high.thinkers).toHaveLength(MAX_THINKERS);
    expect(MAX_THINKERS).toBe(10);
    mod.cancelDeepThink(high.id);
  });

  it("returns a running job before any model call has finished", async () => {
    handler = () => new Promise<Payload>((resolve) => setTimeout(() => resolve(textPayload("x")), 200));

    const job = await mod.dispatchDeepThink({
      conversationId: randomUUID(),
      scenario: "devo trocar de banco de dados?",
      thinkerCount: 2,
      searchFn,
    });

    // The whole point: a voice turn is not blocked on the round.
    expect(job.status).toBe("running");
    expect(job.synthesis).toBeUndefined();
    expect(job.thinkers.every((t) => t.status === "pending")).toBe(true);
    mod.cancelDeepThink(job.id);
  });

  it("reports progress, searches the web and hands every trace to the synthesiser", async () => {
    handler = (body) => {
      switch (stageOf(body)) {
        case "planner":
          return textPayload(
            'Claro:\n[{"angle":"evidencia","prompt":"levante os numeros"},' +
              '{"angle":"risco","prompt":"liste os modos de falha"}]',
          );
        case "thinker": {
          const angle = angleOf(thinkerPrompt(body));
          // The evidence thinker searches once, then writes.
          if (angle === "evidencia" && !hasToolOutput(body)) {
            return searchCallPayload("numeros consolidados 2026");
          }
          // It names the source it opened, because only a named source counts
          // as a citation now — see the citation test below.
          return textPayload(
            angle === "evidencia"
              ? `Pensamento sobre ${angle}, segundo o Relatorio de 2026, com conclusao.`
              : `Pensamento sobre ${angle}, com conclusao.`,
          );
        }
        default:
          return textPayload(
            "**Concordaram** no diagnostico.\n\n- divergiram no prazo\n\n`Conclusao`: siga.",
          );
      }
    };

    const conv = randomUUID();
    const job = await mod.dispatchDeepThink({
      conversationId: conv,
      scenario: "devo reescrever o modulo de cobranca?",
      reflection: "acho que sim, mas o prazo assusta",
      thinkerCount: 2,
      searchFn,
    });

    const activity = waitFor(job.id, "deep_think_activity");
    const done = await waitFor(job.id, "deep_think_done");
    await activity;

    expect(done.type).toBe("deep_think_done");
    if (done.type !== "deep_think_done") return;

    // The planner's angles won over the deterministic ones.
    expect(job.thinkers.map((t) => t.angle)).toEqual(["evidencia", "risco"]);
    expect(job.thinkers.every((t) => t.status === "done")).toBe(true);
    expect(done.thinkers).toHaveLength(2);

    // The web actually reached the thinker that asked for it.
    expect(searchCalls).toEqual(["numeros consolidados 2026"]);
    expect(job.thinkers[0]?.searches).toBe(1);
    expect(job.thinkers[0]?.citations?.[0]?.url).toBe("https://exemplo.test/relatorio");
    expect(job.thinkers[1]?.searches).toBe(0);
    // The thinker that never searched cannot have sources.
    expect(job.thinkers[1]?.citations).toEqual([]);

    // The synthesiser reads the full traces, not a vote.
    const synthesis = requests.filter((b) => stageOf(b) === "synthesis");
    expect(synthesis).toHaveLength(1);
    const prompt = firstUserText(synthesis[0]!);
    expect(prompt).toContain("Pensamento sobre evidencia");
    expect(prompt).toContain("Pensamento sobre risco");
    expect(prompt).toContain("devo reescrever o modulo de cobranca?");
    expect(prompt).toContain("o prazo assusta");

    // It is going to be read out loud, so no markdown survives.
    expect(done.synthesis).toContain("Concordaram no diagnostico");
    expect(done.synthesis).not.toMatch(/[`*#]/);
    expect(done.synthesis).not.toMatch(/^\s*[-*]\s/m);
    expect(job.status).toBe("done");
    expect(job.cost_usd).toBeGreaterThan(0);
  });

  it("falls back to the deterministic angles when the planner returns junk", async () => {
    handler = (body) => {
      switch (stageOf(body)) {
        case "planner":
          return textPayload("desculpa, nao consegui montar isso");
        case "thinker":
          return textPayload(`Nota de ${angleOf(thinkerPrompt(body))}.`);
        default:
          return textPayload("Consolidado.");
      }
    };

    const job = await mod.dispatchDeepThink({
      conversationId: randomUUID(),
      scenario: "vale automatizar o relatorio mensal?",
      thinkerCount: 3,
      searchFn,
    });
    await waitFor(job.id, "deep_think_done");

    expect(job.thinkers.map((t) => t.angle)).toEqual([
      "fatos e evidencias",
      "riscos e modos de falha",
      "custo e esforco",
    ]);
    expect(job.status).toBe("done");
  });

  it("keeps the round alive when one thinker fails", async () => {
    handler = (body) => {
      switch (stageOf(body)) {
        case "planner":
          return textPayload("nao vai dar");
        case "thinker": {
          const angle = angleOf(thinkerPrompt(body));
          if (angle === "riscos e modos de falha") throw new Error("o modelo caiu");
          return textPayload(`Nota de ${angle}.`);
        }
        default:
          return textPayload("Consolidado com dois de tres.");
      }
    };

    const job = await mod.dispatchDeepThink({
      conversationId: randomUUID(),
      scenario: "abrir o codigo do projeto?",
      thinkerCount: 3,
      searchFn,
    });
    const done = await waitFor(job.id, "deep_think_done");

    expect(job.status).toBe("done");
    const failed = job.thinkers.filter((t) => t.status === "error");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.angle).toBe("riscos e modos de falha");
    expect(failed[0]?.error).toMatch(/o modelo caiu/);
    expect(job.thinkers.filter((t) => t.status === "done")).toHaveLength(2);

    // The synthesis still happened, with the survivors.
    if (done.type === "deep_think_done") {
      expect(done.synthesis).toContain("Consolidado com dois de tres");
    }
  });

  it("refuses a second round in the same conversation and cancels the first", async () => {
    handler = () =>
      new Promise<Payload>((resolve) => setTimeout(() => resolve(textPayload("[]")), 100));

    const conv = randomUUID();
    const first = await mod.dispatchDeepThink({
      conversationId: conv,
      scenario: "primeira rodada",
      thinkerCount: 2,
      searchFn,
    });

    // Ten thinkers cost real money; a second concurrent round doubles the bill.
    let status = 0;
    try {
      await mod.dispatchDeepThink({ conversationId: conv, scenario: "segunda rodada", searchFn });
      expect.unreachable("the second dispatch should have been refused");
    } catch (err) {
      expect(err).toBeInstanceOf(mod.DeepThinkError);
      expect((err as InstanceType<typeof mod.DeepThinkError>).message).toMatch(
        /Ja existe uma rodada/,
      );
      status = (err as InstanceType<typeof mod.DeepThinkError>).status;
    }
    expect(status).toBe(409);

    const cancelled = waitFor(first.id, "deep_think_error");
    expect(mod.cancelDeepThink(first.id)).toBe(true);
    expect(mod.getDeepThinkJob(first.id)?.status).toBe("cancelled");

    const event = await cancelled;
    if (event.type === "deep_think_error") {
      expect(event.error).toMatch(/Cancelado pelo usuario/);
    }

    // Cancelling frees the conversation, and a finished round is not "running".
    expect(mod.cancelDeepThink(first.id)).toBe(false);
    expect(mod.listDeepThinkJobs(conv).map((j) => j.id)).toContain(first.id);
  });

  it("stops a thinker at its search budget instead of trusting the prompt", async () => {
    process.env.DEEP_THINK_MAX_SEARCHES = "2";
    handler = (body) => {
      switch (stageOf(body)) {
        case "planner":
          return textPayload("sem plano");
        case "thinker":
          return searchCallPayload("mais uma busca"); // never stops asking
        default:
          return textPayload("Consolidado.");
      }
    };

    const job = await mod.dispatchDeepThink({
      conversationId: randomUUID(),
      scenario: "quanto custa hospedar isso?",
      thinkerCount: 1,
      searchFn,
    });
    await waitFor(job.id, "deep_think_error");

    expect(searchCalls).toHaveLength(2);
    expect(job.thinkers[0]?.searches).toBe(2);
    expect(job.thinkers[0]?.status).toBe("error");
    expect(job.status).toBe("error");
  });

  it("degrades a thinker instead of the round when the web is unreachable", async () => {
    handler = (body) => {
      switch (stageOf(body)) {
        case "planner":
          return textPayload("sem plano");
        case "thinker":
          return hasToolOutput(body)
            ? textPayload("Segui sem fonte nova.")
            : searchCallPayload("qualquer coisa");
        default:
          return textPayload("Consolidado mesmo sem web.");
      }
    };

    const offline: SearchFn = async () => {
      throw new Error("brave fora do ar");
    };

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const activities: string[] = [];
    const unsubscribe = mod.subscribeDeepThink((event) => {
      if (event.type === "deep_think_activity") activities.push(event.activity);
    });

    const job = await mod.dispatchDeepThink({
      conversationId: randomUUID(),
      scenario: "a busca esta fora, e agora?",
      thinkerCount: 1,
      searchFn: offline,
    });
    await waitFor(job.id, "deep_think_done");
    unsubscribe();
    const warnings = warn.mock.calls.map((call) => call.join(" ")).join("\n");
    warn.mockRestore();

    expect(job.status).toBe("done");
    expect(job.thinkers[0]?.status).toBe("done");
    expect(job.thinkers[0]?.thinking).toMatch(/a busca na web falhou/i);

    // A search that never reached the web is not a search anyone was charged
    // for, and `searches` is the cost ledger's number.
    expect(job.thinkers[0]?.searches).toBe(0);
    expect(job.thinkers[0]?.citations).toEqual([]);

    // And the failure cannot live only inside the thinker's prose: the job, the
    // stream and the log all have to say the round ran blind.
    expect(job.activity).toMatch(/sem web/i);
    expect(activities.some((a) => /busca na web falhou/i.test(a))).toBe(true);
    expect(warnings).toMatch(/web search unreachable/i);
    expect(warnings).toMatch(/brave fora do ar/);
  });

  it("finishes with what it has when the round runs out of time", async () => {
    handler = (body) => {
      switch (stageOf(body)) {
        case "planner":
          return textPayload("sem plano");
        case "thinker":
          // Slower than the round's budget, so the timer fires first.
          return new Promise<Payload>((resolve) =>
            setTimeout(() => resolve(textPayload("tarde demais")), 400),
          );
        default:
          return textPayload("nunca chega aqui");
      }
    };

    const job = await mod.dispatchDeepThink({
      conversationId: randomUUID(),
      scenario: "isso vai estourar o tempo",
      thinkerCount: 2,
      timeoutMs: 120,
      searchFn,
    });
    const failed = await waitFor(job.id, "deep_think_error");

    expect(job.status).toBe("error");
    if (failed.type === "deep_think_error") {
      expect(failed.error).toMatch(/interrompida/i);
    }
    expect(job.thinkers.every((t) => t.status === "error")).toBe(true);
  });

  // --- the cost ledger -----------------------------------------------------
  //
  // The provider bills for every call it answered, whether or not we were still
  // listening when the answer arrived. Both of these tests interrupt a round
  // with thinkers mid-flight and compare what the job reports against what the
  // fake API actually answered. Before the fix each of them reported only the
  // planner's call and threw away two thirds of the money.

  it("bills every call the API answered when the round is cancelled", async () => {
    let stuck = 0;
    handler = (body) => {
      switch (stageOf(body)) {
        case "planner":
          return textPayload(
            '[{"angle":"evidencia","prompt":"p"},{"angle":"risco","prompt":"p"},' +
              '{"angle":"custo","prompt":"p"}]',
          );
        case "thinker":
          // First turn answered and paid for; the second never comes back, so
          // cancelling catches all three thinkers with money already spent.
          if (!hasToolOutput(body)) return searchCallPayload("uma busca");
          stuck++;
          return neverAnswers();
        default:
          return textPayload("nunca chega aqui");
      }
    };

    const job = await mod.dispatchDeepThink({
      conversationId: randomUUID(),
      scenario: "cancelar no meio custa quanto?",
      thinkerCount: 3,
      searchFn,
    });

    await waitUntil(() => stuck === 3);
    const cancelled = waitFor(job.id, "deep_think_error");
    expect(mod.cancelDeepThink(job.id)).toBe(true);
    await cancelled;

    // One planner call plus one answered turn per thinker.
    expect(answered).toHaveLength(4);
    expect(job.status).toBe("cancelled");
    expect(job.cost_usd).toBeCloseTo(billedByApi(), 12);
    // The planner alone is a quarter of the bill; that quarter used to be the
    // whole reported cost.
    expect(job.cost_usd).toBeGreaterThan(billedByApi() / 2);
  });

  it("bills every call the API answered when the round runs out of time", async () => {
    let stuck = 0;
    handler = (body) => {
      switch (stageOf(body)) {
        case "planner":
          return textPayload('[{"angle":"evidencia","prompt":"p"},{"angle":"risco","prompt":"p"}]');
        case "thinker":
          if (!hasToolOutput(body)) return searchCallPayload("uma busca");
          stuck++;
          return neverAnswers();
        default:
          return textPayload("nunca chega aqui");
      }
    };

    const job = await mod.dispatchDeepThink({
      conversationId: randomUUID(),
      scenario: "estourar o tempo custa quanto?",
      thinkerCount: 2,
      // Long enough for both first turns, short enough to keep the suite quick.
      timeoutMs: 500,
      searchFn,
    });

    await waitUntil(() => stuck === 2);
    await waitFor(job.id, "deep_think_error");

    expect(answered).toHaveLength(3);
    expect(job.status).toBe("error");
    expect(job.cost_usd).toBeCloseTo(billedByApi(), 12);
    expect(job.cost_usd).toBeGreaterThan(billedByApi() / 2);
  });

  // A round is the most expensive thing this app can do. Booked under `text` it
  // shared a bucket with every other completion and the panel could not show
  // what deep thinking had actually cost.
  it("books the round on its own cost source, not on the shared text bucket", async () => {
    handler = (body) => {
      switch (stageOf(body)) {
        case "planner":
          return textPayload('[{"angle":"evidencia","prompt":"p"}]');
        case "thinker":
          return textPayload("Concluo que sim, com confianca media.");
        default:
          return textPayload("Os pensadores concordaram que vale a pena.");
      }
    };

    const conversationId = randomUUID();
    const job = await mod.dispatchDeepThink({
      conversationId,
      scenario: "vale a pena trocar o banco?",
      thinkerCount: 1,
      searchFn,
    });
    await waitFor(job.id, "deep_think_done");

    // `finish` books the charge without awaiting it, so the round is done a tick
    // before the ledger is.
    let summary = await costs.getCosts(conversationId);
    for (let attempt = 0; attempt < 50 && summary.entries.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      summary = await costs.getCosts(conversationId);
    }

    expect(summary.entries).toHaveLength(1);
    expect(summary.entries[0]?.source).toBe("deep_think");
    expect(summary.entries[0]?.detail).toMatch(/deep_think: vale a pena/);
    expect(summary.by_source.deep_think).toBeCloseTo(billedByApi(), 12);
    expect(summary.by_source.text).toBe(0);
  });

  // --- what the round claims about the web ---------------------------------

  it("credits only the sources the thinker named, not everything the search returned", async () => {
    const twoResults: SearchFn = async (query) => {
      searchCalls.push(query);
      return {
        query,
        results: [
          {
            title: "Relatorio de 2026",
            url: "https://citado.test/relatorio",
            snippet: "Numeros consolidados do ano.",
          },
          {
            title: "Coluna de opiniao",
            url: "https://descartado.test/nota",
            snippet: "Achismo sem numero nenhum.",
          },
        ],
      };
    };

    handler = (body) => {
      switch (stageOf(body)) {
        case "planner":
          return textPayload("sem plano");
        case "thinker": {
          const angle = angleOf(thinkerPrompt(body));
          if (!hasToolOutput(body)) return searchCallPayload(`dados de ${angle}`);
          return textPayload(
            angle === "fatos e evidencias"
              ? "Segundo o Relatorio de 2026, os numeros fecham."
              : "Nao citei nenhuma fonte, ignorei tudo.",
          );
        }
        default:
          return textPayload("Consolidado.");
      }
    };

    const job = await mod.dispatchDeepThink({
      conversationId: randomUUID(),
      scenario: "o que as fontes dizem?",
      thinkerCount: 2,
      searchFn: twoResults,
    });
    await waitFor(job.id, "deep_think_done");

    // Both thinkers saw two results each. Only the named one is a source.
    expect(searchCalls).toHaveLength(2);
    expect(job.thinkers[0]?.searches).toBe(1);
    expect(job.thinkers[0]?.citations?.map((c) => c.url)).toEqual([
      "https://citado.test/relatorio",
    ]);
    expect(job.thinkers[1]?.searches).toBe(1);
    expect(job.thinkers[1]?.citations).toEqual([]);
  });

  it("warns instead of reporting zero when the model is not in the rate card", async () => {
    const unknown = `modelo-fora-do-rate-card-${randomUUID()}`;
    process.env.OPENAI_DEEPTHINK_MODEL = unknown;
    handler = (body) => ({
      ...(stageOf(body) === "thinker" ? textPayload("Pensei sozinho.") : textPayload("Consolidado.")),
      model: unknown,
    });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const job = await mod.dispatchDeepThink({
      conversationId: randomUUID(),
      scenario: "e se o modelo nao estiver na tabela?",
      thinkerCount: 1,
      searchFn,
    });
    await waitFor(job.id, "deep_think_done");
    const warnings = warn.mock.calls.map((call) => call.join(" ")).join("\n");
    warn.mockRestore();
    process.env.OPENAI_DEEPTHINK_MODEL = MODEL;

    // A missing price is a bookkeeping problem, not a reason to refuse to think.
    expect(job.status).toBe("done");
    expect(job.cost_usd).toBeUndefined();
    expect(warnings).toContain(unknown);
    expect(warnings).toMatch(/rate card/i);
  });

  it("strips rules, table separators, raw links and markup out of what is spoken", async () => {
    handler = (body) => {
      switch (stageOf(body)) {
        case "planner":
          return textPayload("sem plano");
        case "thinker":
          return textPayload("Nota curta.");
        default:
          return textPayload(
            "Resumo do que ficou.\n\n---\n\n| fonte | numero |\n|--------|--------|\n" +
              "| a | 1 |\n\nDetalhes em https://exemplo.test/cru?x=1 e " +
              "<b>preste atencao</b> no prazo.",
          );
      }
    };

    const job = await mod.dispatchDeepThink({
      conversationId: randomUUID(),
      scenario: "isso vai ser lido em voz alta",
      thinkerCount: 1,
      searchFn,
    });
    const done = await waitFor(job.id, "deep_think_done");
    if (done.type !== "deep_think_done") return;

    // Everything below would otherwise be read out loud, character by character.
    expect(done.synthesis).not.toMatch(/^[ \t]*[-=_|: \t]{3,}$/m);
    expect(done.synthesis).not.toContain("https://");
    expect(done.synthesis).not.toMatch(/[<>|]/);
    // The attribution survives; only the unspeakable part of the link is gone.
    expect(done.synthesis).toContain("exemplo.test");
    expect(done.synthesis).toContain("preste atencao");
    expect(done.synthesis).toContain("Resumo do que ficou");
  });

  it("rejects an empty scenario", async () => {
    await expect(
      mod.dispatchDeepThink({ conversationId: randomUUID(), scenario: "   ", searchFn }),
    ).rejects.toThrow(mod.DeepThinkError);
  });
});

// --- the roster -------------------------------------------------------------
//
// The engine reads `thinker-roster.json` at dispatch time, so these tests stage
// a file and drop the service's cache. The Chat-wire tests run the OpenRouter
// adapter for real against the same stubbed `fetch` — the request building, the
// usage mapping and the price arithmetic all execute, exactly like the
// Responses-wire tests above.

describe("roster", () => {
  /** The Chat-wire response shape OpenRouter and DeepSeek answer with. */
  function chatTextPayload(text: string, model = MODEL): Payload {
    return {
      model,
      usage: {
        prompt_tokens: 1_000,
        completion_tokens: 400,
        prompt_tokens_details: { cached_tokens: 0 },
      },
      choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
    };
  }

  /** A handler that answers every stage over the Chat wire. */
  function chatHandler(model: string): (body: Body) => Payload {
    return (body) => {
      switch (stageOf(body)) {
        case "planner":
          return chatTextPayload(
            '[{"angle":"evidencia","prompt":"levante os numeros"},' +
              '{"angle":"risco","prompt":"liste os modos de falha"}]',
            model,
          );
        case "thinker":
          return chatTextPayload(
            `Pensamento sobre ${angleOf(thinkerPrompt(body))}, com conclusao.`,
            model,
          );
        default:
          return chatTextPayload("Consolidado.", model);
      }
    };
  }

  it("routes an OpenRouter choice to the OpenRouter adapter with its own key", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-v1-chave-de-teste-abcdefghijklmn";
    const orChoice = rosterChoice({
      provider: "openrouter",
      model: "deepseek/deepseek-v4-pro",
      effort: "high",
    });
    writeRoster(orChoice, orChoice, enabledSlots(2, orChoice));
    handler = chatHandler(orChoice.model);

    // The model is off the static rate card; the round must still run.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const job = await mod.dispatchDeepThink({
      conversationId: randomUUID(),
      scenario: "devo trocar de banco de dados?",
      thinkerCount: 2,
      searchFn,
    });
    await waitFor(job.id, "deep_think_done");
    const warnings = warn.mock.calls.map((call) => call.join(" ")).join("\n");
    warn.mockRestore();

    expect(job.status).toBe("done");
    expect(requests.length).toBeGreaterThan(0);

    // The whole round — planner, thinkers and master — went to OpenRouter's
    // endpoint, carrying OpenRouter's key, never the OpenAI one.
    expect(urls.every((u) => u.startsWith("https://openrouter.ai/api/v1/chat/completions"))).toBe(
      true,
    );
    expect(auths.every((a) => a === "Bearer sk-or-v1-chave-de-teste-abcdefghijklmn")).toBe(true);
    // And the model id the operator chose, with its effort, on the Chat wire's
    // own field.
    expect(requests.every((b) => b.model === "deepseek/deepseek-v4-pro")).toBe(true);
    expect(requests.every((b) => b.reasoning_effort === "high")).toBe(true);

    // A model the rate card has never heard of warns instead of pricing at zero
    // in silence — the same contract as the OpenAI path.
    expect(warnings).toContain("deepseek/deepseek-v4-pro");
    expect(warnings).toMatch(/rate card/i);
  });

  it("calls a thinker whose model does not accept tools without them", async () => {
    const noTools = rosterChoice({ supports_tools: false });
    writeRoster(rosterChoice(), rosterChoice(), enabledSlots(2, noTools));

    handler = (body) => {
      switch (stageOf(body)) {
        case "planner":
          return textPayload('[{"angle":"evidencia","prompt":"p"},{"angle":"risco","prompt":"p"}]');
        case "thinker":
          return textPayload(`Pensamento sobre ${angleOf(thinkerPrompt(body))}, sem a web.`);
        default:
          return textPayload("Consolidado.");
      }
    };

    const job = await mod.dispatchDeepThink({
      conversationId: randomUUID(),
      scenario: "pensar sem ferramentas",
      thinkerCount: 2,
      searchFn,
    });
    await waitFor(job.id, "deep_think_done");

    const thinkerBodies = requests.filter((b) => stageOf(b) === "thinker");
    expect(thinkerBodies).toHaveLength(2);
    // No `tools` key at all — the wire must not even see an empty tool list.
    expect(thinkerBodies.every((b) => b.tools === undefined)).toBe(true);
    // The web is lost, not the thinker: it still answered on its first turn.
    expect(job.thinkers.every((t) => t.status === "done")).toBe(true);
    expect(searchCalls).toHaveLength(0);
  });

  it("overrides the planner's angle with the slot's fixed angle", async () => {
    const slots = enabledSlots(2);
    slots[0]!.angle = "tributacao";
    writeRoster(rosterChoice(), rosterChoice(), slots);

    handler = (body) => {
      switch (stageOf(body)) {
        case "planner":
          return textPayload('[{"angle":"evidencia","prompt":"p"},{"angle":"risco","prompt":"p"}]');
        case "thinker":
          return textPayload(`Nota de ${angleOf(thinkerPrompt(body))}.`);
        default:
          return textPayload("Consolidado.");
      }
    };

    const job = await mod.dispatchDeepThink({
      conversationId: randomUUID(),
      scenario: "revisar a estrutura tributaria?",
      thinkerCount: 2,
      searchFn,
    });
    await waitFor(job.id, "deep_think_done");

    // The slot's label won for that thinker; the planner's name survives on
    // the other one.
    expect(job.thinkers[0]?.angle).toBe("tributacao");
    expect(job.thinkers[1]?.angle).toBe("risco");
    const prompts = requests.filter((b) => stageOf(b) === "thinker").map((b) => thinkerPrompt(b));
    expect(prompts[0]).toContain("O seu angulo e: tributacao");
    expect(prompts[1]).toContain("O seu angulo e: risco");
  });

  it("passes a choice's effort through on the Responses wire", async () => {
    const eager = rosterChoice({ effort: "high" });
    writeRoster(eager, eager, enabledSlots(1, eager));

    handler = (body) => {
      switch (stageOf(body)) {
        case "planner":
          return textPayload('[{"angle":"evidencia","prompt":"p"}]');
        case "thinker":
          return textPayload("Pensamento rapido.");
        default:
          return textPayload("Consolidado.");
      }
    };

    const job = await mod.dispatchDeepThink({
      conversationId: randomUUID(),
      scenario: "esforco alto",
      thinkerCount: 1,
      searchFn,
    });
    await waitFor(job.id, "deep_think_done");

    expect(requests.length).toBeGreaterThan(0);
    expect(
      requests.every((b) => (b.reasoning as { effort?: string } | undefined)?.effort === "high"),
    ).toBe(true);
  });

  it("falls back to today's model and provider when no roster file exists", async () => {
    handler = (body) => {
      switch (stageOf(body)) {
        case "planner":
          return textPayload('[{"angle":"evidencia","prompt":"p"}]');
        case "thinker":
          return textPayload("Pensamento sem roster.");
        default:
          return textPayload("Consolidado.");
      }
    };

    const job = await mod.dispatchDeepThink({
      conversationId: randomUUID(),
      scenario: "roster ausente",
      thinkerCount: 1,
      searchFn,
    });
    await waitFor(job.id, "deep_think_done");

    expect(requests.length).toBeGreaterThan(0);
    // The default roster reproduces deepThinkModel() bit for bit: the same
    // provider (OpenAI's Responses endpoint) and the same model id on every
    // call of the round.
    expect(urls.every((u) => u.startsWith("https://api.openai.com/v1/responses"))).toBe(true);
    expect(requests.every((b) => b.model === MODEL)).toBe(true);
    // And no effort is invented where the roster has none.
    expect(requests.every((b) => b.reasoning === undefined)).toBe(true);
  });

  it("warns up front when the roster routes to a provider without a key", async () => {
    delete process.env.OPENROUTER_API_KEY;
    const orChoice = rosterChoice({ provider: "openrouter", model: "deepseek/deepseek-v4-pro" });
    writeRoster(orChoice, orChoice, enabledSlots(1, orChoice));

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const job = await mod.dispatchDeepThink({
      conversationId: randomUUID(),
      scenario: "sem chave do openrouter",
      thinkerCount: 1,
      searchFn,
    });
    await waitFor(job.id, "deep_think_error");
    const warnings = warn.mock.calls.map((call) => call.join(" ")).join("\n");
    warn.mockRestore();

    // The round said, before spending, that this provider is doomed...
    expect(warnings).toMatch(/no key configured/i);
    expect(warnings).toContain("openrouter");
    // ...and then degraded per role instead of crashing: the thinker reports
    // the failure and the round finishes with an error naming the key.
    expect(job.thinkers[0]?.status).toBe("error");
    expect(job.status).toBe("error");
    expect(job.error).toContain("OPENROUTER_API_KEY");
  });

  it("refuses a round when the roster has no enabled slots", async () => {
    writeRoster(rosterChoice(), rosterChoice(), enabledSlots(0));

    await expect(
      mod.dispatchDeepThink({
        conversationId: randomUUID(),
        scenario: "ninguem pensa",
        searchFn,
      }),
    ).rejects.toThrow(/Nenhum pensador habilitado no roster/);
  });
});
