import { describe, it, expect, afterEach } from "vitest";

import { MODES, DEFAULT_MODE_ID, getMode, isModeId, listModes } from "../modes/registry.js";
import { toModeSummary } from "../modes/types.js";
import { buildInstructions, greetingFor } from "../prompts.js";
import { ALL_TOOLS, toolsForSources } from "../tools/index.js";
import type { ResolvedSource } from "../types/index.js";

// Nothing in here touches the disk or the network: a mode is a description, and
// `prompts.ts` and `tools/index.ts` only read it.

function source(overrides: Partial<ResolvedSource> = {}): ResolvedSource {
  return {
    id: "src-1",
    kind: "repo",
    label: "explainer",
    root: "/srv/explainer",
    origin: "/srv/explainer",
    resolved_at: new Date().toISOString(),
    ...overrides,
  };
}

const names = (tools: { name: string }[]) => tools.map((tool) => tool.name);

describe("the mode registry", () => {
  it("registers every mode under its own id", () => {
    // The registry key is what `metadata.mode` stores and what `GET /api/modes`
    // sends; an entry whose `id` disagreed with its key would round-trip into a
    // different mode than the one that was picked.
    for (const [key, mode] of Object.entries(MODES)) {
      expect(mode.id).toBe(key);
    }
  });

  it("falls back to the default for anything it does not know", () => {
    // Every conversation created before modes existed reaches here, and so does
    // a client that sends a typo. Both have to keep working.
    for (const value of [undefined, null, "", "nope", 7, {}, []]) {
      expect(getMode(value).id).toBe(DEFAULT_MODE_ID);
    }
    expect(isModeId("presentation")).toBe(true);
    expect(isModeId("nope")).toBe(false);
  });

  it("carries the old behaviour in the default", () => {
    // The default is not a neutral empty mode: it is the one that behaves the
    // way the app did before this feature, because every existing conversation
    // is about to be read through it.
    const fallback = getMode(undefined);
    expect(fallback.requiresMaterial).toBe(true);
    expect(fallback.role).toContain("Explainer");
  });

  it("serialises only what the browser needs", () => {
    for (const mode of listModes()) {
      const summary = toModeSummary(mode);
      expect(summary).toEqual({
        id: mode.id,
        label: mode.label,
        description: mode.description,
        icon: mode.icon,
        requires_material: mode.requiresMaterial,
        document: mode.document
          ? {
              title: mode.document.title,
              placeholder: mode.document.placeholder,
              open_by_default: mode.document.openByDefault,
              format: mode.document.format,
            }
          : null,
      });
      // The template is the one field deliberately withheld: it is written to
      // disk when the conversation is created, and shipping it to the browser
      // as well would be a second copy that can disagree with the first.
      expect(JSON.stringify(summary)).not.toContain("template");
    }
  });

  it("names only tools that exist", () => {
    const defined = new Set(ALL_TOOLS.map((tool) => tool.name));
    for (const mode of listModes()) {
      for (const name of mode.toolNames) {
        expect(defined.has(name), `${mode.id} asks for ${name}`).toBe(true);
      }
    }
  });
});

describe("the tools a mode adds", () => {
  const braveKey = process.env.BRAVE_API_KEY;

  afterEach(() => {
    if (braveKey === undefined) delete process.env.BRAVE_API_KEY;
    else process.env.BRAVE_API_KEY = braveKey;
  });

  it("hands the document tools to both modes, with or without a material", () => {
    for (const mode of listModes()) {
      for (const sources of [[], [source()], [source({ kind: "markdown", root: undefined })]]) {
        const offered = names(toolsForSources(sources, mode));
        for (const name of mode.toolNames) {
          expect(offered, `${mode.id} / ${sources.length} materiais`).toContain(name);
        }
      }
    }
  });

  it("keeps the material toolkit exactly as it was", () => {
    // A mode may add; it may not take away. The repository toolkit is what the
    // rest of the app is built on.
    const withMode = names(toolsForSources([source()], getMode("presentation")));
    for (const name of [
      "read_source_doc",
      "search_source",
      "read_source_file",
      "list_source_files",
      "dispatch_pi_agent",
      "check_pi_agent",
      "web_search",
    ]) {
      expect(withMode).toContain(name);
    }
  });

  it("produces the same list twice for the same conversation", () => {
    // The session config is cached upstream by content, so a tool list whose
    // order moved between two mints of the same conversation would be billed as
    // a different session every time.
    const mode = getMode("presentation");
    expect(names(toolsForSources([source()], mode))).toEqual(
      names(toolsForSources([source()], mode)),
    );
  });
});

