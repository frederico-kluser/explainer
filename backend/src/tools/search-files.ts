import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { validateAttachmentPath } from "../middleware/sandbox.js";

const execFileAsync = promisify(execFile);

export async function executeSearchFiles(
  pattern: string,
  convId: string,
  path?: string,
): Promise<string> {
  const baseDir = validateAttachmentPath(convId);
  const searchDir = path ? validateAttachmentPath(convId, path) : baseDir;

  try {
    const args = ["-r", "-n", "-i", "--", pattern, searchDir];
    const { stdout } = await execFileAsync("grep", args, {
      timeout: 10000,
      maxBuffer: 512 * 1024, // 512KB
    });

    if (!stdout.trim()) return "No matches found.";

    // Truncate to ~4000 chars
    return stdout.slice(0, 4000);
  } catch (error: any) {
    // grep exits with code 1 when no matches — that's normal, not an error
    if (error?.code === 1) return "No matches found.";
    const message = error instanceof Error ? error.message : String(error);
    return `File search failed: ${message}`;
  }
}
