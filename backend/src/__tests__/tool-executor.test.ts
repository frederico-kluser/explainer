import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ResolvedSource } from "../types/index.js";

// The store reads and writes conversation JSON on disk; the executor's job is
// routing, so the source is injected instead of persisted.
const currentSource = { value: null as ResolvedSource | null };

vi.mock("../services/source-store.js", async () => {
  // pickSource is pure resolution logic worth exercising for real; only the
  // storage half is stubbed.
  const actual = await vi.importActual<typeof import("../services/source-store.js")>(
    "../services/source-store.js",
  );
  return {
    ...actual,
    listSources: async () =>
      currentSource.value ? [currentSource.value] : [],
    addSource: async () => [],
    removeSource: async () => [],
    forgetSources: () => {},
  };
});

// The three deliberation bodies spend money and talk to two providers; what is
// under test here is the spine, so they are replaced by spies that record the
// arguments the switch forwarded.
vi.mock("../tools/deliberation-tools.js", () => ({
  runDeepThink: vi.fn(async () => ({
    output: "pensadores disparados",
    meta: { job_id: "job-1", status: "running", activity: "pensando", angles: ["a", "b"] },
  })),
  checkDeepThink: vi.fn(async () => ({
    output: "os pensadores ainda estao trabalhando",
    meta: { job_id: "job-1", status: "running" },
  })),
  runGenerateDiagram: vi.fn(async () => ({
    output: "Coloquei o diagrama na tela.",
    meta: { diagram: { id: "diag-1", kind: "flowchart" } },
  })),
}));

const { parseToolArguments, executeTool, ToolValidationError } = await import(
  "../services/tool-executor.js"
);
const { ALL_TOOLS, toolsForSources } = await import("../tools/index.js");
const { MERMAID_KINDS } = await import("../services/mermaid.js");
const { MAX_THINKERS } = await import("../types/deep-tools.js");
const deliberation = await import("../tools/deliberation-tools.js");

const CONV = "550e8400-e29b-41d4-a716-446655440000";

function markdownSource(): ResolvedSource {
  return {
    id: "mat-1",
    kind: "markdown",
    label: "Um documento",
    primary_doc: "# Um documento\n\nConteudo de teste.",
    resolved_at: new Date().toISOString(),
  };
}

function repoSource(): ResolvedSource {
  return { ...markdownSource(), id: "mat-2", kind: "repo", label: "Um repo", root: "/tmp" };
}

function names(tools: { name: string }[]): string[] {
  return tools.map((tool) => tool.name);
}

// The gate is read from the environment at call time, so the tests set it
// explicitly rather than inheriting whatever the developer has exported.
const REAL_BRAVE_KEY = process.env.BRAVE_API_KEY;

beforeEach(() => {
  currentSource.value = null;
  vi.clearAllMocks();
  process.env.BRAVE_API_KEY = "test-key";
});

afterEach(() => {
  if (REAL_BRAVE_KEY === undefined) delete process.env.BRAVE_API_KEY;
  else process.env.BRAVE_API_KEY = REAL_BRAVE_KEY;
});

describe("parseToolArguments", () => {
  it("parses valid JSON object", () => {
    expect(parseToolArguments('{"key": "value"}')).toEqual({ key: "value" });
  });

  it("returns empty object for empty and whitespace-only strings", () => {
    expect(parseToolArguments("")).toEqual({});
    expect(parseToolArguments("   ")).toEqual({});
  });

  it("throws ToolValidationError for invalid JSON", () => {
    expect(() => parseToolArguments("not json")).toThrow(ToolValidationError);
    expect(() => parseToolArguments("not json")).toThrow(/not valid JSON/);
  });

  it("throws ToolValidationError for arrays and null", () => {
    expect(() => parseToolArguments("[1, 2, 3]")).toThrow(/must be a JSON object/);
    expect(() => parseToolArguments("null")).toThrow(ToolValidationError);
  });
});

