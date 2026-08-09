/**
 * Structured logger for the main process (explainer).
 *
 * ONE line per event, always in the format:
 *
 *   2026-08-01T11:14:28.440Z [WARN ] [Tag] message
 *
 * …to the console (in the `[Tag] message` style already used by the code) AND
 * to `<userData>/logs/explainer.log`, with simple size-based rotation: past
 * ~2 MB the current file becomes `explainer.log.1` (the previous .1 is
 * discarded) and the log restarts from zero — at most 2 files, always.
 *
 * ┌── THE TWO GOLDEN RULES ──────────────────────────────────────────────────┐
 * │ 1. NO write ever takes down the main: every disk access runs inside a    │
 * │    try/catch; without a directory/file the logger degrades to            │
 * │    console-only. A log that kills the app destroys exactly the evidence  │
 * │    it exists to keep.                                                    │
 * │ 2. NO secret reaches the disk: every line goes through sanitizeLogText   │
 * │    (Bearer, sk-*, long hex, base64 tokens, data URIs) before being       │
 * │    written.                                                              │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Leaf module with injected dependency: the directory arrives via initLogger
 * (the boot passes `app.getPath('userData')`), so tests run in a tmpdir
 * without touching Electron.
 *
 * @module electron/main/services/logging/logger
 */

import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { format } from 'node:util';

/** Log levels — same set used by the console capture. */
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_FILE_NAME = 'explainer.log';
/** ~2 MB per file; with the .1 that is ~4 MB of history at most. */
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

// Singleton state — resolved ONCE at boot, by initLogger.
let logFile: string | null = null;
let rotatedFile: string | null = null;
let maxBytes = DEFAULT_MAX_BYTES;
// Current size IN MEMORY (no stat per line): the single-instance lock
// guarantees one writer, so the count cannot diverge from the disk.
let currentSize = 0;

// The ORIGINAL console, captured at module load: installConsoleCapture swaps
// console.warn/error, and the logger must keep writing to the console without
// falling into its own bridge (infinite loop).
const originalConsole = {
  debug: console.debug.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console)
};

/**
 * Secret patterns masked BEFORE any write. Order matters: the more specific
 * ones come first (a `Bearer sk-or-v1-…` is caught by the Bearer pattern;
 * whatever is left falls into the sk-* one).
 */
const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // data URI (e.g. a screen capture logged by mistake): the payload is huge
  // and can contain anything.
  [/(data:[^;\s]{0,64};base64,)[A-Za-z0-9+/=]+/g, '$1[REDACTED]'],
  // Authorization: Bearer <token>.
  [/(\bBearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]'],
  // Keys in the sk-* format (OpenAI, …).
  [/\bsk-[A-Za-z0-9_-]{6,}/g, '[REDACTED]'],
  // Long hex (sha256, machine-id, …).
  [/\b[0-9a-f]{32,}\b/gi, '[REDACTED]'],
  // Generic token: 48+ chars of the base64url alphabet containing a letter
  // AND a digit. Real text does not reach 48 chars without a space, and paths
  // are broken by `/` — what remains in this shape is almost certainly a
  // credential or a hash.
  [/\b(?=[A-Za-z0-9_-]*[0-9])(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{48,}/g, '[REDACTED]']
];

/** Masks secret patterns in a text before it goes to the log. */
export function sanitizeLogText(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

export interface LoggerInitOptions {
  /** Log directory (the boot passes `join(app.getPath('userData'), 'logs')`). */
  logDir: string;
  /** Ceiling per file in bytes (default ~2 MB) — tests shrink it to rotate. */
  maxBytes?: number;
}

/**
 * Resolves the log file and creates the directory. If the directory cannot be
 * created, the logger continues in console-only mode (getLogFilePath() ===
 * null).
 */
export function initLogger(options: LoggerInitOptions): void {
  maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  try {
    mkdirSync(options.logDir, { recursive: true });
  } catch (error) {
    logFile = null;
    rotatedFile = null;
    originalConsole.warn(
      '[Logger] ⚠️ log directory unavailable — console only:',
      error instanceof Error ? error.message : error
    );
    return;
  }
  logFile = join(options.logDir, LOG_FILE_NAME);
  rotatedFile = `${logFile}.1`;
  try {
    // Continue where the file left off — without this every boot would delay
    // the rotation by up to maxBytes and the pair of files would grow
    // without limit.
    currentSize = statSync(logFile).size;
  } catch {
    // ENOENT of the first boot: the file does not exist yet.
    currentSize = 0;
  }
}

/** Path of the log file, or null when file writing is unavailable. */
export function getLogFilePath(): string | null {
  return logFile;
}

function formatLine(level: LogLevel, tag: string, message: string): string {
  const stamp = new Date().toISOString();
  return `${stamp} [${level.toUpperCase().padEnd(5)}] [${tag}] ${message}\n`;
}

function appendToFile(line: string): void {
  if (!logFile) return;
  try {
    const bytes = Buffer.byteLength(line);
    if (currentSize > 0 && currentSize + bytes > maxBytes && rotatedFile) {
      try {
        // Windows does not rename over an existing file — remove first.
        rmSync(rotatedFile, { force: true });
        renameSync(logFile, rotatedFile);
        currentSize = 0;
      } catch {
        // Rotation failed (stuck file, permissions…): retry on the next line.
        // The append below proceeds — losing the new line is worse than
        // letting the file exceed the ceiling for a while.
      }
    }
    appendFileSync(logFile, line);
    currentSize += bytes;
  } catch {
    // The golden rule: NEVER take down the main because of logging.
  }
}

function write(level: LogLevel, tag: string, message: string): void {
  // Sanitize ONCE and use the safe text on both destinations — a secret must
  // not even reach the terminal.
  const safeMessage = sanitizeLogText(message);
  originalConsole[level](`[${tag}] ${safeMessage}`);
  appendToFile(formatLine(level, tag, safeMessage));
}

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** Creates a logger tagged with the module (e.g. `createLogger('Boot')`). */
export function createLogger(tag: string): Logger {
  return {
    debug: (message) => write('debug', tag, message),
    info: (message) => write('info', tag, message),
    warn: (message) => write('warn', tag, message),
    error: (message) => write('error', tag, message)
  };
}

/**
 * Bridge of the LOOSE console.warn/error calls in the main to the file: they
 * now ALSO go to the log without touching any call site. The terminal output
 * stays byte-for-byte identical (the original is called with the same
 * arguments); the file receives the structured line tagged 'Console'.
 */
export function installConsoleCapture(): void {
  console.warn = (...args: unknown[]): void => {
    appendToFile(formatLine('warn', 'Console', sanitizeLogText(format(...args))));
    originalConsole.warn(...args);
  };
  console.error = (...args: unknown[]): void => {
    appendToFile(formatLine('error', 'Console', sanitizeLogText(format(...args))));
    originalConsole.error(...args);
  };
}

const processLog = createLogger('Process');

function formatUnknown(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message;
  return format(value);
}

/**
 * Without these two handlers an uncaught exception would take down the main
 * WITHOUT leaving a trace — the app would vanish and nobody would know why.
 * The process is NOT terminated after logging: the app is a long-lived voice
 * assistant, and dying on a stray exception would kill an ongoing session.
 */
export function installProcessHandlers(): void {
  process.on('uncaughtException', (error) => {
    processLog.error(`uncaughtException: ${formatUnknown(error)}`);
  });
  process.on('unhandledRejection', (reason) => {
    processLog.error(`unhandledRejection: ${formatUnknown(reason)}`);
  });
}
