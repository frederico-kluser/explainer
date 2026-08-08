import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { MAX_THINKERS } from "../types/deep-tools.js";
import type { DeepThinkJob, MermaidDiagram, MermaidRequest } from "../types/deep-tools.js";
import type { DeepThinkOptions } from "../services/deep-think.js";
import type { MermaidOptions } from "../services/mermaid.js";

// What is under test here is the handler layer, so both engines are replaced at
// their entry points and nothing in this file reaches the network, a model or a
// disk it did not create. Everything else in those modules stays real —
// `DeepThinkError`, `MermaidError` and `MERMAID_KINDS` are the contract these
// handlers branch on, and a hand-written stand-in for them would drift silently.

// Importing the real modules pulls in the cost ledger, which reaches storage,
// which imports sandbox.ts — and that freezes homedir()-derived roots at module
// load. HOME first, imports after, same as storage.test.ts.
const tmpHome = mkdtempSync(join(tmpdir(), "explainer-deliberation-"));
process.env.HOME = tmpHome;

const deep = {
  jobs: [] as DeepThinkJob[],
  dispatched: [] as DeepThinkOptions[],
  onDispatch: null as null | ((options: DeepThinkOptions) => DeepThinkJob),
};

const drawing = {
  calls: [] as Array<{ request: MermaidRequest; options: MermaidOptions }>,
  onGenerate: null as
    | null
    | ((request: MermaidRequest, options: MermaidOptions) => Promise<MermaidDiagram>),
};

const memory = {
  recorded: [] as Array<{ conversationId: string; diagram: MermaidDiagram }>,
  fail: false,
};

vi.mock("../services/deep-think.js", async () => {
  const actual = await vi.importActual<typeof import("../services/deep-think.js")>(
    "../services/deep-think.js",
  );
  return {
    ...actual,
    dispatchDeepThink: (options: DeepThinkOptions): DeepThinkJob => {
      deep.dispatched.push(options);
      if (deep.onDispatch) return deep.onDispatch(options);
      const created = makeJob({
        conversation_id: options.conversationId,
        scenario: options.scenario,
      });
      deep.jobs.push(created);
      return created;
    },
    getDeepThinkJob: (id: string) => deep.jobs.find((job) => job.id === id),
    listDeepThinkJobs: (conversationId: string) =>
      deep.jobs.filter((job) => job.conversation_id === conversationId),
  };
});

vi.mock("../services/mermaid.js", async () => {
  const actual = await vi.importActual<typeof import("../services/mermaid.js")>(
    "../services/mermaid.js",
  );
  return {
    ...actual,
    generateMermaid: async (
      request: MermaidRequest,
      _conversationId: string,
      options: MermaidOptions = {},
    ): Promise<MermaidDiagram> => {
      drawing.calls.push({ request, options });
      if (!drawing.onGenerate) return makeDiagram();
      return drawing.onGenerate(request, options);
    },
  };
});

vi.mock("../services/memory.js", () => ({
  recordDiagram: async (conversationId: string, diagram: MermaidDiagram) => {
    if (memory.fail) throw new Error("disco cheio");
    memory.recorded.push({ conversationId, diagram });
  },
}));

const { DeepThinkError } = await import("../services/deep-think.js");
const { MermaidError } = await import("../services/mermaid.js");
const tools = await import("../tools/deliberation-tools.js");

const CONV = "550e8400-e29b-41d4-a716-446655440000";
const OTHER_CONV = "550e8400-e29b-41d4-a716-446655440001";

const SOURCE = 'flowchart TD\n    A["Navegador"] --> B["Backend"]';
const CAPTION = "O navegador chama o backend e recebe a resposta de volta.";