describe("the instructions a mode builds", () => {
  const documentTools = [
    "read_document",
    "write_document",
    "append_document",
    "edit_document_section",
  ];

  it("replaces the role and the flow rather than adding to them", () => {
    const presentation = buildInstructions([], null, [], getMode("presentation"));
    const conversation = buildInstructions([], null, [], getMode("conversation"));

    expect(presentation).toContain("diretor de apresentacoes");
    expect(presentation).not.toContain("tirar TODAS as duvidas dela");
    expect(conversation).toContain("tirar TODAS as duvidas dela");
    expect(conversation).not.toContain("diretor de apresentacoes");

    // Exactly one Role and one Flow, whichever mode is in play.
    for (const text of [presentation, conversation]) {
      expect(text.match(/# Role & Objective/g)).toHaveLength(1);
      expect(text.match(/# Conversation Flow/g)).toHaveLength(1);
    }
  });

  it("keeps the shared sections out of a mode's reach", () => {
    // Speech format, language and the unclear-audio rule are what make this the
    // same application in every mode. A mode that dropped them would be a
    // different product wearing the same UI.
    for (const mode of listModes()) {
      const text = buildInstructions([source()], null, [], mode);
      expect(text).toContain("# Output Format");
      expect(text).toContain("A conversa e SEMPRE em portugues do Brasil");
      expect(text).toContain("## Unclear audio");
    }
  });

  it("carries the craft into the presentation session", () => {
    const text = buildInstructions([], null, documentTools, getMode("presentation"));

    // The four things the mode exists to know.
    expect(text).toContain("Postura — voce discorda quando precisa");
    expect(text).toContain("### Slide N —");
    expect(text).toContain("DEMO:");
    expect(text).toContain("palavras por minuto");
    // And the myths it must not repeat.
    expect(text).toContain("7x7");
    expect(text).toContain("Mehrabian");
  });

  it("does not tell a material-free mode to go and find a material", () => {
    const presentation = buildInstructions([], null, [], getMode("presentation"));
    const conversation = buildInstructions([], null, [], getMode("conversation"));

    expect(conversation).toContain("Nenhum material foi adicionado ainda");
    expect(presentation).not.toContain("Nenhum material foi adicionado ainda");
    expect(presentation).toContain("nao precisa ter");
  });

  it("names a document tool only when the session holds it", () => {
    // The tool preamble forbids naming a tool the model was not given, and the
    // list is frozen into the client secret at mint time. A section that named
    // three of them regardless would contradict the preamble on every turn.
    for (const mode of listModes()) {
      const without = buildInstructions([source()], null, ["web_search"], mode);
      for (const name of documentTools) {
        expect(without, `${mode.id} / ${name}`).not.toContain(name);
      }

      const with_ = buildInstructions([source()], null, documentTools, mode);
      expect(with_).toContain("edit_document_section");
    }
  });

  it("keeps the two epistemic layers apart when it speaks", () => {
    // The strongest numbers available for slide design come from two studies
    // co-authored by the method's own inventor, and the popular timing rules
    // have nothing behind them at all. Without this section the model quotes
    // both as settled science the first time somebody argues back.
    const text = buildInstructions([], null, documentTools, getMode("presentation"));

    expect(text).toContain("Como voce cita o que sabe");
    expect(text).toContain("NUNCA invente numero de estudo");
    // The two places the file admits the evidence is weaker than the folklore.
    expect(text).toContain("mais fraca do que a cultura de apresentacao supoe");
    expect(text).toContain("CONVENCOES E FORMATOS, nao resultados de pesquisa");
  });

  it("holds the craft inside a budget somebody chose", () => {
    // These instructions are re-billed on every single response of the call, so
    // the mode that carries a knowledge base is the most expensive string in
    // the app. The ceiling is not a style rule: doubling it doubles the floor
    // cost of every turn.
    const text = buildInstructions([source()], null, documentTools, getMode("presentation"));
    expect(text.length).toBeLessThan(26_000);

    // And the mode that carries none stays cheap.
    const plain = buildInstructions([source()], null, documentTools, getMode("conversation"));
    expect(plain.length).toBeLessThan(8_000);
  });

  it("holds the research instructions inside the same budget", () => {
    // Research carries no knowledge base: its sections state the protocol and
    // the document rules, never the shell — the template is not re-billed on
    // every response.
    const research = buildInstructions(
      [source()],
      null,
      [...documentTools, "web_search", "check_web_search"],
      getMode("research"),
    );
    expect(research.length).toBeLessThan(26_000);
  });

  it("ships an html-explainer shell as the research document", () => {
    const mode = getMode("research");
    const template = mode.document!.template;

    // The shell is a byte-for-byte contract: dark theme, the ARIA tab
    // structure and the runtime the model must preserve on every rewrite.
    expect(mode.document?.format).toBe("html");
    expect(template).toContain('data-bs-theme="dark"');
    expect(template).toContain('role="tablist"');
    expect(template).toContain('role="tab"');
    // The five fixed tabs, each with its button.id <-> pane.aria-labelledby
    // pair, so a deep link and a screen reader always land on the same pane.
    for (const [tab, pane] of [
      ["Resumo", "pane-resumo"],
      ["Pontos levantados", "pane-pontos"],
      ["Duvidas", "pane-duvidas"],
      ["Respostas e fontes", "pane-respostas"],
      ["Rodadas", "pane-rodadas"],
    ] as const) {
      expect(template).toContain(tab);
      expect(template).toContain(`aria-controls="${pane}"`);
      expect(template).toContain(`aria-labelledby="tab-${pane.slice(5)}"`);
    }
    // The runtime: hash deep-link and the copy button.
    expect(template).toContain("activateFromHash");
    expect(template).toContain("copy-btn");
    // And the whole shell fits a document that is rewritten on every round.
    expect(template.length).toBeLessThan(30_000);
  });

  it("lets a mode own the greeting, and leaves the others alone", () => {
    expect(greetingFor([], getMode("presentation"))).toContain("plateia");
    expect(greetingFor([], getMode("conversation"))).toBe(
      "Adicione um material para comecar.",
    );
    expect(greetingFor([source()], getMode("conversation"))).toContain("explainer");
  });
});
