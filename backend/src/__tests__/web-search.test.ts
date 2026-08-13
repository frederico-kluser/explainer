import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { executeWebSearch } from "../tools/web-search.js";
import { webSearch, type WebSearchResult } from "../services/openai.js";
import { addCost } from "../services/costs.js";
import { WEB_SEARCH_CALL_USD, priceTextResponse } from "../services/pricing.js";

// web-search.ts promisifies execFile at module load and hardcodes the CLI name
// (no env override like agent-jobs' PI_BIN), so a subprocess fake cannot point
// at a script: the stub replaces execFile itself instead.
const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));

vi.mock("node:child_process", () => ({ execFile: execFileMock }));

vi.mock("../services/openai.js", () => ({ webSearch: vi.fn() }));
vi.mock("../services/costs.js", () => ({ addCost: vi.fn() }));

const mockWebSearch = vi.mocked(webSearch);

const CONV = "550e8400-e29b-41d4-a716-446655440000";

type SurfOutput = { stdout: string; stderr: string };
type ExecFileCallback = (err: Error | null, result?: SurfOutput) => void;

// promisify resolves the single value the callback receives, so the stub
// mirrors execFile's `{ stdout, stderr }` contract instead of its 3-arg
// callback signature.
function mockSurfOutput(stdout: string): void {
  execFileMock.mockImplementation(
    (_file: string, _args: string[], _options: object, callback: ExecFileCallback) => {
      callback(null, { stdout, stderr: "" });
    },
  );
}

function mockSurfError(err: Error): void {
  execFileMock.mockImplementation(
    (_file: string, _args: string[], _options: object, callback: ExecFileCallback) => {
      callback(err);
    },
  );
}

// File-wide mock reset: the beforeEach inside the surf-fallback describe below
// only covers that describe, so the describes added on top of it would read
// stale execFile/webSearch calls from earlier tests without this one.
beforeEach(() => {
  vi.clearAllMocks();
});

describe("executeWebSearch surf fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("invokes the CLI as `search <query> --max <n> --json`, with no `--` separator", async () => {
    // The exact array is load-bearing: the CLI rejects a `--` separator, so
    // reintroducing one must fail this test.
    mockWebSearch.mockRejectedValue(new Error("api down"));
    mockSurfOutput(JSON.stringify({ data: { results: [] } }));

    await executeWebSearch("pergunta", CONV, 3);
    await executeWebSearch("pergunta", CONV);

    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(execFileMock).toHaveBeenNthCalledWith(
      1,
      "surf-research-skill",
      ["search", "pergunta", "--max", "3", "--json"],
      expect.objectContaining({ timeout: 30_000 }),
      expect.any(Function),
    );
    expect(execFileMock).toHaveBeenNthCalledWith(
      2,
      "surf-research-skill",
      ["search", "pergunta", "--max", "5", "--json"],
      expect.objectContaining({ timeout: 30_000 }),
      expect.any(Function),
    );
  });

  it("formats the envelope's data.results into numbered hits", async () => {
    mockWebSearch.mockRejectedValue(new Error("api down"));
    mockSurfOutput(
      JSON.stringify({
        data: {
          query: "pergunta",
          results: [
            {
              title: "Titulo do artigo",
              url: "https://exemplo.com/artigo",
              content: "Trecho inicial do conteudo da pagina.",
            },
          ],
        },
      }),
    );

    const { text } = await executeWebSearch("pergunta", CONV);

    expect(text).toContain("[1] Titulo do artigo");
    expect(text).toContain("https://exemplo.com/artigo");
    expect(text).toContain("Trecho inicial do conteudo da pagina.");
  });

  it("tells the user the CLI is missing when spawn fails with ENOENT", async () => {
    mockWebSearch.mockRejectedValue(new Error("api down"));
    mockSurfError(
      Object.assign(new Error("spawn surf-research-skill ENOENT"), { code: "ENOENT" }),
    );

    const { text } = await executeWebSearch("pergunta", CONV);

    expect(text).toBe(
      "A busca na web esta indisponivel: nem a API da OpenAI respondeu, nem o CLI " +
        "surf-research-skill esta instalado. Responda com o que voce ja sabe e avise " +
        "que nao foi possivel consultar a internet.",
    );
  });

  it("reports the CLI failure message as `Busca na web falhou: <msg>`", async () => {
    mockWebSearch.mockRejectedValue(new Error("api down"));
    mockSurfError(new Error("boom"));

    const { text } = await executeWebSearch("pergunta", CONV);

    expect(text).toBe("Busca na web falhou: boom");
  });

  it("accepts the legacy envelope with results at the top level", async () => {
    mockWebSearch.mockRejectedValue(new Error("api down"));
    mockSurfOutput(
      JSON.stringify({
        results: [{ title: "Antigo", url: "https://a", content: "x" }],
      }),
    );

    const { text } = await executeWebSearch("pergunta", CONV);

    expect(text).toContain("[1] Antigo");
  });

  it("answers `Nenhum resultado encontrado.` when the envelope carries no results", async () => {
    mockWebSearch.mockRejectedValue(new Error("api down"));
    mockSurfOutput(JSON.stringify({ data: { results: [] } }));

    const { text } = await executeWebSearch("pergunta", CONV);

    expect(text).toBe("Nenhum resultado encontrado.");
  });
});