describe("executeTool", () => {
  it("tells the model to add a material when the conversation has none", async () => {
    const result = await executeTool("web_search", '{"query":"oi"}', CONV);
    expect(result.output).toMatch(/Nenhum material/i);
  });

  it("refuses a tool the current source does not grant", async () => {
    currentSource.value = markdownSource();

    // A free markdown document has no tree behind it, so grepping it is not on
    // the menu — and the model has to be told that in words it can act on.
    const result = await executeTool("search_source", '{"query":"foo"}', CONV);
    expect(result.output).toMatch(/nao esta disponivel/i);
    expect(result.output).toContain("web_search");
  });

  it("reads the anchor document of a markdown source", async () => {
    currentSource.value = markdownSource();

    const result = await executeTool("read_source_doc", "", CONV);
    expect(result.output).toContain("Conteudo de teste");
  });

  it("rejects arguments of the wrong shape", async () => {
    currentSource.value = markdownSource();

    await expect(executeTool("read_source_doc", "[]", CONV)).rejects.toThrow(
      ToolValidationError,
    );
  });

  it("throws for an unknown tool name", async () => {
    currentSource.value = { ...markdownSource(), kind: "repo", root: "/tmp" };

    // Unknown names are filtered by the per-source allowlist before they reach
    // the switch, so this surfaces as a refusal rather than a throw.
    const result = await executeTool("rm_rf", "{}", CONV);
    expect(result.output).toMatch(/nao esta disponivel/i);
  });
});

describe("the deliberation tools reach their handlers", () => {
  // Thinking and drawing do not read a repository, so the empty conversation is
  // the case that matters: the "add a material" early return used to answer for
  // every tool, and answering it here would be the model telling a user to add a
  // repository before it can draw a box.
  it("routes deep_think with no material in the conversation", async () => {
    const result = await executeTool("deep_think", '{"scenario":"migrar o banco"}', CONV);

    expect(result.output).toBe("pensadores disparados");
    expect(result.meta).toMatchObject({ job_id: "job-1", angles: ["a", "b"] });
    expect(deliberation.runDeepThink).toHaveBeenCalledWith(
      { scenario: "migrar o banco" },
      CONV,
    );
    expect(deliberation.checkDeepThink).not.toHaveBeenCalled();
    expect(deliberation.runGenerateDiagram).not.toHaveBeenCalled();
  });

  it("routes check_deep_think with no job_id and no material", async () => {
    const result = await executeTool("check_deep_think", "", CONV);

    expect(result.output).toMatch(/pensadores/i);
    expect(deliberation.checkDeepThink).toHaveBeenCalledWith({}, CONV);
    expect(deliberation.runDeepThink).not.toHaveBeenCalled();
  });

  it("routes generate_diagram with no material and forwards every argument", async () => {
    const result = await executeTool(
      "generate_diagram",
      '{"instructions":"tres caixas em fila","kind":"flowchart","title":"Fluxo"}',
      CONV,
    );

    expect(result.meta).toMatchObject({ diagram: { id: "diag-1" } });
    expect(deliberation.runGenerateDiagram).toHaveBeenCalledWith(
      { instructions: "tres caixas em fila", kind: "flowchart", title: "Fluxo" },
      CONV,
    );
  });

  it("still routes them when the conversation does have a material", async () => {
    currentSource.value = repoSource();

    await executeTool("generate_diagram", '{"instructions":"um fluxo"}', CONV);
    await executeTool("deep_think", '{"scenario":"vale a pena?"}', CONV);

    expect(deliberation.runGenerateDiagram).toHaveBeenCalledTimes(1);
    expect(deliberation.runDeepThink).toHaveBeenCalledTimes(1);
  });

  it("refuses deep_think without the Brave key instead of dispatching it", async () => {
    delete process.env.BRAVE_API_KEY;

    const result = await executeTool("deep_think", '{"scenario":"qualquer coisa"}', CONV);

    expect(result.output).toMatch(/nao esta disponivel/i);
    expect(deliberation.runDeepThink).not.toHaveBeenCalled();
  });

  it("leaves the material-first answer in place for the tools that need one", async () => {
    const result = await executeTool("web_search", '{"query":"oi"}', CONV);
    expect(result.output).toMatch(/Nenhum material/i);
  });
});

