/**
 * Where the backend lives, and whether one is already running.
 *
 * Split out of `index.ts` for one reason: both answers have to be provable
 * without an Electron runtime. Nothing here imports `electron`, so the port
 * probe and the command resolution are covered by
 * `__tests__/backend-process.test.ts` — which `npm run validate` does NOT run,
 * because the gate does not reach `electron/`. That test file names the command
 * that runs it.
 *
 * @module electron/main/services/backend-process
 */

import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';

/**
 * The port the backend binds — `Number(process.env.PORT) || 3001` in
 * `backend/src/index.ts`. Kept here as the single place the main process
 * spells it, because the probe and the spawned env have to agree.
 */
export const BACKEND_PORT = 3001;

/**
 * Loopback by address, never by name. The backend binds `127.0.0.1` unless
 * `EXPLAINER_HOST` says otherwise, and `localhost` can resolve to `::1` first —
 * which would answer ECONNREFUSED on a port that is very much taken.
 *
 * Exported because the provider-key sync (`services/provider-key-sync.ts`)
 * talks to the same address.
 */
export const BACKEND_HOST = '127.0.0.1';

/**
 * Outside the access gate on purpose (`OPEN_PATHS` in
 * `backend/src/middleware/access-key.ts`), so this probe works even when
 * `EXPLAINER_ACCESS_KEY` is set and we hold no key.
 */
const HEALTH_PATH = '/api/health';

/** The entry `dev.sh` runs, relative to `backend/`. */
const BACKEND_DEV_ENTRY = 'src/index.ts';

/** Same watch flag `backend/package.json`'s `dev` script uses. */
const BACKEND_DEV_ARGS = ['watch', BACKEND_DEV_ENTRY];

export type BackendPortStatus =
  /** Nothing is listening — spawning is safe. */
  | 'free'
  /** Something is listening AND answers `/api/health` — it is our backend. */
  | 'backend-alive'
  /** Something is listening but is not the backend — spawning would only die. */
  | 'occupied-by-other';

/**
 * A ready-to-spawn description of the backend process.
 *
 * There is deliberately no `shell` field: every command here is spawned
 * directly, so `child.kill()` reaches the process we started instead of an
 * interpreter wrapping it. See `resolveDevBackendCommand` for the Windows case
 * that would otherwise need one.
 */
export interface BackendCommand {
  /** Executable, spawned directly — never through a shell. */
  file: string;
  args: string[];
  /** Undefined means "inherit the app's cwd". */
  cwd?: string;
  /** Merged over `process.env` by the caller, after `PORT`. */
  extraEnv?: Record<string, string>;
  /** Human-readable form, for the log line that says what we started. */
  label: string;
}

export type BackendCommandResolution =
  | { ok: true; command: BackendCommand }
  | { ok: false; error: string };

/**
 * Is anything accepting connections on the port?
 *
 * A TCP connect answers that with no assumptions about what is on the other
 * end, which is what separates "free" from "occupied by a stranger" — a
 * distinction a plain HTTP probe cannot make.
 */
function isPortAccepting(port: number, host: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host });
    const settle = (accepting: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(accepting);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => settle(true));
    socket.once('timeout', () => settle(false));
    socket.once('error', () => settle(false));
  });
}

