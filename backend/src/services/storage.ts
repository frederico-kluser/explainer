import { readFile, writeFile, unlink, readdir } from "node:fs/promises";
import { v4 as uuidv4 } from "uuid";
import { validateConversationPath, ensureDir } from "../middleware/sandbox.js";
import type { Conversation } from "../types/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function notFoundError(message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = 404;
  return err;
}

function isoNow(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * List all conversations stored on disk.
 * Ensures the conversations directory exists (may return [] on first call).
 */
export async function listConversations(): Promise<Conversation[]> {
  const dir = validateConversationPath();
  await ensureDir(dir);

  const entries = await readdir(dir);
  const jsonFiles = entries.filter((f) => f.endsWith(".json"));

  const conversations: Conversation[] = [];
  for (const file of jsonFiles) {
    const raw = await readFile(validateConversationPath(file.replace(/\.json$/, "")), "utf-8");
    conversations.push(JSON.parse(raw) as Conversation);
  }

  return conversations;
}

/**
 * Retrieve a single conversation by ID.
 * Returns null when the conversation does not exist.
 */
export async function getConversation(id: string): Promise<Conversation | null> {
  const filePath = validateConversationPath(id);

  try {
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw) as Conversation;
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/**
 * Create a new conversation with the given title.
 * Initialises empty messages and attachments arrays.
 */
export async function createConversation(title: string): Promise<Conversation> {
  const id = uuidv4();
  const now = isoNow();

  const conversation: Conversation = {
    id,
    title,
    created_at: now,
    updated_at: now,
    messages: [],
    attachments: [],
  };

  // Ensure the directory exists before writing
  await ensureDir(validateConversationPath());

  await writeFile(validateConversationPath(id), JSON.stringify(conversation, null, 2), "utf-8");

  return conversation;
}

/**
 * Partially update a conversation by ID.
 * Merges the provided data into the existing record and bumps updated_at.
 *
 * @throws 404 when the conversation does not exist.
 */
export async function updateConversation(
  id: string,
  data: Partial<Conversation>,
): Promise<Conversation> {
  const existing = await getConversation(id);
  if (!existing) {
    throw notFoundError(`Conversation not found: ${id}`);
  }

  const updated: Conversation = {
    ...existing,
    ...data,
    id: existing.id, // id is immutable
    created_at: existing.created_at, // created_at is immutable
    updated_at: isoNow(),
  };

  await writeFile(validateConversationPath(id), JSON.stringify(updated, null, 2), "utf-8");

  return updated;
}

/**
 * Delete a conversation by ID.
 *
 * @throws 404 when the conversation does not exist.
 */
export async function deleteConversation(id: string): Promise<void> {
  const filePath = validateConversationPath(id);

  try {
    await unlink(filePath);
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === "ENOENT") {
      throw notFoundError(`Conversation not found: ${id}`);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface NodeError extends Error {
  code: string;
}

function isNodeError(err: unknown): err is NodeError {
  return err instanceof Error && "code" in err;
}
