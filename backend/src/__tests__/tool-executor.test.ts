import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { DispatchOptions } from "../services/agent-jobs.js";
import type { WebSearchJob } from "../types/deep-tools.js";
import type { Conversation, ResolvedSource } from "../types/index.js";

// The store reads and writes conversation JSON on disk; the executor's job is
// routing, so the source is injected instead of persisted.
const currentSource = { value: null as ResolvedSource | null };
// Same for the conversation: research-context reads it through storage, and a
// fixture keeps the routing tests off the real data directory.
const currentConversation = { value: null as Conversation | null };

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

// The conversation file is read by research-context.ts whenever a research tool
// fires; the fixture controls what the block carries.
vi.mock("../services/storage.js", async () => {
  const actual = await vi.importActual<typeof import("../services/storage.js")>(
    "../services/storage.js",
  );
  return {
    ...actual,
    getConversation: async () => currentConversation.value,
  };
});

// dispatch_pi_agent would spawn a real `pi` process; the job factory is a spy
// so the wiring under test is the context assembly, not the spawn.
vi.mock("../services/agent-jobs.js", async () => {
  const actual = await vi.importActual<typeof import("../services/agent-jobs.js")>(
    "../services/agent-jobs.js",
  );
  return {
    ...actual,
    dispatchAgentJob: vi.fn(
      (options: { conversationId: string; prompt: string; cwd: string }) => ({
        id: "job-1",
        conversation_id: options.conversationId,
        prompt: options.prompt,
        cwd: options.cwd,
        status: "running",
        activity: "iniciando o agente",
        started_at: new Date().toISOString(),
      }),
    ),
  };
});

// web_search would call the Responses API and, on failure, a CLI; the wiring
// under test is whether the executor hands it the conversation block, so the
// body is a spy that records the arguments.
vi.mock("../tools/web-search.js", () => ({
  executeWebSearch: vi.fn(async () => "resultado da busca"),
}));

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

// A real search hits the OpenAI API and the surf CLI; the registry reads are
// spies so check_web_search's four states are scriptable. dispatchWebSearch
// stays real on purpose: the web_search tests below pin the conversation block
// reaching executeWebSearch (mocked above), and that call happens inside the
// real dispatch path. listWebSearchJobs delegates to the real registry so the
// real dispatch (which reads it through a module-local binding the mock cannot
// reach) and the executor's own reads agree on the same jobs.
vi.mock("../services/web-search-jobs.js", async () => {
  const actual = await vi.importActual<typeof import("../services/web-search-jobs.js")>(
    "../services/web-search-jobs.js",
  );
  return {
    ...actual,
    getWebSearchJob: vi.fn(() => undefined),
    listWebSearchJobs: vi.fn((conversationId: string) =>
      actual.listWebSearchJobs(conversationId),
    ),
  };
});

const { parseToolArguments, executeTool, ToolValidationError } = await import(
  "../services/tool-executor.js"
);
const { ALL_TOOLS, toolsForSources } = await import("../tools/index.js");
const { MAX_CONTEXT_CHARS } = await import("../services/agent-jobs.js");
const agentJobs = await import("../services/agent-jobs.js");
const webSearchJobs = await import("../services/web-search-jobs.js");
const { MERMAID_KINDS } = await import("../services/mermaid.js");
const { MAX_THINKERS } = await import("../types/deep-tools.js");
const deliberation = await import("../tools/deliberation-tools.js");
const webSearchTool = await import("../tools/web-search.js");

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

function conversationWith(messages: Conversation["messages"]): Conversation {
  return {
    id: CONV,
    title: "Uma conversa",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    messages,
    attachments: [],
  };
}

function names(tools: { name: string }[]): string[] {
  return tools.map((tool) => tool.name);
}

// The gate is read from the environment at call time, so the tests set it
// explicitly rather than inheriting whatever the developer has exported.
const REAL_BRAVE_KEY = process.env.BRAVE_API_KEY;

