/**
 * explainer — main process boot (simplified from quiet-que).
 *
 * Here: Linux sandbox probe, single-instance lock, logger + env seeding,
 * backend child process, IPC handlers and the main window.
 */

import { app, ipcMain } from 'electron';
import { electronApp, optimizer } from '@electron-toolkit/utils';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createWindow, getMainWindow } from './window';
import { registerAllHandlers } from './ipc';
import {
  createLogger,
  getLogFilePath,
  initLogger,
  installConsoleCapture,
  installProcessHandlers
} from './services/logging/logger';
import { settingsStore } from './storage/settings-store';
import {
  BACKEND_PORT,
  probeBackendPort,
  resolveDevBackendCommand,
  resolvePackagedBackendCommand,
  type BackendCommandResolution
} from './services/backend-process';
import { collectEnvApiKeys, loadDotEnvFile, pickProvidersToSeed } from './services/envKeys';
import type { AppSettings } from '@shared/types/settings.types';

// ---------------------------------------------------------------------------
// Linux Chromium sandbox handling (AppImage- AND deb-safe) — copied from
// quiet-que (which copied it from electron-huu). The setuid `chrome-sandbox`
// helper does not work inside an AppImage (FUSE nosuid), so Electron falls
// back to the unprivileged user-namespace sandbox. When the kernel/distro
// blocks unprivileged userns, Electron ABORTS at launch. We detect that
// situation and disable the sandbox ONLY when it genuinely cannot come up —
// never a generic `--no-sandbox`.
// ---------------------------------------------------------------------------
function suidSandboxHelperUsable(): boolean {
  // A root:root mode-4755 chrome-sandbox next to the binary enables the
  // classic SUID sandbox even where userns is blocked. NEVER trust the bits
  // inside an AppImage: the squashfs preserves uid 0 + 4755, but the FUSE
  // mount is nosuid.
  if (process.env.APPIMAGE) return false;
  try {
    const st = statSync(join(dirname(process.execPath), 'chrome-sandbox'));
    return st.uid === 0 && (st.mode & 0o4000) !== 0;
  } catch {
    return false;
  }
}

function unprivilegedUsernsBlocked(): boolean {
  try {
    // Tests directly what Chromium needs. Exit 0 → userns works → keep the
    // sandbox.
    execFileSync('unshare', ['-Ur', '--', 'true'], { stdio: 'ignore', timeout: 3000 });
    return false;
  } catch (err) {
    // ENOENT = `unshare` not installed (rare) → cannot know → don't disable.
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
    return true; // ran and FAILED → userns blocked → the sandbox cannot come up.
  }
}

if (process.getuid && process.getuid() === 0) {
  // Root cannot use the sandbox; it also drops the GPU (typical in root/headless).
  app.commandLine.appendSwitch('no-sandbox');
  app.disableHardwareAcceleration();
} else if (
  process.platform === 'linux' &&
  !suidSandboxHelperUsable() &&
  unprivilegedUsernsBlocked()
) {
  app.commandLine.appendSwitch('no-sandbox');
}

// Structured logger — the FIRST subsystem to come up: from here on, loose
// console.warn/error calls and any uncaught exception ALSO land in
// userData/logs/explainer.log (rotation ~2 MB × 2 files; a logging failure
// never takes down the main — see services/logging/logger.ts).
initLogger({ logDir: join(app.getPath('userData'), 'logs') });
installConsoleCapture();
installProcessHandlers();
const bootLog = createLogger('Boot');

// Single instance: a second launch reveals the running instance instead of
// starting another one that would fight over the electron-store / the backend
// port.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      if (!win.isVisible()) win.show();
      if (win.isMinimized()) win.restore();
      win.focus();
    } else {
      createWindow();
    }
  });
}

// ---------------------------------------------------------------------------
// Backend child process — the Express server the browser's WebRTC session
// talks to. Dev: `tsx watch` over `backend/src`, the same command `dev.sh` and
// `backend/package.json` run — the old dev path pointed at
// `backend/dist/index.js`, a file no dev flow builds, so the desktop app came
// up with no `/api` at all and said so nowhere. PORT forced to 3001.
//
// The PACKAGED branch is not wired up: nothing copies a backend into
// `resources/`, and the `RunAsNode: false` fuse blocks the way it tries to run
// one. `resolvePackagedBackendCommand` documents both; it needs
// `utilityProcess.fork()` and `extraResources` to become real.
//
// Resolution lives in `services/backend-process.ts` so it can be tested outside
// Electron.
//
// Stays null whenever we did NOT start it: a backend that was already running
// belongs to whoever started it, and `before-quit` must not kill a process it
// does not own.
// ---------------------------------------------------------------------------
let backendProcess: ChildProcess | null = null;

