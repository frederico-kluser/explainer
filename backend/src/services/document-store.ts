// === The conversation's collaborative markdown document ===
//
// One .md file per conversation, stored under DATA_ROOT/documents/ next to the
// memory files. The model and the user edit it together — the model through three
// realtime tools, the user through the DocumentPanel on screen.
//
// Every write is atomic (temp + rename) and guarded by a per-conversation lock
// so concurrent edits from two screens and the model serialize cleanly.

import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DATA_ROOT, ensureDir, isUUID } from "../middleware/sandbox.js";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Hard ceiling on the document, in characters. Beyond this a truncation marker
 *  is appended so the model knows there is more. */
export const DOCUMENT_MAX_CHARS = 100_000;

function truncationMarker(cut: number): string {
  return `\n\n… [truncado: ${cut} caracteres alem do limite de ${DOCUMENT_MAX_CHARS.toLocaleString("pt-BR")}]`;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function documentDir(): string {
  return join(DATA_ROOT, "documents");
}

function documentPath(conversationId: string): string {
  if (!isUUID(conversationId)) {
    const err = new Error(
      "Invalid conversation ID format",
    ) as Error & { status: number };
    (err as unknown as Record<string, unknown>).status = 400;
    throw err;
  }
  return join(documentDir(), `${conversationId}.md`);
}

// ---------------------------------------------------------------------------
// Write lock (per conversation, like withMemoryLock in memory.ts)
// ---------------------------------------------------------------------------

const locks = new Map<string, Promise<void>>();

function withDocumentLock<T>(
  conversationId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = locks.get(conversationId) ?? Promise.resolve();

  const next = prev.then(fn, fn); // run fn even if the previous holder rejected
  const cleanup = next.then(
    () => {},
    () => {},
  );
  locks.set(conversationId, cleanup);

  // Clean up the map entry once the chain is fully settled so a conversation
  // that is never touched again does not leak.
  void cleanup.then(() => {
    if (locks.get(conversationId) === cleanup) locks.delete(conversationId);
  });

  return next;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** The current content, or null when no document exists yet. */
export async function readDocument(
  conversationId: string,
): Promise<string | null> {
  const path = documentPath(conversationId);
  try {
    return await readFile(path, "utf-8");
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as unknown as Record<string, unknown>).code === "ENOENT"
    ) {
      return null;
    }
    throw err;
  }
}

/**
 * The write itself, with the lock ALREADY held.
 *
 * This exists because `withDocumentLock` is not reentrant, and cannot be: it
 * chains each operation onto the previous one's completion, so a holder that
 * calls a second locked function is waiting on a promise that only resolves
 * when the holder returns. That is a deadlock with no timeout and no error —
 * the request simply never answers — and it is exactly what `appendDocument`
 * did by calling `writeDocument` from inside its own critical section.
 *
 * Every locked entry point below is therefore one `withDocumentLock` around
 * calls to this, and never around another entry point.
 */
async function writeLocked(
  conversationId: string,
  content: string,
): Promise<string> {
  const dir = documentDir();
  await ensureDir(dir);

  const path = documentPath(conversationId);

  let stored = content;
  if (stored.length > DOCUMENT_MAX_CHARS) {
    const cut = stored.length - DOCUMENT_MAX_CHARS;
    stored = stored.slice(0, DOCUMENT_MAX_CHARS) + truncationMarker(cut);
  }

  // Avoid the write when nothing changed.
  const current = await readDocument(conversationId);
  if (current === stored) return stored;

  const tmp = join(dir, `.tmp-${randomUUID()}.md`);
  await writeFile(tmp, stored, "utf-8");
  await rename(tmp, path);

  return stored;
}

/**
 * Replace the whole document.
 *
 * Truncates at DOCUMENT_MAX_CHARS with a pt-BR marker. Skips the write when the
 * content is byte-identical to what is already on disk.
 *
 * Returns the stored (post-truncation) text so callers can broadcast the
 * server-normalised truth.
 */
export async function writeDocument(
  conversationId: string,
  content: string,
): Promise<string> {
  return withDocumentLock(conversationId, () => writeLocked(conversationId, content));
}

/**
 * Read the document, transform it, and write the result — all inside one lock.
 *
 * The read-modify-write that every partial edit needs. Doing it as a
 * `readDocument` followed by a `writeDocument` looks equivalent and is not:
 * three writers reach this file — the model, this browser and any other screen
 * on the same conversation — so between an unlocked read and its write another
 * one lands and is silently overwritten.
 *
 * `transform` receives null when there is no document yet, so a caller can tell
 * "empty" from "absent" and decide whether it is creating or editing.
 */
export async function updateDocument(
  conversationId: string,
  transform: (current: string | null) => string,
): Promise<string> {
  return withDocumentLock(conversationId, async () => {
    const current = await readDocument(conversationId);
    return writeLocked(conversationId, transform(current));
  });
}

/**
 * Append content to the end of the document.
 *
 * Returns the full stored text after the append.
 */
export async function appendDocument(
  conversationId: string,
  content: string,
): Promise<string> {
  return updateDocument(conversationId, (current) => {
    const prev = current ?? "";
    return prev.length > 0 ? `${prev}\n\n${content}` : content;
  });
}

/** Delete the document. ENOENT is not an error — it is already gone. */
export async function deleteDocument(conversationId: string): Promise<void> {
  const path = documentPath(conversationId);
  try {
    await unlink(path);
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as unknown as Record<string, unknown>).code === "ENOENT"
    ) {
      return;
    }
    throw err;
  }
}
