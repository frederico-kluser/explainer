/**
 * IPC Handler Validation Utilities (quiet-que)
 *
 * Núcleo invoke-only + Zod, enxugado do electron-huu `ipc/validation.ts`:
 * wrappers de validação + os schemas compartilhados dos domínios atuais
 * (settings). Schemas específicos de cada domínio vivem no próprio arquivo
 * de handlers (padrão do electron-huu).
 *
 * @module electron/main/ipc/validation
 */

import { z } from 'zod';

// ============================================================================
// Shared schemas
// ============================================================================

/**
 * Idiomas suportados pelo app (i18n estático, sem backend).
 */
export const LanguageSetSchema = z.enum(['pt-BR', 'en']);

/**
 * Modo de tema aceito na fronteira. Espelha `AppThemeMode`
 * (`src/shared/types/theme.types.ts`) — quem resolve 'system' é o main.
 */
export const ThemeModeSchema = z.enum(['system', 'light', 'dark']);

/**
 * Status de validação de API key.
 */
export const ApiKeyValidationStatusSchema = z.enum(['idle', 'validating', 'valid', 'invalid']);

// ============================================================================
// Validation Result Types
// ============================================================================

/**
 * Result of validation
 */
export interface ValidationResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  issues?: z.ZodIssue[];
}

// ============================================================================
// Validation Utilities
// ============================================================================

/**
 * Custom error class for IPC validation errors
 */
export class IpcValidationError extends Error {
  public readonly issues?: z.ZodIssue[];
  public readonly code = 'IPC_VALIDATION_ERROR';

  constructor(message: string, issues?: z.ZodIssue[]) {
    super(message);
    this.name = 'IpcValidationError';
    this.issues = issues;

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, IpcValidationError);
    }
  }
}

/**
 * Validates payload against schema
 */
export function validatePayload<T extends z.ZodTypeAny>(
  schema: T,
  payload: unknown,
  channelName: string
): ValidationResult<z.infer<T>> {
  const result = schema.safeParse(payload);

  if (result.success) {
    return {
      success: true,
      data: result.data
    };
  }

  const issues = result.error.issues;
  const errorMessages = issues.map((issue) => {
    const path = issue.path.length > 0 ? `'${issue.path.join('.')}'` : 'payload';
    return `${path}: ${issue.message}`;
  });

  return {
    success: false,
    error: `Validation failed for ${channelName}: ${errorMessages.join('; ')}`,
    issues
  };
}

/**
 * Validates payload and throws on error
 */
export function validatePayloadOrThrow<T extends z.ZodTypeAny>(
  schema: T,
  payload: unknown,
  channelName: string
): z.infer<T> {
  const result = validatePayload(schema, payload, channelName);

  if (!result.success) {
    throw new IpcValidationError(result.error ?? 'Validation failed', result.issues);
  }

  if (result.data === undefined) {
    throw new IpcValidationError('Validation succeeded without data');
  }

  return result.data;
}

/**
 * Creates a validated handler wrapper
 *
 * @example
 * ```typescript
 * ipcMain.handle('settings:set',
 *   createValidatedHandler('settings:set', SettingsSetSchema, async (_event, patch) => {
 *     // patch is validated and typed
 *     return settingsStore.applyPatch(patch);
 *   })
 * );
 * ```
 */
export function createValidatedHandler<TSchema extends z.ZodTypeAny, TResult>(
  channelName: string,
  schema: TSchema,
  handler: (
    event: Electron.IpcMainInvokeEvent,
    payload: z.infer<TSchema>
  ) => Promise<TResult>
): (event: Electron.IpcMainInvokeEvent, payload: unknown) => Promise<TResult> {
  return async (event: Electron.IpcMainInvokeEvent, payload: unknown): Promise<TResult> => {
    let validatedPayload: z.infer<TSchema>;
    try {
      validatedPayload = validatePayloadOrThrow(schema, payload, channelName);
    } catch (error) {
      // ┌── UM HANDLER NUNCA LANÇA ────────────────────────────────────────┐
      // │ A regra dura do projeto é que todo invoke devolve o envelope     │
      // │ `{ success, error? }`. Este wrapper lançava POR FORA do try/catch│
      // │ de cada handler, então TODA falha de validação virava uma        │
      // │ `Promise` rejeitada no renderer: o ramo de erro da UI ficava     │
      // │ inalcançável e o `insight:ask` produzia unhandled rejection.     │
      // │ O erro de validação é justamente o que o usuário precisa ver.    │
      // └──────────────────────────────────────────────────────────────────┘
      if (!isIpcValidationError(error)) throw error;
      return { success: false, error: error.message } as unknown as TResult;
    }
    try {
      return await handler(event, validatedPayload);
    } catch (error) {
      // Cinto e suspensório do "um handler NUNCA lança": se a exceção escapar
      // do try/catch do PRÓPRIO handler (bug dele), ela vira envelope aqui em
      // vez de uma Promise rejeitada no renderer — que a UI não sabe exibir.
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message } as unknown as TResult;
    }
  };
}

/**
 * Wrapper para canais SEM payload (ex.: `settings:get`): ignora qualquer
 * argumento extra vindo do renderer e chama o handler.
 */
export function createNoPayloadHandler<TResult>(
  handler: (event: Electron.IpcMainInvokeEvent) => Promise<TResult>
): (event: Electron.IpcMainInvokeEvent) => Promise<TResult> {
  return async (event: Electron.IpcMainInvokeEvent): Promise<TResult> => {
    return handler(event);
  };
}

/**
 * Type guard to check if error is IpcValidationError
 */
export function isIpcValidationError(error: unknown): error is IpcValidationError {
  return error instanceof IpcValidationError;
}

// ============================================================================
// Type Exports
// ============================================================================

export type ApiKeyValidationStatus = z.infer<typeof ApiKeyValidationStatusSchema>;