/**
 * Set right before the teardown kill, and the only reliable way to tell a
 * shutdown from a crash: `tsx` catches SIGTERM and re-exits with 128+signal
 * instead of dying from it, so a perfectly normal quit arrives as
 * `(code 143, signal null)` — indistinguishable, by the arguments alone, from
 * a backend that fell over.
 */
let backendStopRequested = false;

async function startBackend(): Promise<void> {
  const status = await probeBackendPort();

  if (status === 'backend-alive') {
    // `npm run dev` in a terminal, or the previous main process after an
    // electron-vite reload. Either way the UI already has its backend, and a
    // second one would only lose the race for the port and exit(1).
    bootLog.info(
      `[backend] a backend already answers on port ${BACKEND_PORT} — reusing it instead of spawning a second one.`
    );
    return;
  }

  if (status === 'occupied-by-other') {
    bootLog.error(
      `[backend] port ${BACKEND_PORT} is held by a process that does not answer /api/health. ` +
        'Not spawning — the backend exits(1) when it cannot bind. Free the port ' +
        `(\`lsof -i :${BACKEND_PORT}\`) and start the app again.`
    );
    return;
  }

  const resolution: BackendCommandResolution = app.isPackaged
    ? {
        ok: true,
        command: resolvePackagedBackendCommand(process.resourcesPath, process.execPath)
      }
    : resolveDevBackendCommand(join(__dirname, '..', '..'), process.execPath);

  if (!resolution.ok) {
    bootLog.error(`[backend] not started — ${resolution.error}`);
    return;
  }

  const { command } = resolution;
  bootLog.info(`[backend] starting ${command.label}`);

  const child = spawn(command.file, command.args, {
    cwd: command.cwd,
    env: { ...process.env, PORT: String(BACKEND_PORT), ...command.extraEnv },
    stdio: 'pipe'
  });
  backendProcess = child;

  child.stdout?.on('data', (d) => bootLog.info(`[backend] ${d.toString().trim()}`));
  child.stderr?.on('data', (d) => bootLog.warn(`[backend] ${d.toString().trim()}`));

  // A spawn that never starts emits `error` and nothing else — no stderr, no
  // exit. It is the silent failure, so it gets the loudest line.
  child.on('error', (error) => {
    bootLog.error(
      `[backend] failed to spawn ${command.label}: ${error.message}. ` +
        'If the dependencies are missing, run `npm run setup` at the repository root.'
    );
  });

  // Only the teardown WE asked for is quiet. Every other exit took the UI's
  // `/api` with it, and the whole point of this handler is that such an exit
  // must not be discoverable only by the app going mute.
  child.on('exit', (code, signal) => {
    if (backendStopRequested) {
      bootLog.info(`[backend] exited (code ${code}, signal ${signal})`);
      return;
    }

    if (signal !== null) {
      // A signalled exit is never the teardown: measured, tsx CATCHES the
      // SIGTERM from `child.kill()` and re-exits, so an orderly quit arrives as
      // `(143, null)` — a signal, never. Reaching this line therefore means a
      // signal tsx could not catch, SIGKILL being the one that happens by
      // itself on this machine (`earlyoom`), and that one was measured to leave
      // the server running below tsx still listening on the port.
      bootLog.error(
        `[backend] killed by ${signal} — the UI now has no /api and no voice session. ` +
          'An uncatchable signal does not reach the server process below tsx, so port ' +
          `${BACKEND_PORT} may still be held by it: check \`lsof -i :${BACKEND_PORT}\` ` +
          'before starting the app again.'
      );
      return;
    }

    bootLog.error(
      `[backend] exited with code ${code} — the UI now has no /api and no voice session. ` +
        (code === 0
          ? 'It stopped on its own, without being asked to.'
          : 'The backend prints the reason on the lines above.')
    );
  });
}

/**
 * Loads the `.env` BEFORE any decision that depends on the environment.
 *
 * The shell keeps beating the file (`loadDotEnvFile` never overwrites). The
 * candidates cover the three places the file can live: the working directory
 * (dev), next to the executable (packaged, launched by the user) and inside
 * the resources dir (packaged, launched by the OS).
 */
