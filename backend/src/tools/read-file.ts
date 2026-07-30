import { readFile } from "node:fs/promises";
import { validateAttachmentPath } from "../middleware/sandbox.js";
import { resolveAttachmentName } from "./resolve-attachment.js";

export async function executeReadFile(
  filename: string,
  convId: string,
): Promise<string> {
  try {
    // The model sees original names in list_attachments but files are stored
    // under a UUID — accept either spelling.
    const storedName = await resolveAttachmentName(filename, convId);
    const filePath = validateAttachmentPath(convId, storedName);
    const content = await readFile(filePath, "utf-8");

    // Truncate large files to ~8000 chars
    if (content.length > 8000) {
      return content.slice(0, 8000) + "\n\n... [truncated]";
    }
    return content;
  } catch (error: unknown) {
    if ((error as { code?: string } | null)?.code === "ENOENT") {
      return `File not found: ${filename}`;
    }
    const message = error instanceof Error ? error.message : String(error);
    return `Read file failed: ${message}`;
  }
}
