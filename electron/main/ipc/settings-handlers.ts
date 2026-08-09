/**
 * Settings IPC Handlers (explainer)
 *
 * Invoke-only channels, ALL validated by Zod at the boundary and ALL returning
 * the `{ success, data?, error? }` envelope — a settings handler NEVER throws
 * (neither validation errors nor store/network errors).
 *
 * API keys never travel in plaintext to the DISK (the store encrypts via
 * secret-crypto); between renderer ↔ main they travel in the invoke payload,
 * as in quiet-que.
 */

import { ipcMain } from 'electron';
import { z } from 'zod';
import { settingsStore } from '../storage/settings-store';
import {
  deleteProviderKeyFromBackend,
  syncProviderKeyToBackend
} from '../services/provider-key-sync';
import {
  createNoPayloadHandler,
  createValidatedHandler,
  isIpcValidationError,
  LanguageSetSchema,
  ThemeModeSchema
} from './validation';
import type { AppSettings, IpcResult } from '@shared/types/settings.types';

// ============================================================================
// Payload schemas (IPC boundary — content validation, not only shape)
// ============================================================================

/** API key providers known to the store. */
const ApiKeyProviderSchema = z.enum(['openai', 'openaiAdmin', 'openrouter', 'deepseek']);

const ApiKeyPayloadSchema = z.object({
  key: z
    .string()
    .min(1, 'A chave é obrigatória')
    .max(512, 'A chave é longa demais')
    .refine((val) => val.trim().length > 0, { message: 'A chave não pode ser só espaços' })
    .refine((val) => !/[\0\r\n]/.test(val), { message: 'Caracteres de controle inválidos' }),
  /** Provider of the key (omitted → 'openai', compatible with old clients). */
  provider: ApiKeyProviderSchema.optional()
});

const RemoveApiKeyPayloadSchema = z
  .object({ provider: ApiKeyProviderSchema.optional() })
  .default({});

const SettingsSetSchema = z
  .object({
    language: LanguageSetSchema.optional(),
    theme: ThemeModeSchema.optional()
  })
  .refine((patch) => Object.values(patch).some((v) => v !== undefined), {
    message: 'Informe pelo menos um campo'
  });

/** Result of validating an API key against its provider (never persisted). */
interface ApiKeyValidationResult {
  valid: boolean;
  error?: string;
}

const VALIDATION_TIMEOUT_MS = 10_000;

/**
 * Providers whose key can be checked against a public models endpoint.
 * DeepSeek has an equivalent endpoint but the setup screen never asks for its
 * key — validation stays scoped to what the UI collects.
 */
const VALIDATION_ENDPOINTS: Readonly<Record<string, { url: string; name: string }>> = {
  openai: { url: 'https://api.openai.com/v1/models', name: 'OpenAI' },
  openrouter: { url: 'https://openrouter.ai/api/v1/models', name: 'OpenRouter' }
};

/**
 * Validates a provider key by listing the models endpoint. Does NOT persist
 * anything — it only queries the provider.
 */
async function validateProviderKey(
  key: string,
  provider: string
): Promise<ApiKeyValidationResult> {
  const endpoint = VALIDATION_ENDPOINTS[provider];
  if (!endpoint) {
    return { valid: false, error: 'A validação não está disponível para este provedor.' };
  }
  const { url, name } = endpoint;
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS)
    });
    if (response.ok) return { valid: true };
    const statusDetail =
      response.status === 401 || response.status === 403
        ? 'chave rejeitada'
        : `a ${name} não pôde validar a chave agora (HTTP ${response.status})`;
    return { valid: false, error: `${name}: ${statusDetail}` };
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      return { valid: false, error: `A ${name} não respondeu a tempo` };
    }
    const detail = error instanceof Error ? error.message : String(error);
    return { valid: false, error: `Não foi possível contatar a ${name}: ${detail}` };
  }
}

// ============================================================================
// Envelope helpers — every handler returns IpcResult, never throws
// ============================================================================

