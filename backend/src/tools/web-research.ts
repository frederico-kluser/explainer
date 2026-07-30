import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function executeWebResearch(
  query: string,
  maxResults: number = 5,
): Promise<string> {
  const args = ["search", query, "--max", String(maxResults), "--json"];

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
    const message = error instanceof Error ? error.message : String(error);
    return `Web research failed: ${message}`;
  }
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
