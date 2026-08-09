import { contextBridge, ipcRenderer } from 'electron';
import { electronAPI } from '@electron-toolkit/preload';

/**
 * Preload bridge (explainer) — contextBridge.invoke-only, quiet-que pattern.
 *
 * The renderer talks to the main ONLY through here (`window.api.*`); every
 * channel has Zod validation on the main side and returns the
 * `{ success, data?, error? }` envelope. `window.api.isElectron` lets the same
 * frontend bundle run in a plain browser (dev) or inside Electron.
 */

const api = {
  settings: {
    /** Loads the complete settings (key in plaintext for the user's own UI). */
    get: () => ipcRenderer.invoke('settings:get'),
    /** Saves an API key (encrypted on disk by the main). */
    saveApiKey: (key: string, provider?: string) =>
      ipcRenderer.invoke('settings:save-api-key', { key, provider: provider ?? 'openai' }),
    /** Removes the API key of a provider. */
    removeApiKey: (provider?: string) =>
      ipcRenderer.invoke('settings:remove-api-key', { provider: provider ?? 'openai' }),
    /** Validates the key against the provider (does not persist). */
    validateApiKey: (key: string, provider?: string) =>
      ipcRenderer.invoke('settings:validate-api-key', { key, provider: provider ?? 'openai' }),
    /** Partial patch: theme / language. */
    set: (patch: Record<string, unknown>) => ipcRenderer.invoke('settings:set', patch)
  },
  app: {
    /** The platform, synchronous — the UI branches on it without deducing. */
    platform: process.platform as string,
    /** Opens an http/https URL in the OS browser. */
    openExternal: (url: string) => ipcRenderer.invoke('app:open-external', { url })
  },
  // Whether we are running inside Electron (truthy) or in a browser (falsy).
  isElectron: true
};

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI);
    contextBridge.exposeInMainWorld('api', api);
  } catch (error) {
    console.error(error);
  }
} else {
  // @ts-expect-error fallback without context isolation (dev tooling)
  window.electron = electronAPI;
  // @ts-expect-error fallback without context isolation (dev tooling)
  window.api = api;
}
