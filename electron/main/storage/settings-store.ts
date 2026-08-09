/**
 * Settings Store - Main Process (explainer)
 *
 * Persistence of app settings via electron-store, simplified from the
 * quiet-que `storage/settings-store.ts`: FOUR API key provider slots
 * ('openai', 'openaiAdmin', 'openrouter', 'deepseek'), plus language and
 * theme. No other settings exist yet.
 *
 * electron-store persists in (Linux): ~/.config/explainer/settings.json
 *
 * GOLDEN RULE (inherited from quiet-que): the API key NEVER sits in plaintext
 * in settings.json — it is encrypted at the persistence boundary via
 * secret-crypto (OS safeStorage, with an AES-256-GCM fallback derived from the
 * machine id). Callers always see plaintext in memory; the cipher happens only
 * at the persistence boundary.
 *
 * IMPORTANT: do NOT use the electron-store `schema` option (v10 has
 * `clearInvalidConfig: true` by default — a new schema can wipe the whole
 * settings.json and LOSE the user's key). Validation/migration is done by
 * `normalizeSettings()` on every read/write.
 */

import type Store from 'electron-store';
import { encryptSecret, decryptSecret, isEncryptedSecret } from '../services/secret-crypto';
import { DEFAULT_THEME_MODE, isAppThemeMode } from '@shared/utils/theme.utils';
import type { AppThemeMode } from '@shared/types/theme.types';
import type {
  ApiKeyConfig,
  ApiKeyValidationStatus,
  AppLanguage,
  AppSettings
} from '@shared/types/settings.types';

// Electron-store typings omit some runtime properties; extend for clarity
type ElectronStoreInstance<T extends Record<string, unknown>> = Store<T> & {
  path: string;
  size: number;
  clear(): void;
  get<K extends keyof T>(key: K): T[K];
  set<K extends keyof T>(key: K, value: T[K]): void;
};

/**
 * electron-store schema (type alias — interfaces don't get an implicit index
 * signature and wouldn't satisfy the Record<string, unknown> constraint).
 */
type SettingsStoreSchema = {
  settings: AppSettings;
};

/** Current schema version (1 is the first released shape). */
export const CURRENT_SETTINGS_VERSION = 1;

export const DEFAULT_LANGUAGE: AppLanguage = 'pt-BR';
/** Default theme: follow the OS (resolved in the main via nativeTheme). */
export const DEFAULT_THEME: AppThemeMode = DEFAULT_THEME_MODE;

/**
 * The API key providers the app persists. Everything else in the apiKeys
 * record is dropped on save (whitelist normalize) — keeping the list closed
 * keeps the store honest. `openaiAdmin` is the admin-scoped billing slot;
 * `openrouter` and `deepseek` are the other two calling providers the backend
 * accepts (`backend/src/services/providers/keys.ts`).
 */
const DEFAULT_API_KEYS: AppSettings['apiKeys'] = {
  openai: { key: '', validationStatus: 'idle' },
  openaiAdmin: { key: '', validationStatus: 'idle' },
  openrouter: { key: '', validationStatus: 'idle' },
  deepseek: { key: '', validationStatus: 'idle' }
};

const DEFAULT_SETTINGS: AppSettings = {
  version: CURRENT_SETTINGS_VERSION,
  apiKeys: DEFAULT_API_KEYS,
  language: DEFAULT_LANGUAGE,
  theme: DEFAULT_THEME,
  updatedAt: Date.now()
};

const VALID_LANGUAGES: readonly AppLanguage[] = ['pt-BR', 'en'];

/** Partial patch accepted by the `settings:set` channel (theme/language only). */
export interface SettingsPatch {
  language?: AppLanguage;
  theme?: AppThemeMode;
}

/**
 * Normalizes settings guaranteeing the latest structure. Non-destructive
 * migration: preserves the existing key and fills defaults.
 */
