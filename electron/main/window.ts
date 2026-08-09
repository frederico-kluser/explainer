/**
 * Main window factory (explainer) — simplified from quiet-que's window.ts.
 *
 * A single BrowserWindow for the React UI, with persisted geometry (position /
 * size / maximized), an OS-theme-following background color and the standard
 * dev/prod loading split. Closing the window quits the app on non-macOS.
 */

import { app, BrowserWindow, nativeTheme, screen, shell, type Rectangle } from 'electron';
import { is } from '@electron-toolkit/utils';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import packageJson from '../../package.json';
import { appWindowBackgroundFor } from '@shared/utils/theme.utils';

export const MIN_WINDOW_WIDTH = 1024;
export const MIN_WINDOW_HEIGHT = 700;

const WINDOW_STATE_FILE = 'main-window-state.json';
const DEFAULT_WINDOW_WIDTH = 1024;
const DEFAULT_WINDOW_HEIGHT = 768;

interface MainWindowState {
  x: number;
  y: number;
  width: number;
  height: number;
  isMaximized: boolean;
}

let mainWindow: BrowserWindow | null = null;
let pendingWindowStateSaveTimer: NodeJS.Timeout | null = null;
let nativeThemeUpdatedListener: (() => void) | null = null;

// ---------------------------------------------------------------------------
// Window state persistence (simplified from quiet-que's window-state-store;
// inlined because the explainer has a single window)
// ---------------------------------------------------------------------------

const clamp = (value: number, min: number, max: number): number => {
  return Math.min(max, Math.max(min, value));
};

const isFiniteNumber = (value: unknown): value is number => {
  return typeof value === 'number' && Number.isFinite(value);
};

const getWindowStatePath = (): string => {
  return join(app.getPath('userData'), WINDOW_STATE_FILE);
};

const isValidMainWindowState = (value: unknown): value is MainWindowState => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const state = value as Partial<MainWindowState>;
  return (
    isFiniteNumber(state.x) &&
    isFiniteNumber(state.y) &&
    isFiniteNumber(state.width) &&
    isFiniteNumber(state.height) &&
    typeof state.isMaximized === 'boolean'
  );
};

/** Clamps the bounds into the work area of the display they match. */
const sanitizeBounds = (bounds: Rectangle): Rectangle => {
  const workArea = screen.getDisplayMatching(bounds).workArea;
  const width = clamp(bounds.width, MIN_WINDOW_WIDTH, workArea.width);
  const height = clamp(bounds.height, MIN_WINDOW_HEIGHT, workArea.height);
  const x = clamp(bounds.x, workArea.x, workArea.x + workArea.width - width);
  const y = clamp(bounds.y, workArea.y, workArea.y + workArea.height - height);
  return { x, y, width, height };
};

const createDefaultState = (): MainWindowState => {
  const primaryWorkArea = screen.getPrimaryDisplay().workArea;
  const width = Math.min(DEFAULT_WINDOW_WIDTH, primaryWorkArea.width);
  const height = Math.min(DEFAULT_WINDOW_HEIGHT, primaryWorkArea.height);
  return {
    x: Math.round(primaryWorkArea.x + (primaryWorkArea.width - width) / 2),
    y: Math.round(primaryWorkArea.y + (primaryWorkArea.height - height) / 2),
    width,
    height,
    isMaximized: false
  };
};

const sanitizeMainWindowState = (state: MainWindowState): MainWindowState => {
  return { ...state, ...sanitizeBounds(state) };
};

const loadInitialWindowState = (): MainWindowState => {
  try {
    const filePath = getWindowStatePath();
    if (!existsSync(filePath)) return createDefaultState();
    const parsed = JSON.parse(
      readFileSync(filePath, 'utf-8')
    ) as Partial<{ mainWindowState: MainWindowState }>;
    if (!isValidMainWindowState(parsed.mainWindowState)) {
      console.warn('[Window] invalid saved window state — using defaults');
      return createDefaultState();
    }
    return sanitizeMainWindowState(parsed.mainWindowState);
  } catch (error) {
    console.warn('[Window] unreadable window state — using defaults:', error);
    return createDefaultState();
  }
};