function makeJob(overrides: Partial<DeepThinkJob> = {}): DeepThinkJob {
  return {
    id: randomUUID(),
    conversation_id: CONV,
    scenario: "trocar o banco de dados no meio do trimestre",
    status: "running",
    activity: "planejando os angulos",
    thinkers: [
      { id: "t1", angle: "riscos e modos de falha", status: "pending" },
      { id: "t2", angle: "custo e esforco", status: "pending" },
    ],
    started_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeDiagram(overrides: Partial<MermaidDiagram> = {}): MermaidDiagram {
  return {
    id: randomUUID(),
    kind: "flowchart",
    source: SOURCE,
    caption: CAPTION,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  deep.jobs = [];
  deep.dispatched = [];
  deep.onDispatch = null;
  drawing.calls = [];
  drawing.onGenerate = null;
  memory.recorded = [];
  memory.fail = false;
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// generate_diagram
// ---------------------------------------------------------------------------

describe("runGenerateDiagram", () => {
  const args = { instructions: "desenha o caminho de uma chamada de ferramenta" };

  // The contract that makes this tool usable at all: `output` becomes a
  // `function_call_output`, and `prompts.ts` orders the model to read one out
  // loud exactly as written. Mermaid source in `output` is the model spelling
  // "flowchart TD A arrow B" to a listener.
  it("speaks only the caption and hands the drawing over in meta", async () => {
    const diagram = makeDiagram({ title: "Chamada de ferramenta" });
    drawing.onGenerate = async () => diagram;

    const outcome = await tools.runGenerateDiagram(args, CONV);

    expect(outcome.output).toBe(CAPTION);
    expect(outcome.output).not.toContain("flowchart");
    expect(outcome.output).not.toContain("-->");
    expect(outcome.meta?.diagram).toEqual(diagram);
  });

  it("carries the whole diagram object, not a summary of it", async () => {
    const diagram = makeDiagram({ title: "Fluxo" });
    drawing.onGenerate = async () => diagram;

    const outcome = await tools.runGenerateDiagram(args, CONV);
    const carried = outcome.meta?.diagram as MermaidDiagram;

    expect(carried.id).toBe(diagram.id);
    expect(carried.kind).toBe("flowchart");
    expect(carried.title).toBe("Fluxo");
    expect(carried.source).toBe(SOURCE);
    expect(carried.caption).toBe(CAPTION);
    expect(carried.created_at).toBe(diagram.created_at);
  });

  it("records the diagram in the conversation's memory", async () => {
    const diagram = makeDiagram();
    drawing.onGenerate = async () => diagram;

    await tools.runGenerateDiagram(args, CONV);

    expect(memory.recorded).toHaveLength(1);
    expect(memory.recorded[0]?.conversationId).toBe(CONV);
    expect(memory.recorded[0]?.diagram).toEqual(diagram);
  });

  // The drawing is already on screen and already paid for. Losing the tool over
  // a bookkeeping write would cost the conversation something real to save
  // something that does not matter to it.
  it("still answers with the diagram when recording it fails", async () => {
    const diagram = makeDiagram();
    drawing.onGenerate = async () => diagram;
    memory.fail = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const outcome = await tools.runGenerateDiagram(args, CONV);

    expect(outcome.output).toBe(CAPTION);
    expect(outcome.meta?.diagram).toEqual(diagram);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/could not record/);
    warn.mockRestore();
  });

  it("asks the generator for two attempts and hands it a signal", async () => {
    await tools.runGenerateDiagram(args, CONV);

    expect(drawing.calls).toHaveLength(1);
    expect(drawing.calls[0]?.options.attempts).toBe(2);
    expect(drawing.calls[0]?.options.signal).toBeInstanceOf(AbortSignal);
    expect(drawing.calls[0]?.options.signal?.aborted).toBe(false);
  });

  // `api.runTool` in the browser has no timeout of its own, so without this
  // ceiling the realtime model waits on an unanswered `function_call_output`
  // for as long as three sequential 45 s calls take.
  it("gives up out loud after 25 s instead of holding the turn open", async () => {
    vi.useFakeTimers();
    drawing.onGenerate = (_request, options) =>
      new Promise<MermaidDiagram>((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });

    const pending = tools.runGenerateDiagram(args, CONV);
    await vi.advanceTimersByTimeAsync(25_000);
    const outcome = await pending;

    expect(outcome.output).toMatch(/nao consegui desenhar a tempo/i);
    expect(outcome.output).toMatch(/palavras/);
    expect(outcome.meta).toBeUndefined();
    expect(memory.recorded).toEqual([]);
  });

  it("does not give up early while the generator is still inside the budget", async () => {
    vi.useFakeTimers();
    const diagram = makeDiagram();
    drawing.onGenerate = (_request, options) =>
      new Promise<MermaidDiagram>((resolve, reject) => {
        setTimeout(() => resolve(diagram), 20_000);
        options.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });

    const pending = tools.runGenerateDiagram(args, CONV);
    await vi.advanceTimersByTimeAsync(24_000);

    await expect(pending).resolves.toMatchObject({ output: CAPTION });
  });

  it("passes the generator's own refusal through, because it is already spoken", async () => {
    drawing.onGenerate = async () => {
      throw new MermaidError("O desenho ficou grande demais e foi cortado no meio.", [
        "truncado",
      ]);
    };

    const outcome = await tools.runGenerateDiagram(args, CONV);

    expect(outcome.output).toBe("O desenho ficou grande demais e foi cortado no meio.");
    expect(outcome.meta).toBeUndefined();
  });

  // The test above passes because the message it builds by hand is clean. The
  // exhaustion message the generator really produces was not: it interpolated
  // `problems`, which is the validator's own vocabulary, and the model reads
  // `output` out loud exactly as written. These three strings were measured
  // coming out of `generateMermaid`, not invented for the test.
  describe("never speaks the generator's diagnosis, whatever it is", () => {
    const CAPTION_SYNTAX = /[[\]{}|<>`]|%%|-{1,2}\)|\(\(|\)\)|[A-Za-z0-9_]\(|::/;

    const leaked: Record<string, string> = {
      "node ids and arrows echoed back from the refused source":
        'Tentei 2 vezes e o diagrama continuou invalido. O que deu errado: A primeira ' +
        "linha util precisa declarar o tipo do diagrama, um destes: flowchart, " +
        "sequenceDiagram, classDiagram, stateDiagram-v2, erDiagram, journey, gantt, " +
        'pie, mindmap, timeline. Veio "grafico TD A["Navegador"] --> B["Backend do ' +
        'Explainer"] --> ". Me explica de outro jeito o que voce quer no desenho que ' +
        "eu tento de novo.",
      "the bracket count, read out as symbols":
        "Tentei 2 vezes e o diagrama continuou invalido. O que deu errado: Faltou " +
        'fechar 2 simbolo(s): [ {. Cada "[", "(" ou "{" precisa do par dele. Me ' +
        "explica de outro jeito o que voce quer no desenho que eu tento de novo.",
      "two mermaid keywords the user has no use for":
        'Tentei 2 vezes e o diagrama continuou invalido. O que deu errado: Troque ' +
        '"graph" por "flowchart" na primeira linha. Me explica de outro jeito o que ' +
        "voce quer no desenho que eu tento de novo.",
    };

    for (const [name, message] of Object.entries(leaked)) {
      it(`refuses to say ${name}`, async () => {
        drawing.onGenerate = async () => {
          throw new MermaidError(message, ["diagnostico"]);
        };
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        const outcome = await tools.runGenerateDiagram(args, CONV);

        expect(outcome.output).not.toMatch(CAPTION_SYNTAX);
        expect(outcome.output).toMatch(/explique em palavras/);
        // Moved, not dropped: a diagnosis belongs in the log.
        expect(warn.mock.calls.flat().join(" ")).toContain(message);
        warn.mockRestore();
      });
    }
  });

  it("answers an unexpected failure with a sentence, never a stack trace", async () => {
    drawing.onGenerate = async () => {
      throw new TypeError("payload.output is not iterable");
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const outcome = await tools.runGenerateDiagram(args, CONV);

    expect(outcome.output).not.toMatch(/payload\.output/);
    expect(outcome.output).toMatch(/ofereca explicar em palavras/);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("refuses empty or missing instructions without paying for a call", async () => {
    for (const bad of [{}, { instructions: "   " }, { instructions: 42 }]) {
      const outcome = await tools.runGenerateDiagram(bad, CONV);
      expect(outcome.output).toMatch(/Preciso saber o que desenhar/);
      expect(outcome.meta).toBeUndefined();
    }
    expect(drawing.calls).toEqual([]);
  });

  it("keeps a kind from the closed list and drops an invented one", async () => {
    await tools.runGenerateDiagram({ ...args, kind: "sequenceDiagram" }, CONV);
    expect(drawing.calls[0]?.request.kind).toBe("sequenceDiagram");

    await tools.runGenerateDiagram({ ...args, kind: "graphviz" }, CONV);
    expect(drawing.calls[1]?.request.kind).toBeUndefined();
    // A bad nudge is not a failed call: the generator reads the kind out of the
    // wording perfectly well without it.
    expect(drawing.calls[1]?.request.instructions).toBe(args.instructions);
  });

  it("passes a title through and omits it when absent", async () => {
    await tools.runGenerateDiagram({ ...args, title: "Chamada de ferramenta" }, CONV);
    expect(drawing.calls[0]?.request.title).toBe("Chamada de ferramenta");

    await tools.runGenerateDiagram({ ...args, title: "  " }, CONV);
    expect(drawing.calls[1]?.request.title).toBeUndefined();
  });

  it("falls back to a spoken line if the caption comes back empty", async () => {
    drawing.onGenerate = async () => makeDiagram({ caption: "   " });

    const outcome = await tools.runGenerateDiagram(args, CONV);

    expect(outcome.output.trim().length).toBeGreaterThan(0);
    expect(outcome.output).toMatch(/diagrama na tela/);
  });
});

// ---------------------------------------------------------------------------
// deep_think
// ---------------------------------------------------------------------------

describe("runDeepThink", () => {
  const args = { scenario: "trocar o banco de dados no meio do trimestre" };

  // Same shape as `dispatch_pi_agent`: the round takes minutes and a spoken
  // conversation cannot hold that, so the tool answers in milliseconds with an
  // instruction to say so out loud and keep talking.
  it("returns at once, telling the model to announce it and carry on", async () => {
    const outcome = await tools.runDeepThink(args, CONV);

    expect(outcome.output).toMatch(/voz alta/);
    expect(outcome.output).toMatch(/continue a conversa/i);
    expect(outcome.output).toMatch(/chega|chegar/);
    expect(deep.dispatched).toHaveLength(1);
    expect(deep.dispatched[0]?.scenario).toBe(args.scenario);
  });

  // The mirror of the 409 test below, and the path that runs every single time.
  // The id was left in this one, so the ordinary success case had the model
  // reading a uuid out digit by digit.
  it("does not read the job uuid out loud on the path that always runs", async () => {
    const outcome = await tools.runDeepThink(args, CONV);
    const job = deep.jobs[0]!;

    expect(outcome.output).not.toContain(job.id);
    expect(outcome.output).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
    // Still available to the browser, which is what `meta` is for.
    expect(outcome.meta?.job_id).toBe(job.id);
  });

  it("carries the job, its status, its activity and the angles in meta", async () => {
    const outcome = await tools.runDeepThink(args, CONV);
    const job = deep.jobs[0]!;

    expect(outcome.meta).toEqual({
      job_id: job.id,
      status: "running",
      activity: "planejando os angulos",
      angles: ["riscos e modos de falha", "custo e esforco"],
    });
  });

  it("passes an optional reflection and omits it when absent", async () => {
    await tools.runDeepThink({ ...args, reflection: "acho que nao vale a pena" }, CONV);
    expect(deep.dispatched[0]?.reflection).toBe("acho que nao vale a pena");

    await tools.runDeepThink({ ...args, reflection: "  " }, CONV);
    expect(deep.dispatched[1]?.reflection).toBeUndefined();
  });

  it("clamps thinker_count instead of refusing a number out of range", async () => {
    await tools.runDeepThink({ ...args, thinker_count: 99 }, CONV);
    expect(deep.dispatched[0]?.thinkerCount).toBe(MAX_THINKERS);

    await tools.runDeepThink({ ...args, thinker_count: 0 }, CONV);
    expect(deep.dispatched[1]?.thinkerCount).toBe(1);

    await tools.runDeepThink({ ...args, thinker_count: -4 }, CONV);
    expect(deep.dispatched[2]?.thinkerCount).toBe(1);

    await tools.runDeepThink({ ...args, thinker_count: 3.7 }, CONV);
    expect(deep.dispatched[3]?.thinkerCount).toBe(3);

    // Models emit a count as a string often enough that refusing one is a bug.
    await tools.runDeepThink({ ...args, thinker_count: "5" }, CONV);
    expect(deep.dispatched[4]?.thinkerCount).toBe(5);
  });

  // Absent, not one: `DEEP_THINK_THINKERS` decides, and a handler that always
  // sends a number takes that setting away from whoever configured the server.
  it("leaves thinker_count unset when the model sends nothing usable", async () => {
    await tools.runDeepThink(args, CONV);
    expect(deep.dispatched[0]).not.toHaveProperty("thinkerCount");

    await tools.runDeepThink({ ...args, thinker_count: "muitos" }, CONV);
    expect(deep.dispatched[1]).not.toHaveProperty("thinkerCount");
  });

  it("refuses a missing scenario as a question, without dispatching", async () => {
    for (const bad of [{}, { scenario: "  " }, { scenario: ["a"] }]) {
      const outcome = await tools.runDeepThink(bad, CONV);
      expect(outcome.output).toMatch(/Preciso saber sobre o que pensar/);
    }
    expect(deep.dispatched).toEqual([]);
  });

  // Both refusals reach a live spoken turn, so neither may be a throw: the model
  // has to be able to tell the user what happened and keep the conversation.
  it("answers a 400 with the engine's own spoken sentence", async () => {
    deep.onDispatch = () => {
      throw new DeepThinkError("Preciso de um cenario para pensar a respeito.", 400);
    };

    const outcome = await tools.runDeepThink(args, CONV);

    expect(outcome.output).toBe("Preciso de um cenario para pensar a respeito.");
    expect(outcome.meta).toBeUndefined();
  });

  it("answers a 409 without reading a uuid out loud", async () => {
    const running = makeJob({ activity: "pensando em 4 frentes" });
    deep.jobs.push(running);
    deep.onDispatch = () => {
      throw new DeepThinkError(
        `Ja existe uma rodada de pensamento profundo nesta conversa (job ${running.id}). ` +
          "Espere ela terminar ou cancele antes de disparar outra.",
        409,
      );
    };

    const outcome = await tools.runDeepThink(args, CONV);

    expect(outcome.output).toMatch(/Ja tem uma rodada/);
    expect(outcome.output).not.toContain(running.id);
    expect(outcome.output).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
    // The id the browser needs is still there; it just is not spoken.
    expect(outcome.meta?.job_id).toBe(running.id);
  });

  it("answers an unexpected dispatch failure with a sentence", async () => {
    deep.onDispatch = () => {
      throw new TypeError("Cannot read properties of undefined");
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const outcome = await tools.runDeepThink(args, CONV);

    expect(outcome.output).not.toMatch(/Cannot read properties/);
    expect(outcome.output).toMatch(/Nao consegui disparar os pensadores/);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// check_deep_think
// ---------------------------------------------------------------------------

describe("checkDeepThink", () => {
  it("tells the model to keep talking while the round is still running", async () => {
    const job = makeJob({ activity: "pensando: riscos e modos de falha" });
    deep.jobs.push(job);

    const outcome = await tools.checkDeepThink({ job_id: job.id }, CONV);

    expect(outcome.output).toMatch(/pensando: riscos e modos de falha/);
    expect(outcome.output).toMatch(/Continue a conversa/i);
    expect(outcome.meta).toMatchObject({ job_id: job.id, status: "running" });
  });

  it("speaks the synthesis once the round is done", async () => {
    const job = makeJob({
      status: "done",
      activity: "concluido",
      synthesis: "Os pensadores concordaram que o risco maior e o prazo.",
      cost_usd: 0.42,
    });
    deep.jobs.push(job);

    const outcome = await tools.checkDeepThink({ job_id: job.id }, CONV);

    expect(outcome.output).toBe("Os pensadores concordaram que o risco maior e o prazo.");
    expect(outcome.meta).toMatchObject({ status: "done", cost_usd: 0.42 });
  });

  it("speaks the error when the round failed", async () => {
    const job = makeJob({
      status: "error",
      activity: "erro",
      error: "Nenhum pensador conseguiu concluir.",
    });
    deep.jobs.push(job);

    const outcome = await tools.checkDeepThink({ job_id: job.id }, CONV);

    expect(outcome.output).toBe("Nenhum pensador conseguiu concluir.");
    expect(outcome.meta).toMatchObject({ status: "error" });
  });

  // `deep-think.ts` stores `errText(err)` when a round dies, so whatever an
  // `OpenAIError` said ends up in `job.error` — English, and sometimes the
  // provider's JSON body. These two were observed running.
  describe("a failed round is reported in Portuguese, whatever it failed with", () => {
    const technical: Record<string, string> = {
      "a missing environment variable":
        "Nenhum pensador conseguiu concluir. OPENAI_API_KEY is not set on the server",
      "a provider error body":
        'OpenAI 429: {"error":{"message":"Rate limit reached for gpt-5.2-mini"}}',
      "a stack-shaped TypeError": "Cannot read properties of undefined (reading 'output')",
    };

    for (const [name, error] of Object.entries(technical)) {
      it(`does not read ${name} out loud`, async () => {
        const job = makeJob({ status: "error", activity: "erro", error });
        deep.jobs.push(job);
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        const outcome = await tools.checkDeepThink({ job_id: job.id }, CONV);

        expect(outcome.output).not.toContain(error);
        expect(outcome.output).toMatch(/falha aqui do lado/);
        // Not lost: the browser still gets the real message, and so does stderr.
        expect(outcome.meta).toMatchObject({ error });
        expect(warn.mock.calls.flat().join(" ")).toContain(error);
        warn.mockRestore();
      });
    }

    // The round's own Portuguese sentences are the common case and must survive
    // untouched, or the guard would replace every failure with one flat line.
    it("keeps the sentences the round wrote for a person", async () => {
      for (const error of [
        "Cancelado pelo usuario.",
        "A rodada passou de 120s e foi interrompida sem nenhum pensamento pronto.",
        "Nenhum pensador conseguiu concluir. O pensador terminou sem escrever nada.",
      ]) {
        const job = makeJob({ status: "error", activity: "erro", error });
        deep.jobs.push(job);

        const outcome = await tools.checkDeepThink({ job_id: job.id }, CONV);
        expect(outcome.output).toBe(error);
      }
    });
  });

  // Only one round runs per conversation, so a model asking "e o pensamento
  // profundo?" without having kept the id is the ordinary case.
  it("finds the round without being given an id", async () => {
    const older = makeJob({
      status: "done",
      started_at: "2026-08-08T10:00:00.000Z",
      synthesis: "antiga",
    });
    const newer = makeJob({
      status: "done",
      started_at: "2026-08-08T12:00:00.000Z",
      synthesis: "recente",
    });
    deep.jobs.push(older, newer);

    expect((await tools.checkDeepThink({}, CONV)).output).toBe("recente");
  });

  it("prefers the running round over a newer finished one", async () => {
    const running = makeJob({ status: "running", started_at: "2026-08-08T10:00:00.000Z" });
    const finished = makeJob({
      status: "done",
      started_at: "2026-08-08T12:00:00.000Z",
      synthesis: "ja acabou",
    });
    deep.jobs.push(finished, running);

    const outcome = await tools.checkDeepThink({}, CONV);

    expect(outcome.meta?.job_id).toBe(running.id);
  });

  it("says so when there is no round at all", async () => {
    const outcome = await tools.checkDeepThink({}, CONV);

    expect(outcome.output).toMatch(/Nao encontrei nenhuma rodada/);
    expect(outcome.meta).toBeUndefined();
  });

  it("treats an unknown or invalid job_id as no round", async () => {
    for (const bad of [{ job_id: randomUUID() }, { job_id: 17 }, { job_id: "" }]) {
      const outcome = await tools.checkDeepThink(bad, CONV);
      expect(outcome.output).toMatch(/Nao encontrei nenhuma rodada/);
    }
  });

  // The registry is process-wide and the id came from a language model, so
  // another conversation's round is not this conversation's to read out.
  it("refuses a job that belongs to another conversation", async () => {
    const foreign = makeJob({
      conversation_id: OTHER_CONV,
      status: "done",
      synthesis: "conclusao de outra conversa",
    });
    deep.jobs.push(foreign);

    const outcome = await tools.checkDeepThink({ job_id: foreign.id }, CONV);

    expect(outcome.output).toMatch(/Nao encontrei nenhuma rodada/);
    expect(outcome.output).not.toContain("outra conversa");
  });
});

// ---------------------------------------------------------------------------
// The rule the header states, asserted across every path
// ---------------------------------------------------------------------------

// A uuid in `output` is read out digit by digit, and the id was removed from one
// branch at a time until the most common one still had it. So the assertion is
// made once, over every branch of all three handlers, instead of per branch.
describe("no handler ever puts an id where the model will read it out", () => {
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

  it("keeps every branch of all three handlers free of uuids", async () => {
    const spoken: Array<{ branch: string; output: string }> = [];
    const say = async (branch: string, run: () => Promise<{ output: string }>) => {
      spoken.push({ branch, output: (await run()).output });
    };

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    // generate_diagram: caption, empty caption, refusal, timeout, crash, no args.
    await say("diagram ok", () => tools.runGenerateDiagram({ instructions: "x" }, CONV));
    drawing.onGenerate = async () => makeDiagram({ caption: "  " });
    await say("diagram no caption", () => tools.runGenerateDiagram({ instructions: "x" }, CONV));
    drawing.onGenerate = async () => {
      throw new MermaidError(`Falhou no diagrama ${randomUUID()}.`, ["x"]);
    };
    await say("diagram refused", () => tools.runGenerateDiagram({ instructions: "x" }, CONV));
    drawing.onGenerate = async () => {
      throw new TypeError(`quebrou em ${randomUUID()}`);
    };
    await say("diagram crashed", () => tools.runGenerateDiagram({ instructions: "x" }, CONV));
    drawing.onGenerate = null;
    await say("diagram no args", () => tools.runGenerateDiagram({}, CONV));

    // deep_think: dispatched, no scenario, 400, 409, crash.
    await say("deep_think ok", () => tools.runDeepThink({ scenario: "s" }, CONV));
    await say("deep_think no scenario", () => tools.runDeepThink({}, CONV));
    deep.onDispatch = () => {
      throw new DeepThinkError(`Recusado por causa de ${randomUUID()}.`, 400);
    };
    await say("deep_think 400", () => tools.runDeepThink({ scenario: "s" }, CONV));
    deep.onDispatch = () => {
      throw new DeepThinkError(`Ja existe uma rodada (job ${randomUUID()}).`, 409);
    };
    await say("deep_think 409", () => tools.runDeepThink({ scenario: "s" }, CONV));
    deep.onDispatch = () => {
      throw new TypeError(`quebrou em ${randomUUID()}`);
    };
    await say("deep_think crashed", () => tools.runDeepThink({ scenario: "s" }, CONV));
    deep.onDispatch = null;

    // check_deep_think: running, done, failed, empty, missing.
    deep.jobs.push(makeJob({ status: "running", activity: "pensando: riscos" }));
    await say("check running", () => tools.checkDeepThink({}, CONV));
    deep.jobs = [makeJob({ status: "done", synthesis: "A conclusao, em palavras." })];
    await say("check done", () => tools.checkDeepThink({}, CONV));
    deep.jobs = [makeJob({ status: "error", error: `Falhou: job ${randomUUID()} morreu` })];
    await say("check failed", () => tools.checkDeepThink({}, CONV));
    deep.jobs = [makeJob({ status: "done" })];
    await say("check empty", () => tools.checkDeepThink({}, CONV));
    deep.jobs = [];
    await say("check missing", () => tools.checkDeepThink({}, CONV));

    warn.mockRestore();
    error.mockRestore();

    expect(spoken).toHaveLength(15);
    expect(spoken.filter(({ output }) => UUID.test(output))).toEqual([]);
    // And nothing answered with an empty turn, which is its own kind of silence.
    expect(spoken.filter(({ output }) => output.trim().length === 0)).toEqual([]);
  });
});