const normalizeSettings = (settings?: AppSettings): AppSettings => {
  const source = settings ? { ...settings } : { ...DEFAULT_SETTINGS, updatedAt: Date.now() };

  // Non-destructive per-provider migration: preserves the existing key and
  // fills defaults. Whitelist by construction: a provider not in
  // DEFAULT_API_KEYS is dropped on the first save.
  const normalizedApiKeys = {} as AppSettings['apiKeys'];
  for (const provider of Object.keys(DEFAULT_API_KEYS)) {
    normalizedApiKeys[provider] = source.apiKeys?.[provider]
      ? { ...DEFAULT_API_KEYS[provider], ...source.apiKeys[provider] }
      : { ...DEFAULT_API_KEYS[provider] };
  }

  const language: AppLanguage =
    source.language && VALID_LANGUAGES.includes(source.language) ? source.language : DEFAULT_LANGUAGE;

  const theme: AppThemeMode = isAppThemeMode(source.theme) ? source.theme : DEFAULT_THEME;

  return {
    version: CURRENT_SETTINGS_VERSION,
    updatedAt: source.updatedAt ?? Date.now(),
    apiKeys: normalizedApiKeys,
    language,
    theme
  };
};

/**
 * Encrypted blobs the last load() could NOT decrypt (e.g. OS keyring
 * temporarily unavailable). While the caller keeps the key empty, save()
 * rewrites the ORIGINAL blob instead of '' — otherwise any later save()
 * (settings:set for language/theme) would DESTROY the encrypted key on disk,
 * losing it forever when the keyring comes back. Replaced on every load(); a
 * new (non-empty) key or an explicit removeApiKey() ends the preservation for
 * that provider.
 */
let undecryptableKeyBlobs: Map<string, string> = new Map();

/**
 * Returns a copy of apiKeys with every non-empty key encrypted for the disk.
 * Idempotent (does not re-encrypt an already-encrypted value). An EMPTY key
 * whose last load() failed to decrypt rewrites the original encrypted blob
 * (preservation above).
 */
function encryptApiKeys(apiKeys: AppSettings['apiKeys']): AppSettings['apiKeys'] {
  const out = {} as AppSettings['apiKeys'];
  for (const provider of Object.keys(apiKeys)) {
    const cfg = apiKeys[provider];
    if (!cfg.key) {
      out[provider] = { ...cfg, key: undecryptableKeyBlobs.get(provider) ?? '' };
      continue;
    }
    // New key set by the caller → replaces any preserved blob.
    undecryptableKeyBlobs.delete(provider);
    try {
      out[provider] = { ...cfg, key: encryptSecret(cfg.key) };
    } catch (error) {
      // Encrypting FAILED (no OS keyring and no readable machine id). Writing
      // the key in the clear would trade one problem for a worse one, and
      // failing the whole save would block the user from changing the theme.
      // So the key is not persisted — it keeps working THIS session, in
      // memory, and the UI asks again on the next boot.
      console.error(
        `[SettingsStore] ❌ could not encrypt the key of ${provider} — NOT persisted:`,
        error
      );
      out[provider] = { ...cfg, key: '' };
    }
  }
  return out;
}

/**
 * Returns a copy with every key decrypted (plaintext for callers) plus the
 * encrypted blobs of keys whose decrypt FAILED (for the save-time
 * preservation — see `undecryptableKeyBlobs`). Legacy plaintext (no sentinel)
 * passes through. A decrypt failure drops only that key in memory (requires
 * re-entry) — never throws, never wipes settings or the blob on disk.
 */
function decryptApiKeys(apiKeys: AppSettings['apiKeys']): {
  decrypted: AppSettings['apiKeys'];
  failedBlobs: Map<string, string>;
} {
  const out = {} as AppSettings['apiKeys'];
  const failedBlobs = new Map<string, string>();
  for (const provider of Object.keys(apiKeys)) {
    const cfg = apiKeys[provider];
    if (!cfg.key) {
      out[provider] = { ...cfg, key: '' };
      continue;
    }
    try {
      out[provider] = { ...cfg, key: decryptSecret(cfg.key) };
    } catch (error) {
      console.warn(
        `[SettingsStore] ⚠️ failed to decrypt the key of ${provider} — key absent in memory until re-entry (encrypted blob preserved on disk)`,
        error
      );
      out[provider] = { key: '', validationStatus: 'idle' };
      failedBlobs.set(provider, cfg.key);
    }
  }
  return { decrypted: out, failedBlobs };
}

/** True if some persisted key is legacy plaintext (needs re-encryption). */
function hasLegacyPlaintextKey(apiKeys: AppSettings['apiKeys']): boolean {
  return Object.values(apiKeys).some((c) => !!c.key && !isEncryptedSecret(c.key));
}

