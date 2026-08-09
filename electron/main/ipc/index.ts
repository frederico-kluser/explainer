/**
 * IPC Handler Registry (explainer)
 *
 * Single registration point of ALL main-process IPC handlers, called once at
 * boot (`electron/main/index.ts` → app.whenReady).
 *
 * Pattern (inherited from quiet-que): invoke-only (`ipcMain.handle` — no
 * `ipcMain.on` for commands), payload validated by Zod at the boundary
 * (`ipc/validation.ts`), return envelope `{ success, data?, error? }`.
 */

import { registerSettingsHandlers } from './settings-handlers';
import { registerAppHandlers } from './app-handlers';

export function registerAllHandlers(): void {
  // Settings: settings:get / settings:save-api-key / settings:remove-api-key
  //   / settings:validate-api-key / settings:set — the OpenAI key is
  //   encrypted at rest by the store (secret-crypto).
  registerSettingsHandlers();

  // App utilities: app:open-external (http/https whitelist via Zod + protocol
  //   reparse) / app:get-platform.
  registerAppHandlers();
}
