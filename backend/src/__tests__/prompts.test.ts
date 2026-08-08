import { describe, it, expect, afterEach } from "vitest";

import { buildInstructions } from "../prompts.js";
import { ALL_TOOLS, toolsForSources } from "../tools/index.js";
import type { ResolvedSource } from "../types/index.js";
import type { MemoryResume } from "../types/deep-tools.js";

// `prompts.ts` touches neither the disk nor the network — it imports types and
// nothing else — so this file needs no temp HOME and no stubs.

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

function resume(overrides: Partial<MemoryResume> = {}): MemoryResume {
  return {
    conversation_id: "0f1e3d1a-2b3c-4d5e-8f90-0a1b2c3d4e5f",
    summary: "A pessoa queria entender como o sandbox contem os caminhos.",
    reflections: ["A contencao vale para tudo que o modelo escolhe."],
    tool_findings: ["read_source_doc: o README descreve a arquitetura realtime."],
    materials: ["explainer", "config da maquina"],
    event_count: 42,
    ...overrides,
  };
}

describe("buildInstructions", () => {
  it("says nothing about memory when the conversation is new", () => {
    const text = buildInstructions([source()]);

    expect(text).not.toContain("# Memoria desta conversa");
    // Both spellings of "no resume": explicit null and omitted.
    expect(buildInstructions([source()], null)).toBe(text);
  });

  it("carries the resume into its own section when there is one", () => {
    const text = buildInstructions([source()], resume());

    expect(text).toContain("# Memoria desta conversa");
    expect(text).toContain("A pessoa queria entender como o sandbox contem os caminhos.");
    expect(text).toContain("A contencao vale para tudo que o modelo escolhe.");
    expect(text).toContain("read_source_doc: o README descreve a arquitetura realtime.");
    expect(text).toContain("Eventos registrados ate aqui: 42.");
    expect(text).toContain("config da maquina");
  });

  it("cancels the opening of the Conversation Flow, and does it last", () => {
    const text = buildInstructions([source()], resume());

    // The instruction that tells the model not to introduce itself has to come
    // after the flow that tells it to, or the flow is the one that wins.
    expect(text.indexOf("# Memoria desta conversa")).toBeGreaterThan(
      text.indexOf("# Conversation Flow"),
    );
    expect(text).toContain("NAO se apresente de novo");
  });

  it("never carries the raw events — only what the resume compressed", () => {
    // `MemoryResume` has no `events` field, so the only way a transcript could
    // reach the instructions is through the summary. This is the regression
    // guard for someone widening the parameter to `MemoryFile` later: a turn
    // that is in the file but not in the resume must not appear.
    const secret = "ESTE-TURNO-CRU-NAO-PODE-ENTRAR";
    const text = buildInstructions([source()], resume());

    expect(text).not.toContain(secret);
    expect(text).not.toContain('"kind":');
    expect(text).not.toContain("tool_result");
  });

  it("holds the memory section inside its own budget", () => {
    const huge = "x".repeat(50_000);
    const text = buildInstructions(
      [source()],
      resume({
        summary: huge,
        reflections: Array.from({ length: 40 }, (_, i) => `reflexao ${i} ${huge}`),
        tool_findings: Array.from({ length: 40 }, (_, i) => `tool_${i}: ${huge}`),
        materials: Array.from({ length: 60 }, (_, i) => `material ${i} ${huge}`),
      }),
    );

    const section = text.slice(text.indexOf("# Memoria desta conversa"));
    expect(section.length).toBeLessThanOrEqual(6_000);
    // Truncated, not dropped: the section still exists and still says its piece.
    expect(section).toContain("## Resumo do que ja foi conversado");
  });

  it("keeps the most recent conclusions when they do not all fit", () => {
    const long = "c".repeat(400);
    const text = buildInstructions(
      [source()],
      resume({
        reflections: [
          `A PRIMEIRA ${long}`,
          `A DO MEIO ${long}`,
          `A MAIS RECENTE ${long}`,
        ],
      }),
    );

    // Newest first while the budget lasts: what a resumed conversation needs is
    // the last thing it concluded.
    expect(text).toContain("A MAIS RECENTE");
  });

  it("still resumes when the conversation has no materials left", () => {
    const text = buildInstructions([], resume());
    expect(text).toContain("# Memoria desta conversa");
  });
});