beforeEach(() => {
  currentSource.value = null;
  currentConversation.value = null;
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
      expect.stringContaining("# Contexto da conversa"),
    );
    expect(deliberation.checkDeepThink).not.toHaveBeenCalled();
    expect(deliberation.runGenerateDiagram).not.toHaveBeenCalled();
  });

  it("hands the research handler the conversation block, materials included", async () => {
    currentSource.value = repoSource();
    currentConversation.value = conversationWith([
      {
        id: "m1",
        role: "user",
        content: "Preciso decidir sobre a migracao do banco.",
        timestamp: "2026-01-01T00:00:00.000Z",
      },
    ]);

    await executeTool("deep_think", '{"scenario":"migrar o banco"}', CONV);

    const block = vi.mocked(deliberation.runDeepThink).mock.calls[0]?.[2] ?? "";
    expect(block).toContain("1. Um repo (repo)");
    expect(block).toContain("Preciso decidir sobre a migracao do banco.");
    expect(block).toContain("usuario: Preciso decidir");
  });

  it("sends the conversation block and the model's own context to the pi agent", async () => {
    currentSource.value = repoSource();
    currentConversation.value = conversationWith([
      {
        id: "m1",
        role: "user",
        content: "O modulo de cobranca esta lento.",
        timestamp: "2026-01-01T00:00:00.000Z",
      },
    ]);

    const result = await executeTool(
      "dispatch_pi_agent",
      '{"question":"onde esta o gargalo?","context":"o usuario suspeita do cache"}',
      CONV,
    );

    expect(result.meta).toMatchObject({ job_id: "job-1" });
    expect(agentJobs.dispatchAgentJob).toHaveBeenCalledTimes(1);
    const options: Partial<DispatchOptions> =
      vi.mocked(agentJobs.dispatchAgentJob).mock.calls[0]?.[0] ?? {};
    expect(options.prompt).toBe("onde esta o gargalo?");
    // The server's block first, the model's nuance after, in one context field.
    expect(options.context).toContain("O modulo de cobranca esta lento.");
    expect(options.context).toContain("o usuario suspeita do cache");
    expect(options.context!.indexOf("O modulo de cobranca")).toBeLessThan(
      options.context!.indexOf("o usuario suspeita"),
    );
  });

  it("caps the combined pi context at MAX_CONTEXT_CHARS", async () => {
    currentSource.value = repoSource();
    currentConversation.value = conversationWith([]);

    const huge = "n".repeat(20_000);
    await executeTool(
      "dispatch_pi_agent",
      JSON.stringify({ question: "onde esta?", context: huge }),
      CONV,
    );

    const options: Partial<DispatchOptions> =
      vi.mocked(agentJobs.dispatchAgentJob).mock.calls[0]?.[0] ?? {};
    expect(options.context!.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS);
    // The conversation block survives the cap: the model's context must not
    // crowd the automatic block out of the prompt.
    expect(options.context).toContain("# Contexto da conversa");
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

describe("the async web search", () => {
  function runningSearch(overrides: Partial<WebSearchJob> = {}): WebSearchJob {
    return {
      id: "search-1",
      conversation_id: CONV,
      query: "preco do petroleo",
      status: "running",
      activity: "buscando na web",
      started_at: new Date().toISOString(),
      ...overrides,
    };
  }

  it("dispatches the search and answers immediately", async () => {
    currentSource.value = markdownSource();
    currentConversation.value = conversationWith([
      {
        id: "m1",
        role: "user",
        content: "Quero saber o preco do petroleo.",
        timestamp: "2026-01-01T00:00:00.000Z",
      },
    ]);

    const result = await executeTool("web_search", '{"query":"preco do petroleo"}', CONV);

    // The whole point: a voice turn is not blocked on the search. The dispatch
    // is real, so the job id is a live uuid — the shape is what matters here,
    // and the conversation block is pinned on executeWebSearch in the test
    // right after, the deepest hop of the same call.
    expect(result.meta).toMatchObject({ job_id: expect.any(String), status: "running" });
    expect(result.output).toMatch(/Busca disparada/);
    expect(result.output).not.toContain(String(result.meta?.job_id ?? ""));
  });

  it("hands the conversation block to the web search", async () => {
    currentSource.value = repoSource();
    currentConversation.value = conversationWith([
      {
        id: "m1",
        role: "user",
        content: "O preco do plano subiu.",
        timestamp: "2026-01-01T00:00:00.000Z",
      },
    ]);

    const result = await executeTool("web_search", '{"query":"preco atual do plano"}', CONV);

    // The block rides as the search's 4th argument — pinned by presence: if
    // the context stops being forwarded, this call fails on arity or content.
    expect(result.output).toMatch(/Busca disparada/);
    expect(webSearchTool.executeWebSearch).toHaveBeenCalledTimes(1);
    expect(webSearchTool.executeWebSearch).toHaveBeenCalledWith(
      "preco atual do plano",
      CONV,
      undefined,
      expect.stringContaining("# Contexto da conversa"),
    );
    const block = vi.mocked(webSearchTool.executeWebSearch).mock.calls[0]?.[3] ?? "";
    expect(block).toContain("O preco do plano subiu.");
  });

  it("answers the 409 with a spoken sentence, keeping the id out of it", async () => {
    currentSource.value = markdownSource();
    // A search that never answers keeps its job "running" in the real
    // registry, so the second dispatch trips the real 409 check.
    vi.mocked(webSearchTool.executeWebSearch).mockImplementationOnce(
      () => new Promise<never>(() => undefined),
    );
    const first = await executeTool("web_search", '{"query":"primeira"}', CONV);
    const runningId = String(first.meta?.job_id ?? "");

    try {
      const result = await executeTool("web_search", '{"query":"outra"}', CONV);

      expect(result.output).toMatch(/Ja tem uma busca em andamento/);
      // Spoken, the uuid would be read out digit by digit; it belongs in meta.
      expect(result.output).not.toContain(runningId);
      expect(result.meta).toMatchObject({ job_id: runningId, status: "running" });
    } finally {
      // Tear the hanging job off its budget timer so the suite is not held open.
      webSearchJobs.cancelWebSearch(runningId);
    }
  });

  it("reports a running search through check_web_search", async () => {
    currentSource.value = markdownSource();
    vi.mocked(webSearchJobs.getWebSearchJob).mockReturnValue(runningSearch());

    const result = await executeTool("check_web_search", '{"job_id":"search-1"}', CONV);

    expect(result.output).toMatch(/ainda esta em andamento/);
    expect(result.meta).toMatchObject({ job_id: "search-1", status: "running" });
    expect(webSearchJobs.getWebSearchJob).toHaveBeenCalledWith("search-1");
  });

  it("hands a finished search's result through check_web_search", async () => {
    currentSource.value = markdownSource();
    vi.mocked(webSearchJobs.getWebSearchJob).mockReturnValue(
      runningSearch({
        status: "done",
        activity: "concluido",
        result: "O petroleo subiu. Fontes:\n[1] Exemplo",
        cost_usd: 0.01,
      }),
    );

    const result = await executeTool("check_web_search", '{"job_id":"search-1"}', CONV);

    expect(result.output).toContain("O petroleo subiu.");
    expect(result.meta).toMatchObject({ job_id: "search-1", status: "done" });
  });

  it("reports a failed search's error through check_web_search", async () => {
    currentSource.value = markdownSource();
    vi.mocked(webSearchJobs.getWebSearchJob).mockReturnValue(
      runningSearch({ status: "error", activity: "", error: "A busca falhou: boom" }),
    );

    const result = await executeTool("check_web_search", '{"job_id":"search-1"}', CONV);

    expect(result.output).toBe("A busca falhou: boom");
    expect(result.meta).toMatchObject({ job_id: "search-1", status: "error" });
  });

  it("answers the missing id from check_web_search in words the model can say", async () => {
    currentSource.value = markdownSource();
    // A previous test's mockReturnValue would otherwise answer for this one.
    vi.mocked(webSearchJobs.getWebSearchJob).mockReset();

    const result = await executeTool("check_web_search", '{"job_id":"search-x"}', CONV);

    expect(result.output).toBe("Nenhuma busca com esse identificador.");
    expect(result.meta).toBeUndefined();
  });
});

describe("the research tools and the conversation block", () => {
  it("sends only the automatic block when the model gives no context of its own", async () => {
    currentSource.value = repoSource();
    currentConversation.value = conversationWith([
      {
        id: "m1",
        role: "user",
        content: "O modulo de cobranca esta lento.",
        timestamp: "2026-01-01T00:00:00.000Z",
      },
    ]);

    await executeTool("dispatch_pi_agent", '{"question":"onde esta o gargalo?"}', CONV);

    const options: Partial<DispatchOptions> =
      vi.mocked(agentJobs.dispatchAgentJob).mock.calls[0]?.[0] ?? {};
    expect(options.context).toContain("# Contexto da conversa");
    expect(options.context).toContain("O modulo de cobranca esta lento.");
    // Nothing was appended after the block — the block itself is the context.
    expect(options.context!.indexOf("# Contexto da conversa")).toBe(0);
  });

  it("slices the combined pi context at exactly MAX_CONTEXT_CHARS", async () => {
    currentSource.value = repoSource();
    currentConversation.value = conversationWith([]);

    const huge = "n".repeat(20_000);
    await executeTool(
      "dispatch_pi_agent",
      JSON.stringify({ question: "onde esta?", context: huge }),
      CONV,
    );

    const options: Partial<DispatchOptions> =
      vi.mocked(agentJobs.dispatchAgentJob).mock.calls[0]?.[0] ?? {};
    // The join of block + model context is sliced at the cap with no slack, and
    // the block survives the cut — the model's own words are what gives way.
    expect(options.context!.length).toBe(MAX_CONTEXT_CHARS);
    expect(options.context).toContain("# Contexto da conversa");
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
      expect.arrayContaining([
        "deep_think",
        "check_deep_think",
        "generate_diagram",
        "web_search",
        "check_web_search",
      ]),
    );
  });

  // check_web_search can only report on a search that web_search started, so
  // the two must always be offered together — a check with no way to dispatch
  // is a dead slot whose answer would tell the model to reach for a tool it
  // does not have.
  it("offers check_web_search wherever web_search is offered", () => {
    const conversations = [
      [],
      [markdownSource()],
      [repoSource()],
      [repoSource(), markdownSource()],
    ];

    for (const sources of conversations) {
      const published = names(toolsForSources(sources));
      expect(published).toContain("web_search");
      expect(published).toContain("check_web_search");
    }
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

  // Unlike check_deep_think, a web search has no "latest one" fallback — the
  // model is told to keep the id, so the schema demands it.
  it("requires job_id on check_web_search", () => {
    const check = tool("check_web_search");
    expect(check.parameters.properties.job_id).toBeDefined();
    expect(check.parameters.required).toEqual(["job_id"]);
  });

  it("promises automatic conversation context on dispatch_pi_agent, nothing more", () => {
    const agent = tool("dispatch_pi_agent");
    const description =
      (agent.parameters.properties.context as { description?: string } | undefined)
        ?.description ?? "";
    // The server attaches the conversation by itself, so the field is for what
    // is not in it — and the promise must not outgrow the wiring.
    expect(description).toContain("anexa automaticamente");
    expect(description).toContain("NAO estao na conversa");
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
