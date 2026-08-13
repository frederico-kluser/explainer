import { describe, it, expect, vi, beforeEach } from "vitest";

import { executeWebSearch } from "../tools/web-search.js";
import { webSearch } from "../services/openai.js";

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

    const out = await executeWebSearch("pergunta", CONV);

    expect(out).toContain("[1] Titulo do artigo");
    expect(out).toContain("https://exemplo.com/artigo");
    expect(out).toContain("Trecho inicial do conteudo da pagina.");
  });

  it("tells the user the CLI is missing when spawn fails with ENOENT", async () => {
    mockWebSearch.mockRejectedValue(new Error("api down"));
    mockSurfError(
      Object.assign(new Error("spawn surf-research-skill ENOENT"), { code: "ENOENT" }),
    );

    const out = await executeWebSearch("pergunta", CONV);

    expect(out).toBe(
      "A busca na web esta indisponivel: nem a API da OpenAI respondeu, nem o CLI " +
        "surf-research-skill esta instalado. Responda com o que voce ja sabe e avise " +
        "que nao foi possivel consultar a internet.",
    );
  });

  it("reports the CLI failure message as `Busca na web falhou: <msg>`", async () => {
    mockWebSearch.mockRejectedValue(new Error("api down"));
    mockSurfError(new Error("boom"));

    const out = await executeWebSearch("pergunta", CONV);

    expect(out).toBe("Busca na web falhou: boom");
  });

  it("accepts the legacy envelope with results at the top level", async () => {
    mockWebSearch.mockRejectedValue(new Error("api down"));
    mockSurfOutput(
      JSON.stringify({
        results: [{ title: "Antigo", url: "https://a", content: "x" }],
      }),
    );

    const out = await executeWebSearch("pergunta", CONV);

    expect(out).toContain("[1] Antigo");
  });

  it("answers `Nenhum resultado encontrado.` when the envelope carries no results", async () => {
    mockWebSearch.mockRejectedValue(new Error("api down"));
    mockSurfOutput(JSON.stringify({ data: { results: [] } }));

    const out = await executeWebSearch("pergunta", CONV);

    expect(out).toBe("Nenhum resultado encontrado.");
  });
});
