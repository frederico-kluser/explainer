/**
 * Pushes the settings store's provider keys into the backend's runtime key
 * table (`PUT /api/provider-keys/:provider`).
 *
 * Why this exists: the backend child's environment is a SNAPSHOT taken at
 * spawn (`env: { ...process.env, ... }` in `index.ts`), so keys injected into
 * the main process's env reach only a backend THIS process spawns — and only
 * if the injection lands before the spawn. A backend that was already running
 * (a dev terminal, a previous window) never sees the injected env at all: the
 * only way in is the API. So the sync runs at boot AND every time the settings
 * store records a key, and the backend's own precedence (runtime > env) makes
 * the PUT win over whatever the child inherited.
 *
 * Nothing here imports `electron`, for the same reason `backend-process.ts`
 * stays clean: the sync is provable from
 * `__tests__/provider-key-sync.test.ts` without an Electron runtime. No key is
 * ever logged — booleans and provider names only.
 *
 * @module electron/main/services/provider-key-sync
 */

import { BACKEND_HOST, BACKEND_PORT, probeBackendPort } from './backend-process';

/**
 * The backend's own provider set (`backend/src/services/providers/keys.ts`),
 * restated here because the two processes share no type: a PUT to any other
 * name answers 400. `openaiAdmin` is a store-only slot (admin-scoped billing
 * reads — the backend accepts it on no route) and is deliberately absent.
 */
const SYNCABLE_PROVIDERS: readonly string[] = ['openai', 'openrouter', 'deepseek'];

/** Where the backend answers, by default. */
const DEFAULT_BASE_URL = `http://${BACKEND_HOST}:${BACKEND_PORT}`;

export interface ProviderKeySyncOptions {
  /** Overridable so the sync is testable against a fake backend. */
  baseUrl?: string;
  /** How long to wait for the backend to answer `/api/health`. */
  readyTimeoutMs?: number;
  /** Pause between health probes. */
  pollIntervalMs?: number;
  /** Per-HTTP-request timeout. */
  requestTimeoutMs?: number;
}

type ResolvedOptions = Required<ProviderKeySyncOptions>;

const DEFAULT_OPTIONS: ResolvedOptions = {
  baseUrl: DEFAULT_BASE_URL,
  readyTimeoutMs: 15_000,
  pollIntervalMs: 500,
  requestTimeoutMs: 5_000
};

function resolveOptions(options?: ProviderKeySyncOptions): ResolvedOptions {
  return { ...DEFAULT_OPTIONS, ...options };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * True once the backend answers `/api/health` the way ours does.
 *
 * Bounded: a backend that never comes up (spawn failed, port held by a
 * stranger) must not hold the caller forever — the app works without the sync.
 */
export async function waitForBackendReady(options?: ProviderKeySyncOptions): Promise<boolean> {
  const { baseUrl, readyTimeoutMs, pollIntervalMs } = resolveOptions(options);
  const { hostname, port } = new URL(baseUrl);
  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline) {
    if ((await probeBackendPort(Number(port), 600, hostname)) === 'backend-alive') return true;
    await sleep(pollIntervalMs);
  }
  return false;
}

/**
 * One `PUT /api/provider-keys/:provider`. Never throws — a refused or
 * unreachable backend is a logged false, not a crash.
 */
export async function putProviderKeyToBackend(
  provider: string,
  key: string,
  options?: ProviderKeySyncOptions
): Promise<boolean> {
  try {
    const { baseUrl, requestTimeoutMs } = resolveOptions(options);
    const response = await fetch(`${baseUrl}/api/provider-keys/${provider}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key }),
      signal: AbortSignal.timeout(requestTimeoutMs)
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * One `DELETE /api/provider-keys/:provider` — forgets the RUNTIME key in a
 * reused backend after the user removes it from the store. Best effort, same
 * contract as the PUT.
 */
export async function deleteProviderKeyFromBackend(
  provider: string,
  options?: ProviderKeySyncOptions
): Promise<boolean> {
  if (!SYNCABLE_PROVIDERS.includes(provider)) return false;
  try {
    const { baseUrl, requestTimeoutMs } = resolveOptions(options);
    const response = await fetch(`${baseUrl}/api/provider-keys/${provider}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(requestTimeoutMs)
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Waits for the backend, then PUTs ONE key. Fire-and-forget from the IPC
 * handlers: a save must not wait on the backend. Logs booleans only.
 */
export async function syncProviderKeyToBackend(
  provider: string,
  key: string,
  options?: ProviderKeySyncOptions
): Promise<boolean> {
  if (!SYNCABLE_PROVIDERS.includes(provider)) return false;
  const trimmed = key.trim();
  if (!trimmed) return false;

  if (!(await waitForBackendReady(options))) {
    console.warn(
      `[ProviderKeySync] ⚠️ backend not answering — key of ${provider} NOT synced ` +
        '(a backend this process spawns still inherits it via the env)'
    );
    return false;
  }
  const ok = await putProviderKeyToBackend(provider, trimmed, options);
  if (!ok) {
    console.warn(`[ProviderKeySync] ⚠️ backend refused the key of ${provider}`);
  }
  return ok;
}

export interface ProviderKeySyncResult {
  /** Providers whose key the backend accepted. */
  synced: string[];
  /** Providers whose key never reached the backend. */
  failed: string[];
}

/**
 * Boot-time sync: PUTs every non-empty stored key once the backend answers.
 *
 * Skips empty keys and store-only providers (`openaiAdmin`). An unreachable
 * backend is a logged warning, never a boot failure — the window works, and
 * the setup screen PUTs on every save anyway.
 */
export async function syncStoredKeysToBackend(
  stored: Readonly<Record<string, { key: string }>>,
  options?: ProviderKeySyncOptions
): Promise<ProviderKeySyncResult> {
  const targets = SYNCABLE_PROVIDERS.filter((provider) => !!stored[provider]?.key?.trim());
  if (targets.length === 0) return { synced: [], failed: [] };

  if (!(await waitForBackendReady(options))) {
    console.warn(
      `[ProviderKeySync] ⚠️ backend never answered /api/health — ${targets.join(', ')} ` +
        'not synced (a spawned backend still inherits them via the env)'
    );
    return { synced: [], failed: [...targets] };
  }

  const synced: string[] = [];
  const failed: string[] = [];
  for (const provider of targets) {
    if (await putProviderKeyToBackend(provider, stored[provider]!.key.trim(), options)) {
      synced.push(provider);
    } else {
      failed.push(provider);
      console.warn(`[ProviderKeySync] ⚠️ backend refused the key of ${provider}`);
    }
  }
  if (synced.length > 0) {
    console.info(`[ProviderKeySync] keys synced to the backend: ${synced.join(', ')}`);
  }
  return { synced, failed };
}