/** Does the thing on the port answer `/api/health` the way our backend does? */
async function answersHealth(port: number, host: string, timeoutMs: number): Promise<boolean> {
  try {
    const response = await fetch(`http://${host}:${port}${HEALTH_PATH}`, {
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { status?: unknown };
    return body?.status === 'ok';
  } catch {
    return false;
  }
}

/**
 * Classifies the backend port before anything is spawned.
 *
 * The repository already paid for the alternative: a backend that announced
 * itself on a port it never bound (`onda2-smoke-visual`). Two backends racing
 * for 3001 is the same bug seen from the other side — one of them exits(1) and
 * whichever loses takes its UI down with it.
 */
export async function probeBackendPort(
  port: number = BACKEND_PORT,
  timeoutMs = 600,
  host: string = BACKEND_HOST
): Promise<BackendPortStatus> {
  if (!(await isPortAccepting(port, host, timeoutMs))) return 'free';
  return (await answersHealth(port, host, timeoutMs)) ? 'backend-alive' : 'occupied-by-other';
}

/**
 * The packaged backend — DEAD CODE TODAY, described honestly so nobody reads it
 * as a working path.
 *
 * Nothing copies a backend into `resources/`. `electron-builder.yml` is an
 * inclusion list (`out/**`, `package.json`, `node_modules/**`) with no
 * `extraResources` and no `extraFiles`, and `npm run dist` is
 * `electron-vite build && electron-builder`, where the build step only produces
 * main, preload and renderer. `resources/backend/index.js` therefore exists in
 * no artifact this repository can currently produce.
 *
 * Nor would adding the file be enough: running a script with the app binary
 * requires `ELECTRON_RUN_AS_NODE=1`, and `scripts/flip-fuses.cjs` burns
 * `RunAsNode: false` into every packaged binary, which turns that variable into
 * a no-op. A packaged backend needs a different mechanism altogether
 * (`utilityProcess.fork()` plus `extraResources`), scheduled as its own piece
 * of work.
 *
 * Left pointing where it always pointed, so the eventual wiring has somewhere
 * to land — the packaged behaviour is unchanged by this file's rewrite.
 */
export function resolvePackagedBackendCommand(
  resourcesPath: string,
  execPath: string
): BackendCommand {
  const entry = join(resourcesPath, 'backend', 'index.js');
  return { file: execPath, args: [entry], label: entry };
}

/**
 * The dev backend: `tsx watch src/index.ts`, character for character the
 * command `backend/package.json`'s `dev` script and `dev.sh` run — so the
 * desktop app reloads the backend on a source edit exactly like a terminal
 * `npm run dev` does.
 *
 * Source before build output, deliberately. `backend/dist` is a build artifact
 * that nothing in the dev flow refreshes, so preferring it would silently serve
 * whatever the last `npm --prefix backend run build` produced — a stale backend
 * that looks alive is worse than no backend, because nothing about it says it
 * is old. `dist` remains the fallback for the tree that installed nothing.
 *
 * `watch` costs nothing at teardown, which an earlier revision of this file
 * claimed it did. Measured on Linux with tsx 4.23.1, spawning through this very
 * function and then `child.kill()`-ing exactly as `before-quit` does, three
 * runs of each form: `tsx watch` AND plain `tsx` both run the server in a
 * *grandchild* process (the spawned pid is the tsx CLI, a different pid holds
 * 3001), and both forward the SIGTERM — 6 runs out of 6 exited
 * `(code 143, signal null)` with the port free two seconds later. The
 * grandchild is not a property of `watch`, and neither form orphans the server
 * on a normal quit.
 *
 * What does orphan it is a signal tsx cannot catch, and that was measured too:
 * `child.kill('SIGKILL')` exits `(code null, signal 'SIGKILL')` and leaves the
 * grandchild still listening on 3001. That is the case `index.ts`'s exit
 * handler reports, and the reason it cannot treat a signalled exit as routine.
 *
 * Spawned as `execPath` + tsx's own JS entry, with `ELECTRON_RUN_AS_NODE=1`,
 * rather than `node_modules/.bin/tsx`. That shim is a `#!/usr/bin/env node`
 * script on POSIX and a `.cmd` on Windows, and Node refuses to spawn a `.cmd`
 * without a shell (the CVE-2024-27980 fix). A shell is precisely what breaks
 * teardown on Windows — `child.kill()` would kill the `cmd.exe` wrapper and
 * leave the server holding 3001 — and Windows (`win: nsis x64`) is the only
 * release target `electron-builder.yml` declares. Running the JS entry directly
 * needs no shell on any platform, so there is one code path instead of two.
 */
export function resolveDevBackendCommand(
  repoRoot: string,
  execPath: string
): BackendCommandResolution {
  const backendDir = join(repoRoot, 'backend');
  // tsx's declared `bin` target — the file both `.bin` shims exec.
  const tsxEntry = join(backendDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');

  if (existsSync(tsxEntry)) {
    return {
      ok: true,
      command: {
        file: execPath,
        args: [tsxEntry, ...BACKEND_DEV_ARGS],
        cwd: backendDir,
        // Without this the Electron binary boots a second COPY OF THE APP with
        // that file as its main script, instead of running it as Node.
        extraEnv: { ELECTRON_RUN_AS_NODE: '1' },
        label: `tsx ${BACKEND_DEV_ARGS.join(' ')}`
      }
    };
  }

  const built = join(backendDir, 'dist', 'index.js');
  if (existsSync(built)) {
    return {
      ok: true,
      command: {
        file: execPath,
        args: [built],
        cwd: backendDir,
        extraEnv: { ELECTRON_RUN_AS_NODE: '1' },
        label: `node ${built} (built output — run \`npm --prefix backend run build\` again if it looks stale)`
      }
    };
  }

  return {
    ok: false,
    error:
      `neither ${tsxEntry} nor ${built} exists, so there is nothing to run. ` +
      'The backend dependencies were never installed in this tree: run `npm run setup` ' +
      'at the repository root and start the app again.'
  };
}
