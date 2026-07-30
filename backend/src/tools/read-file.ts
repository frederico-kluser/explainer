import { readFile } from "node:fs/promises";
import { validateAttachmentPath } from "../middleware/sandbox.js";

export async function executeReadFile(
  filename: string,
  convId: string,
): Promise<string> {
  try {
    const filePath = validateAttachmentPath(convId, filename);
    const content = await readFile(filePath, "utf-8");

    // Truncate large files to ~8000 chars
    if (content.length > 8000) {
      return content.slice(0, 8000) + "\n\n... [truncated]";
    }
    return content;
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return `File not found: ${filename}`;
    }
    const message = error instanceof Error ? error.message : String(error);
    return `Read file failed: ${message}`;
  }
}
