import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { validateAttachmentPath } from "../middleware/sandbox.js";
import { resolveAttachmentName } from "./resolve-attachment.js";

const execFileAsync = promisify(execFile);

const MAX_OUTPUT_CHARS = 4000;

export async function executeSearchFiles(
  pattern: string,
  convId: string,
  path?: string,
): Promise<string> {
  const baseDir = validateAttachmentPath(convId);
  const searchDir = path
    ? validateAttachmentPath(convId, await resolveAttachmentName(path, convId))
    : baseDir;

  try {
    // `--` stops option parsing so a pattern starting with `-` is treated as a
    // pattern; `-I` keeps binary attachments out of the model's context.
    const args = ["-r", "-n", "-i", "-I", "--", pattern, searchDir];
    const { stdout } = await execFileAsync("grep", args, {
      timeout: 10000,
      maxBuffer: 512 * 1024, // 512KB
    });

    return formatMatches(stdout, baseDir);
  } catch (error: unknown) {
    const code = (error as { code?: number | string } | null)?.code;

    // grep exits 1 when there are no matches — that's normal, not an error.
    if (code === 1) return "No matches found.";
    // exit 2 / ENOENT: the attachment directory or file does not exist.
    if (code === 2 || code === "ENOENT") return "No files attached.";

    const message = error instanceof Error ? error.message : String(error);
    return `File search failed: ${message}`;
  }
}

/**
 * grep prints absolute paths; strip the sandbox prefix so the model sees plain
 * attachment names instead of the operator's home directory.
 */
function formatMatches(stdout: string, baseDir: string): string {
  if (!stdout.trim()) return "No matches found.";

  const relative = stdout.split("\n").map((line) => {
    if (line.startsWith(baseDir + "/")) return line.slice(baseDir.length + 1);
    if (line.startsWith(baseDir)) return line.slice(baseDir.length);
    return line;
  });

  const joined = relative.join("\n").trimEnd();
  return joined.length > MAX_OUTPUT_CHARS
    ? joined.slice(0, MAX_OUTPUT_CHARS) + "\n... [truncated]"
    : joined;
}