const persistMainWindowState = (window: BrowserWindow): void => {
  if (!window || window.isDestroyed()) {
    return;
  }
  const isMaximized = window.isFullScreen() ? false : window.isMaximized();
  const bounds = isMaximized ? window.getNormalBounds() : window.getBounds();
  const state = sanitizeMainWindowState({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    isMaximized
  });
  try {
    const filePath = getWindowStatePath();
    mkdirSync(dirname(filePath), { recursive: true });
    // tmp + rename (atomic on the same filesystem): a crash in the middle of a
    // direct writeFileSync would leave a TRUNCATED JSON and the next boot
    // would lose the window position.
    const tmpPath = `${filePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify({ mainWindowState: state }, null, 2), 'utf-8');
    renameSync(tmpPath, filePath);
  } catch (error) {
    console.warn('[Window] failed to save window state:', error);
  }
};

const scheduleMainWindowStateSave = (window: BrowserWindow): void => {
  if (pendingWindowStateSaveTimer) {
    clearTimeout(pendingWindowStateSaveTimer);
  }
  pendingWindowStateSaveTimer = setTimeout(() => {
    pendingWindowStateSaveTimer = null;
    persistMainWindowState(window);
  }, 150);
};

const registerMainWindowStatePersistence = (window: BrowserWindow): void => {
  window.on('move', () => scheduleMainWindowStateSave(window));
  window.on('resize', () => scheduleMainWindowStateSave(window));
  window.on('maximize', () => scheduleMainWindowStateSave(window));
  window.on('unmaximize', () => scheduleMainWindowStateSave(window));

  window.on('close', () => {
    if (pendingWindowStateSaveTimer) {
      clearTimeout(pendingWindowStateSaveTimer);
      pendingWindowStateSaveTimer = null;
    }
    persistMainWindowState(window);
  });
};

// ---------------------------------------------------------------------------
// Theme background
// ---------------------------------------------------------------------------

/** Background for the current OS theme (dark when the system prefers it). */
const windowBackground = (): string =>
  appWindowBackgroundFor(nativeTheme.shouldUseDarkColors ? 'dark' : 'light');

export function createWindow(): BrowserWindow {
  const initialWindowState = loadInitialWindowState();

  mainWindow = new BrowserWindow({
    x: initialWindowState.x,
    y: initialWindowState.y,
    width: initialWindowState.width,
    height: initialWindowState.height,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    show: false,
    autoHideMenuBar: true,
    // No flash of the wrong color before React mounts — the color follows the
    // theme and is repainted when the OS theme changes.
    backgroundColor: windowBackground(),
    title: `explainer v${packageJson.version}`,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      // Hard lock: in packaged builds DevTools cannot be created at the
      // Chromium level. Enabled in dev for debugging.
      devTools: !app.isPackaged
    }
  });

  // The window background follows the OS theme even after creation (visible
  // during resize and before paint). Released on 'closed'.
  nativeThemeUpdatedListener = (): void => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setBackgroundColor(windowBackground());
    }
  };
  nativeTheme.on('updated', nativeThemeUpdatedListener);

  mainWindow.on('ready-to-show', () => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show();
    }
  });

  registerMainWindowStatePersistence(mainWindow);

  // The main window opens links in the OS browser — with the SAME whitelist
  // as `app:open-external` (app-handlers.ts): reparse and http/https only.
  // Any other scheme (file:, javascript:, data:…) is denied silently.
  mainWindow.webContents.setWindowOpenHandler((details) => {
    try {
      const parsed = new URL(details.url);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        void shell.openExternal(parsed.toString());
      } else {
        console.warn(`[Window] ⚠️ window.open denied (protocol "${parsed.protocol}")`);
      }
    } catch {
      console.warn('[Window] ⚠️ window.open denied (invalid URL)');
    }
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    if (nativeThemeUpdatedListener) {
      nativeTheme.removeListener('updated', nativeThemeUpdatedListener);
      nativeThemeUpdatedListener = null;
    }
    mainWindow = null;
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  // HMR for the renderer based on the electron-vite CLI.
  // The catch is mandatory: without it a load failure would leave the screen
  // black with NO log at all.
  const loading =
    is.dev && process.env['ELECTRON_RENDERER_URL']
      ? mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
      : mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  loading.catch((error) => {
    console.error('[Window] ⚠️ failed to load the main window UI:', error);
  });

  return mainWindow;
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}