function loadEnvironmentFile(): void {
  const candidates = [
    join(process.cwd(), '.env'),
    join(dirname(app.getPath('exe')), '.env'),
    join(process.resourcesPath ?? '', '.env')
  ];
  for (const candidate of candidates) {
    if (loadDotEnvFile(candidate) > 0) {
      bootLog.info(`.env applied from ${candidate}`);
      return;
    }
  }
}

/**
 * Seeds the BYO API key from the environment (`OPENAI_API_KEY`, plus an
 * optional `.env` in the root) — whoever exports the key in the shell doesn't
 * type anything in the UI.
 *
 * Only fills a slot whose key DIFFERS from the env one (empty included): the
 * shell wins over the disk, like `loadDotEnvFile`. The store encrypts at
 * persistence, so nothing here becomes plaintext on disk — and the log is
 * BOOLEAN, never the value.
 *
 * Best effort: any failure here is irrelevant to the boot (the user can still
 * register the key from the setup screen).
 */
async function seedApiKeysFromEnv(stored: AppSettings['apiKeys']): Promise<void> {
  try {
    const seeds = pickProvidersToSeed(stored, collectEnvApiKeys());
    if (seeds.length === 0) return;

    for (const { provider, key } of seeds) {
      const saved = await settingsStore.saveApiKey(provider, key, 'idle');
      bootLog.info(`[EnvKeys] ${saved ? 'OK' : 'FAILED'} — key of ${provider} ${saved ? 'seeded' : 'NOT saved'} from the environment`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    bootLog.warn(`[EnvKeys] seeding failed (continuing without it): ${message}`);
  }
}

app.whenReady().then(() => {
  // A second instance already called app.quit() above — nothing to init here.
  if (!gotSingleInstanceLock) return;

  electronApp.setAppUserModelId('com.ondokai.explainer');

  // The log path right at boot — it is the first thing support asks for.
  bootLog.info(`log file: ${getLogFilePath() ?? '(unavailable — console only)'}`);

  // Environment BEFORE the handlers: the backend spawn and the key seeding
  // depend on it.
  loadEnvironmentFile();

  // F12 opens/closes DevTools in dev; CmdOrCtrl+R is ignored in production.
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  // Registers all IPC handlers (settings/app — see electron/main/ipc/index.ts).
  registerAllHandlers();

  // Backend child process — the WebRTC/session server for the UI. Not awaited:
  // the port probe costs up to ~600 ms and the window must not wait on it.
  void startBackend();

  // Persisted settings applied on the rise (key seeding from the env). A
  // failure here degrades instead of crashing the boot: the app starts on the
  // defaults and the user can still register the key in the setup screen.
  void settingsStore
    .load()
    .then(async (settings) => {
      await seedApiKeysFromEnv(settings.apiKeys);
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      bootLog.warn(`failed to apply persisted settings: ${message}`);
    });

  createWindow();

  app.on('activate', function () {
    // macOS: clicking the Dock icon recreates the main window if it was closed.
    const win = getMainWindow();
    if (!win || win.isDestroyed()) {
      createWindow();
    }
  });
});

// Shutdown via signal (kill / Ctrl+C / supervisor) — clean quit.
//
// `SIGBREAK` is the WINDOWS one: `SIGTERM` does not exist there and `SIGINT`
// only arrives on a console Ctrl+C. Without it, the whole `before-quit` below
// — which is what kills the backend — would be skipped on any shutdown that
// is not the close button.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) {
  process.on(signal, () => {
    app.quit();
  });
}

// Quit when all windows are closed, except on macOS. In practice the shutdown
// starts from the `closed` of the main window (window.ts).
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

/** Channels registered by the IPC handlers — removed on quit. */
const IPC_CHANNELS = [
  'settings:get',
  'settings:save-api-key',
  'settings:remove-api-key',
  'settings:validate-api-key',
  'settings:set',
  'app:open-external',
  'app:get-platform'
] as const;

// Clean teardown: kill the backend child and deregister the IPC handlers.
// Synchronous by design — before-quit must not await anything.
app.on('before-quit', () => {
  if (backendProcess && !backendProcess.killed) {
    backendStopRequested = true;
    backendProcess.kill();
  }
  backendProcess = null;
  for (const channel of IPC_CHANNELS) {
    ipcMain.removeHandler(channel);
  }
});