function ok<T>(data: T): IpcResult<T> {
  return { success: true, data };
}

function fail(error: unknown): IpcResult<never> {
  if (isIpcValidationError(error)) {
    return { success: false, error: error.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { success: false, error: message };
}

/**
 * Registers all settings IPC handlers.
 */
export function registerSettingsHandlers(): void {
  console.log('[IPC] Registering Settings handlers...');

  /**
   * Loads the settings (key in plaintext for the user's own UI).
   */
  ipcMain.handle(
    'settings:get',
    createNoPayloadHandler(async (): Promise<IpcResult<AppSettings>> => {
      try {
        return ok(await settingsStore.load());
      } catch (error) {
        return fail(error);
      }
    })
  );

  /**
   * Saves the API key of a provider (encrypted on disk by the store).
   */
  ipcMain.handle(
    'settings:save-api-key',
    createValidatedHandler(
      'settings:save-api-key',
      ApiKeyPayloadSchema,
      async (_event, { key, provider }): Promise<IpcResult> => {
        try {
          const target = provider ?? 'openai';
          const trimmed = key.trim();
          const saved = await settingsStore.saveApiKey(target, trimmed, 'idle');
          if (!saved) {
            // The real cause goes to the store log; here stays the trace that
            // THIS invoke returned the generic error (the envelope carries no
            // detail).
            console.warn(`[Settings] ⚠️ save-api-key refused by the store (${target})`);
          } else {
            // The backend child's env froze at spawn; a key saved after boot
            // reaches it only over the API. Best effort and fire-and-forget —
            // a failure degrades to "the next boot injects it", never to a
            // blocked save.
            void syncProviderKeyToBackend(target, trimmed);
          }
          return saved ? ok(undefined) : { success: false, error: 'Não foi possível salvar a chave' };
        } catch (error) {
          return fail(error);
        }
      }
    )
  );

  /**
   * Removes the API key of a provider (optional payload: { provider }).
   */
  ipcMain.handle(
    'settings:remove-api-key',
    createValidatedHandler(
      'settings:remove-api-key',
      RemoveApiKeyPayloadSchema,
      async (_event, { provider }): Promise<IpcResult> => {
        try {
          const target = provider ?? 'openai';
          const removed = await settingsStore.removeApiKey(target);
          if (!removed) {
            // Same rule as save: the cause stays in the store log.
            console.warn(`[Settings] ⚠️ remove-api-key refused by the store (${target})`);
          } else {
            // The counterpart of the save-side sync: a reused backend keeps
            // the runtime key until it is told otherwise. Best effort.
            void deleteProviderKeyFromBackend(target);
          }
          return removed ? ok(undefined) : { success: false, error: 'Não foi possível remover a chave' };
        } catch (error) {
          return fail(error);
        }
      }
    )
  );

  /**
   * Validates an API key against its provider (GET /v1/models on the
   * provider's own endpoint). Does NOT persist anything — it only queries the
   * provider.
   */
  ipcMain.handle(
    'settings:validate-api-key',
    createValidatedHandler(
      'settings:validate-api-key',
      ApiKeyPayloadSchema,
      async (_event, { key, provider }): Promise<IpcResult<ApiKeyValidationResult>> => {
        try {
          return ok(await validateProviderKey(key.trim(), provider ?? 'openai'));
        } catch (error) {
          return fail(error);
        }
      }
    )
  );

  /**
   * Applies a partial patch: language / theme. Returns the complete, already
   * normalized settings.
   */
  ipcMain.handle(
    'settings:set',
    createValidatedHandler(
      'settings:set',
      SettingsSetSchema,
      async (_event, patch): Promise<IpcResult<AppSettings>> => {
        try {
          return ok(await settingsStore.applyPatch(patch));
        } catch (error) {
          return fail(error);
        }
      }
    )
  );

  console.log('[IPC] ✅ Settings handlers registered');
}
