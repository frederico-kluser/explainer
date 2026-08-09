/**
 * Secret Crypto — shared at-rest encryption primitives (MAIN PROCESS)
 *
 * Single implementation used by both `auth-storage.service.ts` (Firebase auth
 * tokens) and `settings-store.ts` (BYO LLM API keys). Encrypts via the OS
 * credential store (Electron `safeStorage`: Keychain/DPAPI/Secret Service);
 * when no keyring daemon is available (e.g. Linux tiling WMs) it falls back to
 * AES-256-GCM with a machine-id-derived key — not as strong as an OS keyring,
 * but it avoids plaintext at rest.
 *
 * Two layers:
 *  - Buffer-level: `fallbackEncrypt`/`fallbackDecrypt`/`shouldUseFallback`
 *    (used by auth-storage which writes raw encrypted files).
 *  - String-level: `encryptSecret`/`decryptSecret` — produce a single
 *    self-describing string (`enc:v1:<backend>:<base64>`) safe to store inside
 *    a JSON value (used by settings-store for per-key encryption).
 */

import { safeStorage } from 'electron';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as child_process from 'child_process';

/**
 * The stable per-machine identifier the fallback key is derived from.
 *
 * ┌── WHY THERE IS NO DEFAULT ANY MORE ──────────────────────────────────────┐
 * │ This used to fall back to the literal 'ondokai-fallback-machine-id' when │
 * │ no id could be read — and only Linux paths were ever tried. On Windows   │
 * │ and macOS that literal was ALWAYS the answer, which means one constant   │
 * │ AES key, compiled into the shipped binary, protecting every user's API   │
 * │ key on every machine. Dormant while DPAPI/Keychain work; live the moment │
 * │ they do not (locked-down profiles, VDI). Returning `null` instead makes  │
 * │ the caller refuse to encrypt rather than pretend to.                     │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Exported for testing; each platform reads the id the OS itself considers
 * stable across reboots and reinstalls of the app.
 */
export function readMachineId(): string | null {
  try {
    if (process.platform === 'win32') {
      // MachineGuid: written by Windows at install time, stable across reboots.
      const out = child_process.execFileSync(
        'reg',
        [
          'query',
          'HKLM\\SOFTWARE\\Microsoft\\Cryptography',
          '/v',
          'MachineGuid',
          '/reg:64'
        ],
        { encoding: 'utf8', timeout: 5000, windowsHide: true }
      );
      const match = /MachineGuid\s+REG_SZ\s+(\S+)/i.exec(out);
      return match ? match[1] : null;
    }
    if (process.platform === 'darwin') {
      const out = child_process.execFileSync(
        'ioreg',
        ['-rd1', '-c', 'IOPlatformExpertDevice'],
        { encoding: 'utf8', timeout: 5000 }
      );
      const match = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out);
      return match ? match[1] : null;
    }
    if (fs.existsSync('/etc/machine-id')) {
      return fs.readFileSync('/etc/machine-id', 'utf8').trim() || null;
    }
    if (fs.existsSync('/var/lib/dbus/machine-id')) {
      return fs.readFileSync('/var/lib/dbus/machine-id', 'utf8').trim() || null;
    }
  } catch {
    // Unreadable id — the caller must refuse, never guess.
  }
  return null;
}

/**
 * AES-256-GCM fallback key, derived from the stable machine-id + app salt.
 * Reused across auth-storage and settings-store so a single keyring/fallback
 * decision covers all secrets on the machine.
 *
 * THROWS when no machine id can be read. That is deliberate: a key that is the
 * same on every machine is worse than no encryption, because it looks like
 * encryption. Callers already treat an encryption failure as "do not persist".
 */
export function getFallbackKey(): Buffer {
  const machineId = readMachineId();
  if (!machineId) {
    throw new Error(
      'SECRET_CRYPTO_NO_MACHINE_ID: refusing to derive a shared fallback key'
    );
  }
  return crypto.scryptSync(machineId, 'ondokai-auth-storage-salt-v1', 32);
}

/** AES-256-GCM encrypt → [16B IV][16B authTag][ciphertext] */
export function fallbackEncrypt(plaintext: string): Buffer {
  const key = getFallbackKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]);
}

