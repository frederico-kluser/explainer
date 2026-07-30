import { readFile, writeFile } from "node:fs/promises";
import { validateConversationPath, ensureDir } from "./middleware/sandbox.js";
import type { Conversation } from "./types/index.js";

/**
 * Load a conversation from its JSON file on disk.
 * Returns `null` when the file does not exist (conversation not found).
 */
export async function getConversation(
  convId: string,
): Promise<Conversation | null> {
  const filePath = validateConversationPath(convId);

  try {
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw) as Conversation;
  } catch (err: unknown) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }
    throw err;
  }
}

/**
 * Write (create or overwrite) a conversation JSON file on disk.
 */
export async function saveConversation(conversation: Conversation): Promise<void> {
  const filePath = validateConversationPath(conversation.id);
  const dir = filePath.substring(0, filePath.lastIndexOf("/"));
  await ensureDir(dir);
  await writeFile(filePath, JSON.stringify(conversation, null, 2), "utf-8");
}

/**
 * Convenience: load, apply a partial update, and save back.
 * Throws if the conversation does not exist.
 */
export async function updateConversation(
  convId: string,
  updates: Partial<Conversation>,
): Promise<Conversation> {
  const existing = await getConversation(convId);

  if (!existing) {
    throw Object.assign(new Error(`Conversation not found: ${convId}`), {
      status: 404,
    });
  }

  const now = new Date().toISOString();

  const updated: Conversation = {
    ...existing,
    ...updates,
    id: existing.id, // id is immutable
    updated_at: updates.updated_at ?? now,
  };

  await saveConversation(updated);
  return updated;
}
