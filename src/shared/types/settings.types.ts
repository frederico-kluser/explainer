/**
 * Shared types main ↔ preload ↔ renderer (explainer).
 *
 * The renderer never imports from the main process: these types are the only
 * boundary.
 *
 * @module shared/types/settings.types
 */

import type { AppThemeMode } from './theme.types';

/** Status of an API key validation against the provider. */
export type ApiKeyValidationStatus = 'idle' | 'valid' | 'invalid';

/** Supported languages (static i18n pt-BR + en). */
export type AppLanguage = 'pt-BR' | 'en';

/** Persisted configuration of a single API key. */
export interface ApiKeyConfig {
  key: string;
  validationStatus: ApiKeyValidationStatus;
  lastValidated?: number;
}

/**
 * Renderer-safe view of the app settings. The main process may store extra
 * fields in settings.json; this is what crosses the IPC boundary.
 */
export interface AppSettings {
  version: number;
  apiKeys: Record<string, ApiKeyConfig>;
  language: AppLanguage;
  theme: AppThemeMode;
  updatedAt: number;
}

/** Providers the settings store recognises and persists. */
export type KnownProvider = 'openai' | 'openaiAdmin';

/** Envelope returned by every IPC handler — handlers never throw. */
export interface IpcResult<T = undefined> {
  success: boolean;
  data?: T;
  error?: string;
}
