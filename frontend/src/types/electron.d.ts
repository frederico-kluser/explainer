/**
 * The Electron preload bridge — `window.api`.
 *
 * Only the Electron build has it: the preload script injects it before the
 * page loads. A plain browser never sees it, so the member is optional (`api?`
 * on `Window`) and `isElectron: true` is what lets the app tell the two worlds
 * apart at runtime.
 */

export {};

declare global {
  interface Window {
    api?: ExplainerElectronApi;
  }
}

/** Settings persisted by the Electron main process (electron-store). */
export interface AppSettings {
  version: number;
  apiKeys: {
    openai: { key: string; validationStatus: "idle" | "valid" | "invalid" };
    openaiAdmin: { key: string; validationStatus: "idle" | "valid" | "invalid" };
  };
  language: "pt-BR" | "en";
  theme: "light" | "dark" | "system";
  updatedAt: number;
}

/** Outcome of an IPC round-trip; `data` is present only when the call worked. */
export interface IpcResponse<T = undefined> {
  success: boolean;
  data?: T;
  error?: string;
}

/** Result of checking an API key against its provider. */
export interface ApiKeyValidation {
  valid: boolean;
  error?: string;
}

export interface ElectronSettingsApi {
  get: () => Promise<IpcResponse<AppSettings>>;
  saveApiKey: (key: string, provider?: string) => Promise<IpcResponse>;
  removeApiKey: (provider?: string) => Promise<IpcResponse>;
  validateApiKey: (
    key: string,
    provider?: string,
  ) => Promise<IpcResponse<ApiKeyValidation>>;
  set: (patch: object) => Promise<IpcResponse<AppSettings>>;
}

export interface ElectronAppApi {
  platform: string;
  openExternal: (url: string) => Promise<IpcResponse>;
}

export interface ExplainerElectronApi {
  settings: ElectronSettingsApi;
  app: ElectronAppApi;
  isElectron: true;
}
