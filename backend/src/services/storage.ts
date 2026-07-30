import { readFile, writeFile, unlink, readdir, rm } from "node:fs/promises";
import { v4 as uuidv4 } from "uuid";
import {
  validateConversationPath,
  validateAttachmentPath,
  validateAudioPath,
  ensureDir,
  isUUID,
} from "../middleware/sandbox.js";
import type { Conversation, Message } from "../types/index.js";

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

// A conversation is one JSON file rewritten whole, so two overlapping
// read-modify-write cycles lose whichever finished first. Serialise them per
// conversation id: a second /api/chat turn cannot clobber the first one's
// messages while it is still streaming.
const writeQueues = new Map<string, Promise<unknown>>();

function withConversationLock<T>(
  id: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = writeQueues.get(id) ?? Promise.resolve();
  // Run regardless of whether the previous operation resolved or rejected.
  const result = previous.then(operation, operation);

  // Keep the chain alive but never let a rejection escape into the next link.
  const link = result.then(
    () => undefined,
    () => undefined,
  );
  writeQueues.set(id, link);
  void link.then(() => {
    if (writeQueues.get(id) === link) writeQueues.delete(id);
  });

  return result;
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

  const conversations: Conversation[] = [];
  for (const file of entries) {
    if (!file.endsWith(".json")) continue;

    const id = file.slice(0, -".json".length);
    if (!isUUID(id)) continue; // stray file — not ours, skip it

    // One unreadable or half-written file must not take the whole list down.
    try {
      const raw = await readFile(validateConversationPath(id), "utf-8");
      conversations.push(JSON.parse(raw) as Conversation);
    } catch (err) {
      console.warn(
        `[storage] Skipping unreadable conversation ${file}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Most recently touched first — the UI opens conversations[0] by default.
  conversations.sort((a, b) =>
    (b.updated_at ?? "").localeCompare(a.updated_at ?? ""),
  );

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
  return withConversationLock(id, async () => {
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
  });
}

/**
 * Append messages to a conversation, re-reading the current state inside the
 * lock.
 *
 * A chat turn spans several seconds and several writes. Handing back the whole
 * `messages` array it read at the start would erase anything another turn
 * appended meanwhile — send two messages in quick succession and the first
 * request, finishing last, would wipe the second exchange off disk. Appending
 * against a fresh read makes concurrent turns interleave instead of clobber.
 *
 * @returns The conversation as persisted, including everyone else's messages.
 * @throws 404 when the conversation does not exist.
 */
export async function appendMessages(
  id: string,
  messages: Message[],
): Promise<Conversation> {
  return withConversationLock(id, async () => {
    const existing = await getConversation(id);
    if (!existing) {
      throw notFoundError(`Conversation not found: ${id}`);
    }

    const updated: Conversation = {
      ...existing,
      messages: [...(existing.messages ?? []), ...messages],
      updated_at: isoNow(),
    };

    await writeFile(validateConversationPath(id), JSON.stringify(updated, null, 2), "utf-8");

    return updated;
  });
}

/**
 * Delete a conversation by ID, along with everything it owns on disk.
 *
 * Removing only the JSON left the uploaded attachments and every generated
 * audio clip behind forever, with nothing left pointing at them — the data
 * directory grew without bound and could never be reclaimed through the UI.
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

  // Best effort: the record is already gone, so a stray leftover must not turn
  // a successful delete into an error. Both paths are sandbox-validated.
  for (const dir of [validateAttachmentPath(id), validateAudioPath(id)]) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch (err) {
      console.warn(
        `[storage] Could not remove ${dir}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
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