/** AES-256-GCM decrypt of a buffer produced by {@link fallbackEncrypt} */
export function fallbackDecrypt(data: Buffer): string {
  const key = getFallbackKey();
  const iv = data.subarray(0, 16);
  const authTag = data.subarray(16, 32);
  const encrypted = data.subarray(32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(encrypted) + decipher.final('utf8');
}

/** True when the OS keyring is unavailable and the AES fallback must be used. */
export function shouldUseFallback(): boolean {
  return !safeStorage.isEncryptionAvailable();
}

/**
 * Sentinel prefix for an encrypted secret string. Anything that does NOT start
 * with this is treated as legacy plaintext (passthrough on decrypt, re-encrypted
 * on next save) — this is what makes the at-rest migration non-destructive.
 */
export const SECRET_SENTINEL = 'enc:v1:';

/** Whether a stored value is an encrypted secret produced by {@link encryptSecret}. */
export function isEncryptedSecret(value: string): boolean {
  return typeof value === 'string' && value.startsWith(SECRET_SENTINEL);
}

/**
 * Encrypt a secret into a single self-describing string. Empty input stays
 * empty (no crypto, keeps empty slots clean). The backend tag (`s` = OS
 * keyring / `f` = AES fallback) is embedded so decrypt always picks the right
 * method even if the keyring availability changes between runs.
 *
 * Idempotent: an already-encrypted value is returned unchanged.
 */
export function encryptSecret(plaintext: string): string {
  if (!plaintext) return '';
  if (isEncryptedSecret(plaintext)) return plaintext;

  if (shouldUseFallback()) {
    const b64 = fallbackEncrypt(plaintext).toString('base64');
    return `${SECRET_SENTINEL}f:${b64}`;
  }
  const b64 = safeStorage.encryptString(plaintext).toString('base64');
  return `${SECRET_SENTINEL}s:${b64}`;
}

/**
 * Decrypt a value produced by {@link encryptSecret}. Legacy plaintext (no
 * sentinel) is returned as-is. Throws on a real decryption failure so the
 * caller can decide how to degrade (settings-store: drop the key, force
 * re-entry — never wipe the whole settings file).
 */
export function decryptSecret(serialized: string): string {
  if (!serialized) return '';
  if (!isEncryptedSecret(serialized)) return serialized; // legacy plaintext

  const rest = serialized.slice(SECRET_SENTINEL.length);
  const sep = rest.indexOf(':');
  const backend = rest.slice(0, sep);
  const b64 = rest.slice(sep + 1);
  const buf = Buffer.from(b64, 'base64');

  if (backend === 'f') {
    return fallbackDecrypt(buf);
  }
  if (backend === 's') {
    if (shouldUseFallback()) {
      // safeStorage-encrypted on a previous run but no keyring now — undecryptable.
      throw new Error('safeStorage unavailable: cannot decrypt OS-keyring secret');
    }
    return safeStorage.decryptString(buf);
  }
  throw new Error(`Unknown secret backend tag: "${backend}"`);
}

/**
 * Decrypt a secret stored inside a JSON string value that may be in EITHER:
 *  - the self-describing `enc:v1:<backend>:<base64>` format produced by
 *    {@link encryptSecret} (keyring-or-fallback — the format new writes use), or
 *  - a LEGACY raw base64 of `safeStorage.encryptString()` (no sentinel) — the
 *    format the file-backed token/password stores (Telegram/Discord/Email)
 *    persisted before they adopted the fallback-aware crypto.
 *
 * Use this (not {@link decryptSecret}) for those stores so tokens written by
 * older builds keep decrypting after the migration — on the next save they are
 * re-encrypted through {@link encryptSecret} into the sentinel format.
 *
 * IMPORTANT semantic difference from {@link decryptSecret}: here a non-sentinel
 * value is treated as legacy CIPHERTEXT (base64 of an OS-keyring blob), NOT as
 * plaintext — these stores never persisted plaintext. A legacy value therefore
 * needs the OS keyring to read; when the keyring is gone we throw (the caller
 * degrades to "token absent → re-enter") rather than returning the base64 blob.
 */
export function decryptLegacyOrSecret(serialized: string): string {
  if (!serialized) return '';
  if (isEncryptedSecret(serialized)) return decryptSecret(serialized);
  // Legacy: raw base64 of safeStorage.encryptString() (pre-fallback format).
  if (shouldUseFallback()) {
    throw new Error('safeStorage unavailable: cannot decrypt legacy OS-keyring secret');
  }
  return safeStorage.decryptString(Buffer.from(serialized, 'base64'));
}