describe("executeWebSearch OpenAI path", () => {
  // gpt-5.2-mini is on the rate card, so the reported cost is a real number.
  function openAiAnswer(overrides: Partial<WebSearchResult> = {}): WebSearchResult {
    return {
      text: "O petroleo subiu.",
      citations: [{ title: "Exemplo", url: "https://exemplo.com" }],
      usage: { input_tokens: 10, output_tokens: 5 },
      model: "gpt-5.2-mini",
      search_calls: 1,
      ...overrides,
    };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes the conversation context into the OpenAI web search", async () => {
    mockWebSearch.mockResolvedValue(openAiAnswer());

    const { text } = await executeWebSearch(
      "pergunta",
      CONV,
      undefined,
      "Contexto da conversa: o usuario acabou de falar do preco.",
    );

    expect(text).toContain("O petroleo subiu.");
    expect(mockWebSearch).toHaveBeenCalledWith("pergunta", {
      context: "Contexto da conversa: o usuario acabou de falar do preco.",
    });
  });

  it("reports the OpenAI cost on the result, with the sources appended", async () => {
    mockWebSearch.mockResolvedValue(openAiAnswer());

    const { text, cost_usd } = await executeWebSearch("pergunta", CONV);

    // Flat fee of 1 search call plus the model's tokens on the rate card.
    expect(cost_usd).toBeGreaterThan(0);
    expect(text).toContain("O petroleo subiu.");
    expect(text).toContain("Fontes:\n[1] Exemplo — https://exemplo.com");
  });

  it("keeps the cost off the result when the fallback answered instead", async () => {
    mockWebSearch.mockRejectedValue(new Error("api down"));
    mockSurfOutput(JSON.stringify({ data: { results: [] } }));

    const { text, cost_usd } = await executeWebSearch("pergunta", CONV);

    expect(text).toBe("Nenhum resultado encontrado.");
    expect(cost_usd).toBeUndefined();
  });

  it("appends no source block when the answer carries no citations", async () => {
    mockWebSearch.mockResolvedValue(openAiAnswer({ citations: [] }));

    const { text } = await executeWebSearch("pergunta", CONV);

    expect(text).toBe("O petroleo subiu.");
    expect(text).not.toContain("Fontes:");
  });

  it("returns the text with at most 4 cited sources as `Fontes:`", async () => {
    const citations = Array.from({ length: 5 }, (_, i) => ({
      title: `Fonte ${i + 1}`,
      url: `https://fonte${i + 1}.ex`,
    }));
    mockWebSearch.mockResolvedValue({
      text: "Resposta curta.",
      citations,
      usage: { input_tokens: 1000, output_tokens: 500 },
      model: "gpt-5.2",
      search_calls: 0,
    });

    const { text } = await executeWebSearch("pergunta", CONV);

    expect(text).toBe(
      "Resposta curta.\n\nFontes:\n" +
        "[1] Fonte 1 — https://fonte1.ex\n" +
        "[2] Fonte 2 — https://fonte2.ex\n" +
        "[3] Fonte 3 — https://fonte3.ex\n" +
        "[4] Fonte 4 — https://fonte4.ex",
    );
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("books the search cost to the conversation as source web_search", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const query = "q".repeat(100);
    mockWebSearch.mockResolvedValue({
      text: "Resposta.",
      citations: [],
      usage: { input_tokens: 1000, output_tokens: 500 },
      model: "gpt-5.2",
      search_calls: 2,
    });

    await executeWebSearch(query, CONV);

    expect(addCost).toHaveBeenCalledTimes(1);
    expect(addCost).toHaveBeenCalledWith(CONV, {
      source: "web_search",
      usd: priceTextResponse("gpt-5.2", { input_tokens: 1000, output_tokens: 500 }) +
        2 * WEB_SEARCH_CALL_USD,
      detail: query.slice(0, 80),
      tokens: { input: 1000, output: 500 },
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns and falls back to surf when OpenAI returns no text", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockWebSearch.mockResolvedValue({
      text: "",
      citations: [],
      usage: { input_tokens: 1000, output_tokens: 500 },
      model: "gpt-5.2",
      search_calls: 0,
    });
    mockSurfOutput(
      JSON.stringify({
        data: { results: [{ title: "T", url: "https://t", content: "c" }] },
      }),
    );

    const { text } = await executeWebSearch("pergunta", CONV);

    expect(warn).toHaveBeenCalledWith(
      "[web_search] OpenAI returned no text; falling back to surf",
    );
    expect(text).toContain("[1] T");
  });

  it("warns with the failure reason before falling back when OpenAI throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockWebSearch.mockRejectedValue(new Error("rate limit"));
    mockSurfOutput(JSON.stringify({ data: { results: [] } }));

    await executeWebSearch("pergunta", CONV);

    expect(warn).toHaveBeenCalledWith(
      "[web_search] OpenAI web search failed, falling back to surf:",
      "rate limit",
    );
  });

  it("stringifies a non-Error rejection in the warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockWebSearch.mockImplementation(() => Promise.reject("quota exceeded"));
    mockSurfOutput(JSON.stringify({ data: { results: [] } }));

    await executeWebSearch("pergunta", CONV);

    expect(warn).toHaveBeenCalledWith(
      "[web_search] OpenAI web search failed, falling back to surf:",
      "quota exceeded",
    );
  });
});

