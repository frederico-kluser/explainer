import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { webSearch } from "../services/openai.js";
import { addCost } from "../services/costs.js";
import { WEB_SEARCH_CALL_USD, priceTextResponse } from "../services/pricing.js";

const execFileAsync = promisify(execFile);

const MAX_QUERY_LENGTH = 400;
const DEFAULT_RESULTS = 5;
const MAX_RESULTS = 10;

/**
 * Answer a question from the live web.
 *
 * The Realtime API has no hosted search tool of its own — its only tool types
 * are `function` and `mcp` — so search happens here and is handed back as a
 * function result. First choice is OpenAI's Responses `web_search`, which
 * returns spoken-answer-shaped prose with citations. When that is unavailable
 * (no key, outage, rate limit) it falls back to `surf-research-skill`, the CLI
 * already installed on this machine, and formats the raw hits instead.
 */
export async function executeWebSearch(
  query: string,
  conversationId: string,
  maxResults?: number,
): Promise<string> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return "Busca vazia: informe o que pesquisar.";
  const safeQuery = trimmed.slice(0, MAX_QUERY_LENGTH);

  try {
    const { text, citations, usage, model, search_calls } = await webSearch(safeQuery);

    // Hosted search bills a flat fee per call on top of the model's tokens.
    void addCost(conversationId, {
      source: "web_search",
      usd: priceTextResponse(model, usage) + search_calls * WEB_SEARCH_CALL_USD,
      detail: safeQuery.slice(0, 80),
      tokens: { input: usage.input_tokens, output: usage.output_tokens },
    });

    if (text) {
      const sources = citations
        .slice(0, 4)
        .map((c, i) => `[${i + 1}] ${c.title} — ${c.url}`)
        .join("\n");
      return sources ? `${text}\n\nFontes:\n${sources}` : text;
    }
    // An empty answer is not an error, but the fallback may still find something.
    console.warn("[web_search] OpenAI returned no text; falling back to surf");
  } catch (err) {
    console.warn(
      "[web_search] OpenAI web search failed, falling back to surf:",
      err instanceof Error ? err.message : String(err),
    );
  }

  return surfFallback(safeQuery, maxResults);
}

async function surfFallback(
  query: string,
  maxResults?: number,
): Promise<string> {
  const count = clampResults(maxResults);
  const args = ["search", "--", query, "--max", String(count), "--json"];

  try {
    const { stdout, stderr } = await execFileAsync("surf-research-skill", args, {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    if (stderr) console.warn("surf-research-skill stderr:", stderr.trim());
    return formatSurfResults(JSON.parse(stdout) as Record<string, unknown>);
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") {
      return (
        "A busca na web esta indisponivel: nem a API da OpenAI respondeu, nem o " +
        "CLI surf-research-skill esta instalado. Responda com o que voce ja sabe " +
        "e avise que nao foi possivel consultar a internet."
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    return `Busca na web falhou: ${message}`;
  }
}

function clampResults(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_RESULTS;
  return Math.min(MAX_RESULTS, Math.max(1, Math.trunc(value)));
}

function isNodeError(err: unknown): err is Error & { code?: string } {
  return err instanceof Error && "code" in err;
}

function formatSurfResults(data: Record<string, unknown>): string {
  const dataObj = data?.data as Record<string, unknown> | undefined;
  const results =
    (dataObj?.results as unknown[]) ?? (data?.results as unknown[]) ?? [];

  if (!Array.isArray(results) || results.length === 0) {
    return "Nenhum resultado encontrado.";
  }

  return results
    .map((r, i) => {
      const record = r as Record<string, unknown>;
      const title = String(record.title ?? "Sem titulo");
      const url = String(record.url ?? "");
      const content = String(record.content ?? record.snippet ?? "").slice(0, 600);
      return `[${i + 1}] ${title}\n   ${url}\n   ${content}`;
    })
    .join("\n\n");
}
