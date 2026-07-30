import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Mirrors the limits advertised to the model in tools/index.ts.
const MAX_QUERY_LENGTH = 400;
const MIN_RESULTS = 1;
const MAX_RESULTS = 10;
const DEFAULT_RESULTS = 5;

function clampResults(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_RESULTS;
  return Math.min(MAX_RESULTS, Math.max(MIN_RESULTS, Math.trunc(value)));
}

export async function executeWebResearch(
  query: string,
  maxResults?: number,
): Promise<string> {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return "Web research failed: query is empty.";
  }

  // The model is told the cap but does not always respect it; enforce both
  // bounds here so nothing unbounded reaches the CLI.
  const safeQuery = trimmed.slice(0, MAX_QUERY_LENGTH);
  const args = [
    "search",
    safeQuery,
    "--max",
    String(clampResults(maxResults)),
    "--json",
  ];

  try {
    const { stdout, stderr } = await execFileAsync("surf-research-skill", args, {
      timeout: 30_000, // 30 second timeout
      maxBuffer: 1024 * 1024, // 1MB output
    });

    if (stderr) {
      console.warn("surf-research-skill stderr:", stderr.trim());
    }

    // Parse the JSON output
    const result = JSON.parse(stdout);

    // Format results as readable text for the LLM
    return formatResearchResults(result);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return (
        "Web research is unavailable: the `surf-research-skill` CLI is not " +
        "installed or not on PATH. Answer from what you already know, and say " +
        "that you could not search the web."
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    return `Web research failed: ${message}`;
  }
}

function isNodeError(err: unknown): err is Error & { code?: string } {
  return err instanceof Error && "code" in err;
}

function formatResearchResults(data: Record<string, unknown>): string {
  // Handle the surf-research-skill JSON envelope.
  // The exact format depends on the provider, but typically:
  // { data: { results: [{ title, url, content }] } }
  try {
    const dataObj = data?.data as Record<string, unknown> | undefined;
    const results =
      (dataObj?.results as unknown[]) ??
      (data?.results as unknown[]) ??
      [];

    if (!Array.isArray(results) || results.length === 0) {
      return "No results found.";
    }

    return results
      .map((r, i) => {
        const record = r as Record<string, unknown>;
        const title = String(record.title ?? "Untitled");
        const url = String(record.url ?? "");
        const content = String(record.content ?? record.snippet ?? "");
        return `[${i + 1}] ${title}\n   URL: ${url}\n   ${content}`;
      })
      .join("\n\n");
  } catch {
    return JSON.stringify(data, null, 2).slice(0, 4000);
  }
}