describe("executeWebSearch query validation", () => {
  it("answers the empty-query message without calling OpenAI or the CLI", async () => {
    expect((await executeWebSearch("", CONV)).text).toBe(
      "Busca vazia: informe o que pesquisar.",
    );
    expect((await executeWebSearch("   ", CONV)).text).toBe(
      "Busca vazia: informe o que pesquisar.",
    );
    expect(mockWebSearch).not.toHaveBeenCalled();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("truncates a query longer than 400 chars before it reaches webSearch or the CLI", async () => {
    mockWebSearch.mockRejectedValue(new Error("api down"));
    mockSurfOutput(JSON.stringify({ data: { results: [] } }));

    await executeWebSearch("a".repeat(500), CONV);

    expect(mockWebSearch).toHaveBeenCalledWith("a".repeat(400), {
      context: undefined,
    });
    expect(execFileMock).toHaveBeenCalledWith(
      "surf-research-skill",
      ["search", "a".repeat(400), "--max", "5", "--json"],
      expect.anything(),
      expect.any(Function),
    );
  });
});

describe("executeWebSearch result limits", () => {
  it("clamps maxResults into 1..10 and defaults non-finite values to 5", async () => {
    mockWebSearch.mockRejectedValue(new Error("api down"));
    mockSurfOutput(JSON.stringify({ data: { results: [] } }));
    const cases: Array<[number | undefined, number]> = [
      [undefined, 5],
      [0, 1],
      [-3, 1],
      [11, 10],
      [3.7, 3],
      [NaN, 5],
      [Infinity, 5],
    ];

    for (const [input] of cases) {
      await executeWebSearch("pergunta", CONV, input);
    }

    cases.forEach(([, expected], i) => {
      expect(execFileMock.mock.calls[i]![1]).toEqual([
        "search",
        "pergunta",
        "--max",
        String(expected),
        "--json",
      ]);
    });
  });
});

describe("executeWebSearch surf fallback edges", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("warns with trimmed stderr but still formats the results", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockWebSearch.mockRejectedValue(new Error("api down"));
    execFileMock.mockImplementation(
      (_file: string, _args: string[], _options: object, callback: ExecFileCallback) => {
        callback(null, {
          stdout: JSON.stringify({
            data: { results: [{ title: "T", url: "https://t", content: "c" }] },
          }),
          stderr: "  debug noise\n",
        });
      },
    );

    const { text } = await executeWebSearch("pergunta", CONV);

    expect(warn).toHaveBeenCalledWith("surf-research-skill stderr:", "debug noise");
    expect(text).toContain("[1] T");
  });

  it("reports invalid JSON as `Busca na web falhou: <message>`", async () => {
    mockWebSearch.mockRejectedValue(new Error("api down"));
    mockSurfOutput("{ not json");

    const { text } = await executeWebSearch("pergunta", CONV);

    expect(text).toMatch(/^Busca na web falhou: /);
    expect(text.length).toBeGreaterThan("Busca na web falhou: ".length);
  });

  it("stringifies a non-Error CLI failure in the message", async () => {
    mockWebSearch.mockRejectedValue(new Error("api down"));
    execFileMock.mockImplementation(
      (_file: string, _args: string[], _options: object, callback: ExecFileCallback) => {
        callback("boom" as unknown as Error);
      },
    );

    const { text } = await executeWebSearch("pergunta", CONV);

    expect(text).toBe("Busca na web falhou: boom");
  });

  it("uses `Sem titulo` and an empty excerpt for a hit with only a url", async () => {
    mockWebSearch.mockRejectedValue(new Error("api down"));
    mockSurfOutput(JSON.stringify({ results: [{ url: "https://so-url" }] }));

    const { text } = await executeWebSearch("pergunta", CONV);

    expect(text).toContain("[1] Sem titulo");
    expect(text).toContain("https://so-url");
    expect(text).toMatch(/\[1\] Sem titulo\n {3}https:\/\/so-url\n {3}$/);
  });

  it("leaves the url line empty when the hit has no url", async () => {
    mockWebSearch.mockRejectedValue(new Error("api down"));
    mockSurfOutput(JSON.stringify({ results: [{ title: "Sem URL", content: "x" }] }));

    const { text } = await executeWebSearch("pergunta", CONV);

    expect(text).toContain("[1] Sem URL");
    expect(text).toMatch(/\[1\] Sem URL\n {3}\n {3}x$/);
  });

  it("accepts a data block without results falling back to the top-level list", async () => {
    mockWebSearch.mockRejectedValue(new Error("api down"));
    mockSurfOutput(
      JSON.stringify({
        data: { query: "pergunta" },
        results: [{ title: "Topo", url: "https://topo", content: "y" }],
      }),
    );

    const { text } = await executeWebSearch("pergunta", CONV);

    expect(text).toContain("[1] Topo");
  });

  it("falls back to snippet when content is absent", async () => {
    mockWebSearch.mockRejectedValue(new Error("api down"));
    mockSurfOutput(
      JSON.stringify({
        data: { results: [{ title: "T2", url: "https://y", snippet: "trecho" }] },
      }),
    );

    const { text } = await executeWebSearch("pergunta", CONV);

    expect(text).toContain("trecho");
  });

  it("answers `Nenhum resultado encontrado.` when results is not an array", async () => {
    mockWebSearch.mockRejectedValue(new Error("api down"));
    mockSurfOutput(JSON.stringify({ data: { results: "oops" } }));

    const { text } = await executeWebSearch("pergunta", CONV);

    expect(text).toBe("Nenhum resultado encontrado.");
  });

  it("answers `Nenhum resultado encontrado.` when no envelope carries results at all", async () => {
    mockWebSearch.mockRejectedValue(new Error("api down"));
    mockSurfOutput(JSON.stringify({ data: { query: "pergunta" } }));

    const { text } = await executeWebSearch("pergunta", CONV);

    expect(text).toBe("Nenhum resultado encontrado.");
  });

  it("truncates a hit's content at 600 chars", async () => {
    mockWebSearch.mockRejectedValue(new Error("api down"));
    mockSurfOutput(
      JSON.stringify({
        data: {
          results: [{ title: "T3", url: "https://z", content: "x".repeat(700) }],
        },
      }),
    );

    const { text } = await executeWebSearch("pergunta", CONV);

    expect(text).toContain("x".repeat(600));
    expect(text).not.toContain("x".repeat(601));
  });
});
