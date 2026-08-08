import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, resolve, sep } from "node:path";

/**
 * Error thrown when a file path is outside the allowed sandbox directories.
 * Carries HTTP 403 (Forbidden) status for use with the error-handler middleware.
 */
export class SandboxError extends Error {
  public readonly status: number = 403;

  constructor(message: string) {
    super(message);
    this.name = "SandboxError";
  }
}

export const DATA_ROOT = resolve(homedir(), ".local", "share", "voice-assistant");

/** Where GitHub sources get shallow-cloned. Throwaway; safe to delete. */
export const REPO_CACHE_ROOT = resolve(DATA_ROOT, "repos");

/**
 * The docs that describe this machine. `~/Projects/config` ships an agent skill
 * (`project-router`) that indexes every hardware/shell/GPU/AI-agent document in
 * the tree, which is exactly what the `machine` source needs.
 */
export const MACHINE_DOCS_ROOT = resolve(
  process.env.EXPLAINER_MACHINE_DOCS || resolve(homedir(), "Projects", "config"),
);

/**
 * Directories a *local* repo source is allowed to live under.
 *
 * The user picks the repo, but the model picks the paths inside it — so the
 * outer boundary is fixed here rather than trusted from either of them.
 */
export function allowedSourceRoots(): string[] {
  const extra = (process.env.EXPLAINER_REPO_ROOTS || "")
    .split(":")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => resolve(p.replace(/^~(?=$|\/)/, homedir())));

  return [
    REPO_CACHE_ROOT,
    MACHINE_DOCS_ROOT,
    resolve(homedir(), "Projects"),
    ...extra,
  ];
}

// RFC 4122 v4 — the exact shape uuidv4() produces.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** True when `value` is a v4 UUID. Shared by the routes so they all agree. */
export function isUUID(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * Reject filenames that are not a single, plain path segment.
 * Catches `/`, `\`, `..`, `.`, NUL bytes and empty strings.
 */
function assertPlainFilename(filename: string): void {
  if (
    filename.length === 0 ||
    filename.includes("\0") ||
    filename === "." ||
    filename === ".." ||
    basename(filename) !== filename
  ) {
    throw new SandboxError(`Invalid filename: ${filename}`);
  }
}

/** True when `candidate` is `root` itself or lives underneath it. */
export function isInsideRoot(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root);
  const normalized = resolve(candidate);
  return (
    normalized === normalizedRoot ||
    normalized.startsWith(normalizedRoot.endsWith(sep) ? normalizedRoot : normalizedRoot + sep)
  );
}

/**
 * Resolve `relativePath` against `root` and refuse anything that escapes it.
 * `relativePath` comes from the model, so `../../../etc/passwd` is the expected
 * input, not the exceptional one.
 *
 * @throws {SandboxError} when the result would land outside `root`.
 */
export function resolveInsideRoot(root: string, relativePath: string): string {
  if (relativePath.includes("\0")) {
    throw new SandboxError("Invalid path");
  }
  // An absolute path would make resolve() ignore `root` entirely.
  const cleaned = relativePath.replace(/^[/\\]+/, "");
  const resolved = resolve(root, cleaned);
  if (!isInsideRoot(root, resolved)) {
    throw new SandboxError(`Path escapes the source directory: ${relativePath}`);
  }
  return resolved;
}

/**
 * Validate a directory the user asked us to treat as a source root.
 *
 * @throws {SandboxError} when it is not under one of `allowedSourceRoots()`.
 */
export function assertAllowedSourceRoot(dir: string): string {
  const resolved = resolve(dir.replace(/^~(?=$|\/)/, homedir()));
  const roots = allowedSourceRoots();
  if (!roots.some((root) => isInsideRoot(root, resolved))) {
    throw new SandboxError(
      `Directory is outside the allowed roots (${roots.join(", ")}): ${resolved}`,
    );
  }
  return resolved;
}

/**
 * Build and validate the path where attachments for a conversation are stored.
 *
 * @throws {SandboxError} if convId is not a UUID or filename is not a plain segment.
 */
export function validateAttachmentPath(
  convId: string,
  filename?: string,
): string {
  if (!isUUID(convId)) {
    throw new SandboxError(
      `Invalid conversation ID (expected UUID): ${convId}`,
    );
  }

  const parts = [DATA_ROOT, "attachments", convId];
  if (filename !== undefined) {
    assertPlainFilename(filename);
    parts.push(filename);
  }

  return resolve(...parts);
}

/**
 * Build and validate the path for conversation JSON files.
 *
 * @throws {SandboxError} if convId is not a UUID.
 */
export function validateConversationPath(convId?: string): string {
  if (convId !== undefined) {
    if (!isUUID(convId)) {
      const err = new Error("Invalid conversation ID format") as Error & { status: number };
      err.status = 400;
      throw err;
    }
    return resolve(DATA_ROOT, "conversations", `${convId}.json`);
  }

  return resolve(DATA_ROOT, "conversations");
}

/**
 * Build and validate the path for conversation memory JSON files.
 *
 * Mirrors `validateConversationPath` rather than the attachment validator: a
 * memory file is the same shape of thing — one JSON per conversation, named by
 * UUID, with the bare directory returned when no id is given — so it reports a
 * bad id the same way (400) and a route can treat both identically.
 *
 * @throws {Error & { status: 400 }} if convId is not a UUID.
 */
export function validateMemoryPath(convId?: string): string {
  if (convId !== undefined) {
    if (!isUUID(convId)) {
      const err = new Error("Invalid conversation ID format") as Error & { status: number };
      err.status = 400;
      throw err;
    }
    return resolve(DATA_ROOT, "memory", `${convId}.json`);
  }

  return resolve(DATA_ROOT, "memory");
}

/**
 * Path of the generated-audio directory for a conversation.
 *
 * The realtime model streams its voice over WebRTC, so nothing writes here any
 * more — but conversations created by the old record/TTS pipeline still have
 * files on disk, and deleting a conversation has to clean them up.
 *
 * @throws {SandboxError} if convId is not a UUID or filename is not a plain segment.
 */
export function validateAudioPath(convId: string, filename?: string): string {
  if (!isUUID(convId)) {
    throw new SandboxError(`Invalid conversation ID (expected UUID): ${convId}`);
  }

  const parts = [DATA_ROOT, "audio", convId];
  if (filename !== undefined) {
    assertPlainFilename(filename);
    parts.push(filename);
  }

  return resolve(...parts);
}

/**
 * Create a directory recursively if it does not already exist.
 * Silently succeeds if the directory already exists.
 */
export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}
