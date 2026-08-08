import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { MAX_THINKERS, type DeepThinkEvent, type SearchFn } from "../types/deep-tools.js";
import { priceTextResponse, type TextUsage } from "../services/pricing.js";

// The engine talks to exactly two things: the Responses API over `fetch`, and a
// `SearchFn`. Both are replaced here, so nothing in this file touches the
// network. `fetch` is stubbed rather than the module mocked, so the request
// building, the tool loop, the `function_call` parsing and the cost arithmetic
// all run for real against payloads shaped like the API's.

// sandbox.ts freezes homedir()-derived roots at module load and the cost ledger
// writes through it, so HOME moves before the first import.
const tmpHome = mkdtempSync(join(tmpdir(), "explainer-deep-think-"));
process.env.HOME = tmpHome;
process.env.OPENAI_API_KEY = "sk-test-nao-e-uma-chave-real";
process.env.OPENAI_DEEPTHINK_MODEL = "gpt-5.2-mini";

const mod = await import("../services/deep-think.js");

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
let handler: (body: Body) => Payload | Promise<Payload> = () => textPayload("vazio");

vi.stubGlobal("fetch", async (_url: string, init: { body: string; signal?: AbortSignal }) => {
  const body = JSON.parse(init.body) as Body;
  requests.push(body);
  // An aborted request is dropped rather than answered: a provider does not send
  // — or bill for — an answer nobody is waiting for, and a stub that ignores the
  // signal delivers a cancelled round's answers into whatever test runs next.
  const payload = await Promise.race([handler(body), rejectOnAbort(init.signal)]);
  answered.push(payload);
  return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
});

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
  if (Array.isArray(body.tools)) return "thinker";
  return String(body.input ?? "").includes("resposta consolidada")
    ? "synthesis"
    : "planner";
}

function thinkerPrompt(body: Body): string {
  const input = body.input as Array<{ content?: string }> | undefined;
  return String(input?.[0]?.content ?? "");
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
  delete process.env.DEEP_THINK_MAX_SEARCHES;
});

afterAll(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_DEEPTHINK_MODEL;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("dispatchDeepThink", () => {
  it("clamps the thinker count into 1..MAX_THINKERS", () => {
    handler = () => textPayload("sem plano");

    const low = mod.dispatchDeepThink({
      conversationId: randomUUID(),
      scenario: "vale a pena migrar?",
      thinkerCount: 0,
      searchFn,
    });
    expect(low.thinkers).toHaveLength(1);
    mod.cancelDeepThink(low.id);

    const high = mod.dispatchDeepThink({
      conversationId: randomUUID(),
      scenario: "vale a pena migrar?",
      thinkerCount: 25,
      searchFn,
    });
    expect(high.thinkers).toHaveLength(MAX_THINKERS);
    expect(MAX_THINKERS).toBe(10);
    mod.cancelDeepThink(high.id);
  });

  it("returns a running job before any model call has finished", () => {
    handler = () => new Promise<Payload>((resolve) => setTimeout(() => resolve(textPayload("x")), 200));

    const job = mod.dispatchDeepThink({
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
    const job = mod.dispatchDeepThink({
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
    const prompt = String(synthesis[0]?.input ?? "");
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

    const job = mod.dispatchDeepThink({
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

    const job = mod.dispatchDeepThink({
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
    const first = mod.dispatchDeepThink({
      conversationId: conv,
      scenario: "primeira rodada",
      thinkerCount: 2,
      searchFn,
    });

    // Ten thinkers cost real money; a second concurrent round doubles the bill.
    let status = 0;
    try {
      mod.dispatchDeepThink({ conversationId: conv, scenario: "segunda rodada", searchFn });
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

    const job = mod.dispatchDeepThink({
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

    const job = mod.dispatchDeepThink({
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

    const job = mod.dispatchDeepThink({
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

    const job = mod.dispatchDeepThink({
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

    const job = mod.dispatchDeepThink({
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

    const job = mod.dispatchDeepThink({
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
    const job = mod.dispatchDeepThink({
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

    const job = mod.dispatchDeepThink({
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

  it("rejects an empty scenario", () => {
    expect(() =>
      mod.dispatchDeepThink({ conversationId: randomUUID(), scenario: "   ", searchFn }),
    ).toThrow(mod.DeepThinkError);
  });
});