/**
 * Memoized promise of the electron-store instance (dynamically imported).
 * Memoizing the PROMISE (not the instance) makes parallel load()s during boot
 * share ONE initialization — before, two concurrent callers passed through the
 * still-null `if (store)` and created 2 electron-stores.
 */
let storePromise: Promise<ElectronStoreInstance<SettingsStoreSchema>> | null = null;

/**
 * Initializes electron-store with a dynamic import (ESM-only module).
 */
async function getStore(): Promise<ElectronStoreInstance<SettingsStoreSchema>> {
  if (!storePromise) {
    storePromise = (async () => {
      const { default: Store } = await import('electron-store');

      const instance = new Store<SettingsStoreSchema>({
        name: 'settings',
        clearInvalidConfig: false,
        defaults: {
          settings: DEFAULT_SETTINGS
        }
      }) as ElectronStoreInstance<SettingsStoreSchema>;

      console.log(`[SettingsStore] 📁 Persistence file: ${instance.path}`);

      return instance;
    })().catch((error) => {
      // Init failed → reset the promise so the next call retries.
      storePromise = null;
      throw error;
    });
  }
  return storePromise;
}

/**
 * Mutex of the read-modify-write mutations (applyPatch / saveApiKey /
 * removeApiKey): each waits for the previous one to finish. Without this, two
 * concurrent patches (e.g. a fire-and-forget and a settings:set) would read
 * the SAME disk state and the second save() would wipe the first patch.
 */
let mutationChain: Promise<unknown> = Promise.resolve();

