import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve, sep } from "node:path";

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

// This module lives at <root>/backend/src/middleware/ under tsx and at
// <root>/backend/dist/middleware/ once compiled — three levels up either way.
const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const DATA_ROOT = resolve(homedir(), ".local", "share", "voice-assistant");

/** Every directory the server is ever allowed to touch. */
export const ALLOWED_DIRS = [
  resolve(PROJECT_ROOT, "backend"),
  resolve(PROJECT_ROOT, "frontend"),
  DATA_ROOT,
];

// RFC 4122 v4 — the exact shape uuidv4() produces.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** True when `value` is a v4 UUID. Shared by the routes so they all agree. */
export function isUUID(value: string): boolean {
  return UUID_RE.test(value);
}

/** True when `child` is `parent` itself or sits underneath it. */
function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + sep);
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

/**
 * Resolve `requestedPath` relative to `baseAllowedDir`, ensuring the result
 * stays inside the allowed directory.
 *
 * @throws {SandboxError} if the base is outside the sandbox, or the path is
 *         absolute, contains a `..` segment, or escapes the base.
 */
export function resolveSafePath(
  requestedPath: string,
  baseAllowedDir: string,
): string {
  const resolvedBase = resolve(baseAllowedDir);

  if (!ALLOWED_DIRS.some((dir) => isInside(resolvedBase, dir))) {
    throw new SandboxError(
      `Base directory is outside the sandbox: ${baseAllowedDir}`,
    );
  }

  if (requestedPath.includes("\0")) {
    throw new SandboxError("Path contains a NUL byte");
  }
  if (isAbsolute(requestedPath)) {
    throw new SandboxError(`Absolute paths are not allowed: ${requestedPath}`);
  }
  if (requestedPath.split(/[\\/]/).includes("..")) {
    throw new SandboxError(`Path traversal is not allowed: ${requestedPath}`);
  }

  const resolved = resolve(resolvedBase, requestedPath);

  if (!isInside(resolved, resolvedBase)) {
    throw new SandboxError(
      `Path escapes the allowed directory: ${requestedPath}`,
    );
  }

  return resolved;
}

/**
 * Build and validate the path where attachments for a conversation are stored.
 *
 * @param convId  Conversation UUID.
 * @param filename  Optional attachment filename (a single plain path segment).
 * @returns Absolute path under `<DATA_ROOT>/attachments/<convId>[/<filename>]`.
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
 * @param convId  Optional conversation UUID.  When omitted the directory path is returned.
 * @returns Absolute path — either `<DATA_ROOT>/conversations/<convId>.json`
 *          or `<DATA_ROOT>/conversations/` (directory).
 *
 * @throws {SandboxError} if convId is not a UUID.
 */
export function validateConversationPath(convId?: string): string {
  if (convId !== undefined) {
    if (!isUUID(convId)) {
      throw new SandboxError(
        `Invalid conversation ID (expected UUID): ${convId}`,
      );
    }
    return resolve(DATA_ROOT, "conversations", `${convId}.json`);
  }

  return resolve(DATA_ROOT, "conversations");
}

/**
 * Build and validate the path for generated TTS audio files.
 *
 * @throws {SandboxError} if convId is not a UUID or filename is not a plain segment.
 */
export function validateAudioPath(convId: string, filename?: string): string {
  if (!isUUID(convId)) {
    throw new SandboxError(
      `Invalid conversation ID (expected UUID): ${convId}`,
    );
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