// The tools a repository conversation always gets, whatever the environment
// holds. Used as the base every case below adds to.
const BASE_TOOLS = [
  "read_source_doc",
  "search_source",
  "read_source_file",
  "list_source_files",
  "dispatch_pi_agent",
  "check_pi_agent",
  "web_search",
];

/**
 * `text.includes("deep_think")` is also true of `check_deep_think`, and the
 * whole point here is telling those two apart.
 */
function mentionsTool(text: string, name: string): boolean {
  return new RegExp(`(?<!\\w)${name}(?!\\w)`).test(text);
}

describe("the tool policy the session is given", () => {
  const braveKey = process.env.BRAVE_API_KEY;

  afterEach(() => {
    if (braveKey === undefined) delete process.env.BRAVE_API_KEY;
    else process.env.BRAVE_API_KEY = braveKey;
  });

  it("tells the model deep_think answers now and concludes later", () => {
    const text = buildInstructions([source()], null, [...BASE_TOOLS, "deep_think"]);

    expect(text).toContain("deep_think");
    expect(text).toContain("CONTINUE CONVERSANDO");
  });

  it("tells it to speak the caption of a diagram and never its syntax", () => {
    const text = buildInstructions([source()], null, [
      ...BASE_TOOLS,
      "generate_diagram",
    ]);

    expect(text).toContain("generate_diagram");
    expect(text).toContain("NUNCA leia a sintaxe do diagrama em voz alta");
  });

  it("tells it to check a round only when asked", () => {
    const text = buildInstructions([source()], null, [
      ...BASE_TOOLS,
      "check_deep_think",
    ]);

    expect(text).toContain("check_deep_think");
    expect(text).toContain("APENAS se a pessoa perguntar");
  });

  it("says nothing about a tool the session was not given", () => {
    const text = buildInstructions([source()], null, BASE_TOOLS);

    // The preamble is unconditional — it is about tool discipline, not about a
    // particular tool.
    expect(text).toContain("NAO mencione ferramentas que nao estao na sua lista");

    // Teaching the model to "avisar que colocou varios pensadores no assunto e
    // CONTINUAR CONVERSANDO" when no round can start is how a conversation ends
    // up waiting forever for a conclusion nobody is computing.
    for (const absent of ["deep_think", "check_deep_think", "generate_diagram"]) {
      expect(mentionsTool(text, absent), absent).toBe(false);
    }
  });

  it("describes nothing when the caller does not say what the session holds", () => {
    // An unknown list is not a licence to promise behaviour.
    const text = buildInstructions([source()]);

    expect(text).toContain("# Tools");
    for (const absent of ["deep_think", "check_deep_think", "generate_diagram"]) {
      expect(mentionsTool(text, absent), absent).toBe(false);
    }
  });

  it("never names a tool `toolsForSources` did not offer, with or without the Brave key", () => {
    // The gate this exists for: `deep_think` and `check_deep_think` come and go
    // with BRAVE_API_KEY, and the tool list is frozen into the client secret at
    // mint time. Driving the real `toolsForSources` — the same call the route
    // makes — is what keeps this true when that gate changes.
    for (const key of [undefined, "BSA-test-key"]) {
      if (key === undefined) delete process.env.BRAVE_API_KEY;
      else process.env.BRAVE_API_KEY = key;

      const sources = [source()];
      const offered = toolsForSources(sources).map((tool) => tool.name);
      const text = buildInstructions(sources, null, offered);

      for (const tool of ALL_TOOLS) {
        if (offered.includes(tool.name)) continue;
        expect(
          mentionsTool(text, tool.name),
          `${tool.name} named with BRAVE_API_KEY=${String(key)}`,
        ).toBe(false);
      }
    }
  });

  it("does not re-bill a paragraph about a tool the session lacks", () => {
    // Instructions are charged again on every single response, so an absent
    // tool's paragraph is not paid for once — it is paid for per turn.
    const withDeep = buildInstructions([source()], null, [
      ...BASE_TOOLS,
      "deep_think",
      "check_deep_think",
      "generate_diagram",
    ]);
    const withoutDeep = buildInstructions([source()], null, [
      ...BASE_TOOLS,
      "generate_diagram",
    ]);

    expect(withoutDeep.length).toBeLessThan(withDeep.length);
    expect(withoutDeep).not.toContain("varios pensadores");
  });
});
