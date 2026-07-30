import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { validateAttachmentPath } from "../middleware/sandbox.js";
import { getConversation } from "../services/storage.js";

export async function executeListAttachments(convId: string): Promise<string> {
  try {
    // First try getting metadata from the conversation JSON
    const conv = await getConversation(convId);
    if (conv?.attachments && conv.attachments.length > 0) {
      return conv.attachments
        .map(
          (a, i) =>
            `[${i + 1}] ${a.original_name} (${a.filename}) — ${formatBytes(a.size_bytes)}`,
        )
        .join("\n");
    }

    // Fallback: list the directory
    const dir = validateAttachmentPath(convId);
    const entries = await readdir(dir, { withFileTypes: true });
    const files = entries.filter((e) => e.isFile());

    if (files.length === 0) return "No files attached.";

    const result = await Promise.all(
      files.map(async (f, i) => {
        const fstat = await stat(join(dir, f.name));
        return `[${i + 1}] ${f.name} — ${formatBytes(fstat.size)}`;
      }),
    );

    return result.join("\n");
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return "No files attached.";
    }
    const message = error instanceof Error ? error.message : String(error);
    return `List attachments failed: ${message}`;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