describe("toolsForSources publishes the deliberation tools", () => {
  it("hides deep_think when BRAVE_API_KEY is unset and shows it when set", () => {
    delete process.env.BRAVE_API_KEY;
    expect(names(toolsForSources([]))).not.toContain("deep_think");
    expect(names(toolsForSources([markdownSource()]))).not.toContain("deep_think");
    expect(names(toolsForSources([repoSource()]))).not.toContain("deep_think");

    process.env.BRAVE_API_KEY = "test-key";
    expect(names(toolsForSources([]))).toContain("deep_think");
    expect(names(toolsForSources([markdownSource()]))).toContain("deep_think");
    expect(names(toolsForSources([repoSource()]))).toContain("deep_think");
  });

  it("treats a blank BRAVE_API_KEY as no key, the way brave.ts does", () => {
    process.env.BRAVE_API_KEY = "   ";
    expect(names(toolsForSources([repoSource()]))).not.toContain("deep_think");
  });

  // Drawing needs neither a material nor a search key, and it is the only one of
  // the three that does not.
  it("offers generate_diagram in every conversation, with or without the key", () => {
    for (const key of ["test-key", undefined]) {
      if (key === undefined) delete process.env.BRAVE_API_KEY;
      else process.env.BRAVE_API_KEY = key;

      for (const sources of [[], [markdownSource()], [repoSource(), markdownSource()]]) {
        expect(names(toolsForSources(sources))).toContain("generate_diagram");
      }
    }
  });

  // check_deep_think can only ever report on a round that deep_think started —
  // nothing else in the codebase calls dispatchDeepThink. Published without its
  // partner it is a dead slot whose one answer tells the model out loud to fire
  // a round with a tool it does not have.
  it("gates check_deep_think together with deep_think, never one without the other", () => {
    const conversations = [
      [],
      [markdownSource()],
      [repoSource()],
      [repoSource(), markdownSource()],
    ];

    for (const sources of conversations) {
      process.env.BRAVE_API_KEY = "test-key";
      const withKey = names(toolsForSources(sources));
      expect(withKey).toContain("deep_think");
      expect(withKey).toContain("check_deep_think");

      delete process.env.BRAVE_API_KEY;
      const withoutKey = names(toolsForSources(sources));
      expect(withoutKey).not.toContain("deep_think");
      expect(withoutKey).not.toContain("check_deep_think");

      // A blank key is no key in brave.ts, so it has to be no key here too.
      process.env.BRAVE_API_KEY = "   ";
      const blankKey = names(toolsForSources(sources));
      expect(blankKey).not.toContain("deep_think");
      expect(blankKey).not.toContain("check_deep_think");
    }
  });

  it("refuses check_deep_think at call time when the key is gone", async () => {
    delete process.env.BRAVE_API_KEY;

    const result = await executeTool("check_deep_think", "", CONV);

    expect(result.output).toMatch(/nao esta disponivel/i);
    expect(deliberation.checkDeepThink).not.toHaveBeenCalled();
  });

  it("keeps ALL_TOOLS a superset of everything toolsForSources can offer", () => {
    // A tool offered to the model but missing from ALL_TOOLS is the orphan that
    // fails silently: nothing errors, it is simply never listed anywhere else.
    const offered = new Set(
      names([
        ...toolsForSources([]),
        ...toolsForSources([markdownSource()]),
        ...toolsForSources([repoSource(), markdownSource()]),
      ]),
    );
    for (const name of offered) expect(names(ALL_TOOLS)).toContain(name);
    expect(names(ALL_TOOLS)).toEqual(
      expect.arrayContaining(["deep_think", "check_deep_think", "generate_diagram"]),
    );
  });
});

describe("the published schemas", () => {
  function tool(name: string) {
    const found = ALL_TOOLS.find((candidate) => candidate.name === name);
    expect(found, `${name} is missing from ALL_TOOLS`).toBeDefined();
    return found!;
  }

  it("keeps every tool in the flat Realtime shape", () => {
    // The nested Chat Completions shape is accepted and gives the model zero
    // tools, with no error anywhere.
    for (const candidate of ALL_TOOLS) {
      expect(candidate.type).toBe("function");
      expect(candidate).not.toHaveProperty("function");
      expect(candidate.parameters.type).toBe("object");
    }
  });

  it("caps thinker_count at MAX_THINKERS and requires a scenario", () => {
    const deepThink = tool("deep_think");
    expect(deepThink.parameters.properties.thinker_count).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: MAX_THINKERS,
    });
    // The prose the model actually reads has to move with the constant too — a
    // schema capped at ten while the sentence still says eight is the drift the
    // literal used to hide.
    expect(deepThink.parameters.properties.thinker_count).toMatchObject({
      description: expect.stringContaining(`de 1 a ${MAX_THINKERS}`),
    });
    expect(deepThink.parameters.required).toEqual(["scenario"]);
    expect(deepThink.parameters.properties.reflection).toBeDefined();
  });

  it("leaves job_id optional on check_deep_think", () => {
    const check = tool("check_deep_think");
    expect(check.parameters.properties.job_id).toBeDefined();
    expect(check.parameters.required).toBeUndefined();
  });

  it("publishes MERMAID_KINDS as the enum of generate_diagram.kind", () => {
    const diagram = tool("generate_diagram");
    expect(diagram.parameters.properties.kind).toMatchObject({
      type: "string",
      enum: [...MERMAID_KINDS],
    });
    expect(diagram.parameters.required).toEqual(["instructions"]);
    expect(diagram.parameters.properties.title).toBeDefined();
  });
});