function enqueueMutation<T>(fn: () => Promise<T>): Promise<T> {
  const result = mutationChain.then(fn);
  // The chain never rejects (otherwise one failed mutation would block all the
  // following ones); the rejection still goes to the caller via `result`.
  mutationChain = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

/**
 * Original cause of the last failed save(). save() logs it immediately, but
 * applyPatch needs it for the warn of the ABORT to tell the full story — the
 * IPC handler returns only the generic message to the renderer (no secret in
 * the envelope).
 */
let lastSaveError: unknown = null;

/** Signature of the last LOGGED load(). */
let lastLoadSignature: string | null = null;

/**
 * Settings Store Service (Main Process)
 */
export const settingsStore = {
  /**
   * Saves the complete settings.
   */
  async save(settings: AppSettings): Promise<boolean> {
    try {
      const store = await getStore();

      const normalizedSettings = normalizeSettings(settings);
      // Callers always hold plaintext keys; encrypt at rest before persisting.
      const settingsToSave: AppSettings = {
        ...normalizedSettings,
        apiKeys: encryptApiKeys(normalizedSettings.apiKeys),
        updatedAt: Date.now()
      };

      store.set('settings', settingsToSave);

      console.log('[SettingsStore] ✅ Settings saved', {
        providersWithKey: Object.entries(settingsToSave.apiKeys)
          .filter(([, cfg]) => cfg.key !== '')
          .map(([provider]) => provider),
        language: settingsToSave.language
      });

      lastSaveError = null;
      return true;
    } catch (error) {
      // The ORIGINAL cause goes to the log here — the boolean return is the
      // contract, but "why" can never get lost (applyPatch relays the same
      // cause in the abort warn, via `lastSaveError`).
      lastSaveError = error;
      console.error('[SettingsStore] ❌ Error saving:', error);
      return false;
    }
  },

  /**
   * Loads the settings (keys in plaintext for the caller).
   */
  async load(): Promise<AppSettings> {
    try {
      const store = await getStore();
      const rawSettings = store.get('settings');

      if (!rawSettings) {
        console.log('[SettingsStore] ℹ️ No saved settings, returning defaults');
        return DEFAULT_SETTINGS;
      }

      const normalizedSettings = normalizeSettings(rawSettings);
      const { decrypted: decryptedApiKeys, failedBlobs } = decryptApiKeys(
        normalizedSettings.apiKeys
      );
      // Rebuilds the preservation registry from what is ON DISK now (a load
      // that decrypts again clears the previous failure).
      undecryptableKeyBlobs = failedBlobs;
      const result: AppSettings = { ...normalizedSettings, apiKeys: decryptedApiKeys };

      const needsRepersist =
        rawSettings.version !== CURRENT_SETTINGS_VERSION ||
        hasLegacyPlaintextKey(normalizedSettings.apiKeys);

      if (needsRepersist) {
        // One-time, non-destructive: re-persist normalized + encrypted.
        store.set('settings', {
          ...normalizedSettings,
          apiKeys: encryptApiKeys(decryptedApiKeys)
        });
      }

      const providersWithKey = Object.entries(decryptedApiKeys)
        .filter(([, cfg]) => cfg.key !== '')
        .map(([provider]) => provider);
      const signature = `${providersWithKey.join(',')}|${result.language}|${result.theme}`;
      if (signature !== lastLoadSignature) {
        lastLoadSignature = signature;
        console.log('[SettingsStore] ✅ Settings loaded', {
          providersWithKey,
          language: result.language
        });
      }

      return result;
    } catch (error) {
      console.error('[SettingsStore] ❌ Error loading:', error);
      return DEFAULT_SETTINGS;
    }
  },

  /**
   * Saves a single API key.
   */
  async saveApiKey(
    provider: string,
    key: string,
    validationStatus: ApiKeyValidationStatus = 'idle'
  ): Promise<boolean> {
    // Serialized with the other read-modify-writes (see `enqueueMutation`).
    return enqueueMutation(async () => {
      try {
        const settings = await this.load();

        settings.apiKeys[provider] = {
          key,
          validationStatus,
          lastValidated: validationStatus === 'valid' ? Date.now() : undefined
        };

        return await this.save(settings);
      } catch (error) {
        console.error(`[SettingsStore] ❌ Error saving the key of ${provider}:`, error);
        return false;
      }
    });
  },

  /**
   * Removes an API key.
   */
  async removeApiKey(provider: string): Promise<boolean> {
    // Serialized with the other read-modify-writes (see `enqueueMutation`).
    return enqueueMutation(async () => {
      try {
        const settings = await this.load();

        // EXPLICIT removal: the user asked to delete — do not preserve the
        // encrypted blob of a previous decrypt failure (otherwise the removal
        // would be silently ignored while the keyring is absent).
        undecryptableKeyBlobs.delete(provider);

        settings.apiKeys[provider] = {
          key: '',
          validationStatus: 'idle'
        };

        return await this.save(settings);
      } catch (error) {
        console.error(`[SettingsStore] ❌ Error removing the key of ${provider}:`, error);
        return false;
      }
    });
  },

  /**
   * Gets a specific API key (plaintext; '' if absent).
   */
  async getApiKey(provider: string): Promise<string> {
    try {
      const settings = await this.load();
      return settings.apiKeys[provider]?.key || '';
    } catch (error) {
      console.error(`[SettingsStore] ❌ Error getting the key of ${provider}:`, error);
      return '';
    }
  },

  /**
   * Applies a partial patch (language / theme). Throws if save() fails — the
   * IPC handler converts it into `{ success: false, error }`.
   *
   * Serialized by `enqueueMutation`: a load→merge→save without the mutex
   * loses concurrent patches.
   */
  async applyPatch(patch: SettingsPatch): Promise<AppSettings> {
    return enqueueMutation(async () => {
      const current = await this.load();
      const next: AppSettings = {
        ...current,
        ...(patch.language ? { language: patch.language } : {}),
        ...(isAppThemeMode(patch.theme) ? { theme: patch.theme } : {})
      };
      const saved = await this.save(next);
      if (!saved) {
        // save() swallows the error and returns false — propagate so the IPC
        // handler doesn't report success. The ORIGINAL cause stays in the log
        // (save() already logged it; this warn ties it to the ABORT of the
        // patch) — the renderer gets only the generic message, no secret in
        // the envelope.
        console.warn('[SettingsStore] ⚠️ applyPatch aborted — save() failed. Cause:', lastSaveError);
        throw new Error('Failed to save settings');
      }
      return this.load();
    });
  },

  /**
   * Gets the path of the settings file.
   */
  async getStoragePath(): Promise<string> {
    const store = await getStore();
    return store.path;
  },

  /**
   * Clears all settings.
   */
  async clear(): Promise<boolean> {
    try {
      const store = await getStore();
      store.clear();
      return true;
    } catch (error) {
      console.error('[SettingsStore] ❌ Error clearing:', error);
      return false;
    }
  }
};

// Re-export the type used by handlers (keeps the @shared import single).
export type { ApiKeyConfig };
