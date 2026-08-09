/**
 * App IPC Handlers (explainer) — general window utilities.
 *
 * Today only `app:open-external` (opens a URL in the OS browser with a hard
 * protocol whitelist — http/https — validated by Zod; never accepts file:,
 * javascript:, data: or any other scheme) and `app:get-platform` (returns the
 * platform synchronously so the UI never has to deduce it from error codes).
 *
 * @module electron/main/ipc/app-handlers
 */

import { ipcMain, shell } from 'electron';
import { z } from 'zod';
import {
  createNoPayloadHandler,
  createValidatedHandler,
  isIpcValidationError
} from './validation';
import type { IpcResult } from '@shared/types/settings.types';

const OpenExternalSchema = z.object({
  url: z
    .string()
    .min(1)
    .max(2048)
    .refine((val) => !/[\0\r\n]/.test(val), { message: 'Invalid control characters' })
    .refine((val) => /^https?:\/\//i.test(val), { message: 'Only http/https URLs are allowed' })
});

function fail(error: unknown): IpcResult<never> {
  if (isIpcValidationError(error)) {
    return { success: false, error: error.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { success: false, error: message };
}

export function registerAppHandlers(): void {
  console.log('[IPC] Registering App handlers...');

  /** Opens an http/https URL in the default browser. */
  ipcMain.handle(
    'app:open-external',
    createValidatedHandler(
      'app:open-external',
      OpenExternalSchema,
      async (_event, { url }): Promise<IpcResult> => {
        try {
          // Belt and suspenders: beyond Zod, reparse and check the protocol.
          const parsed = new URL(url);
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return { success: false, error: 'Only http/https URLs are allowed' };
          }
          await shell.openExternal(parsed.toString());
          return { success: true };
        } catch (error) {
          return fail(error);
        }
      }
    )
  );

  /** The platform, as a value — the UI branches on it without deducing. */
  ipcMain.handle(
    'app:get-platform',
    createNoPayloadHandler(async (): Promise<IpcResult<string>> => {
      try {
        return { success: true, data: process.platform as string };
      } catch (error) {
        return fail(error);
      }
    })
  );

  console.log('[IPC] ✅ App handlers registered');
}
