import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

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

const PROJECT_ROOT = resolve(import.meta.dirname, "..");
const DATA_ROOT = resolve(homedir(), ".local", "share", "voice-assistant");

const ALLOWED_DIRS = [
  resolve(PROJECT_ROOT, "backend"),
  resolve(PROJECT_ROOT, "frontend"),
  DATA_ROOT,
];

const UUID_RE = /^[a-f0-9-]{36}$/;

/**
 * Resolve `requestedPath` relative to `baseAllowedDir`, ensuring the result
 * stays inside the allowed directory.
 *
 * @throws {SandboxError} if path is absolute, contains `..`, or escapes the base.
 */
export function resolveSafePath(
  requestedPath: string,
  baseAllowedDir: string,
): string {
  if (requestedPath.startsWith("/")) {
    throw new SandboxError(
      `Absolute paths are not allowed: ${requestedPath}`,
    );
  }
  if (requestedPath.includes("..")) {
    throw new SandboxError(
      `Path traversal is not allowed: ${requestedPath}`,
    );
  }

  const resolvedBase = resolve(baseAllowedDir);
  const resolved = resolve(resolvedBase, requestedPath);

  if (!resolved.startsWith(resolvedBase + "/") && resolved !== resolvedBase) {
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
 * @param filename  Optional attachment filename (no slashes or `..`).
 * @returns Absolute path under `<DATA_ROOT>/attachments/<convId>[/<filename>]`.
 *
 * @throws {SandboxError} if convId is not a UUID or filename contains unsafe chars.
 */
export function validateAttachmentPath(
  convId: string,
  filename?: string,
): string {
  if (!UUID_RE.test(convId)) {
    throw new SandboxError(
      `Invalid conversation ID (expected UUID): ${convId}`,
    );
  }

  const parts = [DATA_ROOT, "attachments", convId];
  if (filename !== undefined) {
    if (filename.includes("/") || filename.includes("..")) {
      throw new SandboxError(
        `Invalid attachment filename: ${filename}`,
      );
    }
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
    if (!UUID_RE.test(convId)) {
      throw new SandboxError(
        `Invalid conversation ID (expected UUID): ${convId}`,
      );
    }
    return resolve(DATA_ROOT, "conversations", `${convId}.json`);
  }

  return resolve(DATA_ROOT, "conversations");
}

/**
 * Create a directory recursively if it does not already exist.
 * Silently succeeds if the directory already exists.
 */
export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}
