/**
 * The Electron preload bridge — `window.api`.
 *
 * Only the Electron build has it: the preload script injects it before the
 * page loads. A plain browser never sees it, so the member is optional (`api?`
 * on `Window`) and `isElectron: true` is what lets the app tell the two worlds
 * apart at runtime.
 *
 * This file describes the bridge as the preload *intends* to inject it. What
 * actually arrives is whatever survived `contextBridge.exposeInMainWorld` —
 * a preload that threw halfway leaves a partial object behind, and the types
 * here cannot see that. `hasSetupBridge` in `components/SetupScreen.tsx` is
 * the runtime half of the contract, and it is the one the gate trusts.
 */

export {};

declare global {
  interface Window {
    api?: ExplainerElectronApi;
  }
}

/** Status of a key's last check against its provider. */
export type ApiKeyValidationStatus = "idle" | "valid" | "invalid";

/**
 * A persisted key. `validationStatus` is `"idle"` for a key the store has never
 * been told about — including one the user just validated in this screen, since
 * `settings:save-api-key` persists with `'idle'`
 * (`electron/main/ipc/settings-handlers.ts`). Only `"invalid"` is a statement
 * that the key is known bad.
 */
export interface ApiKeyConfig {
  key: string;
  validationStatus: ApiKeyValidationStatus;
  lastValidated?: number;
}

/** Settings persisted by the Electron main process (electron-store). */
export interface AppSettings {
  version: number;
  apiKeys: {
    openai: ApiKeyConfig;
    openaiAdmin: ApiKeyConfig;
    /** Present only since wave 3 — read it defensively, like the main does. */
    openrouter?: ApiKeyConfig;
    deepseek?: ApiKeyConfig;
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
  /** Accepts `language` and `theme` only — every other field is dropped by the
   *  Zod schema on the main side, so this is not a place to park app state. */
  set: (patch: object) => Promise<IpcResponse<AppSettings>>;
}

export interface ElectronAppApi {
  platform: string;
  /** Required, exactly as `electron/preload/index.d.ts` declares it: the
   *  preload exposes it unconditionally, so a bridge without it is a preload
   *  that broke halfway. `hasSetupBridge` refuses that bridge rather than
   *  letting this type be softened to describe the wreckage. */
  openExternal: (url: string) => Promise<IpcResponse>;
}

export interface ExplainerElectronApi {
  settings: ElectronSettingsApi;
  app: ElectronAppApi;
  isElectron: true;
}
