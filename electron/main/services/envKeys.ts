/**
 * Seeding of BYO API keys from the ENVIRONMENT (dev convenience).
 *
 * Goal: whoever already exports `OPENAI_API_KEY` in the shell (or keeps a
 * `.env` in the root) does not type the key in the UI on every install — the
 * app finds it, saves it, and the setup screen comes pre-filled.
 *
 * WHY RUNTIME, NOT `import.meta.env` FROM electron-vite: electron-vite
 * resolves environment variables at BUILD TIME and INLINES them in the
 * bundle. A key inlined that way would sit in plaintext inside
 * `out/main/index.js` and travel in every packaged artifact. Reading
 * `process.env` at runtime keeps the secret out of the generated code.
 *
 * The golden rule stays intact: whatever is seeded goes to the settings
 * store, which ENCRYPTS at the persistence boundary (secret-crypto). Nothing
 * here writes a plaintext key to disk, and no value is ever logged — booleans
 * only.
 *
 * @module electron/main/services/envKeys
 */

import { readFileSync } from 'node:fs';

/**
 * Environment variable per provider, following the `<PROVIDER>_API_KEY`
 * convention most SDKs use — whoever already exports the key for another tool
 * doesn't have to duplicate anything.
 *
 * Only the three CALLING providers are mapped. The settings store also
 * persists 'openaiAdmin' (an admin-scoped key that only reads the billing
 * API), but the backend never accepts that slot on any route — and the
 * backend reads `OPENAI_ADMIN_KEY` straight from ITS own environment, so a
 * mapped variable here would seed and inject a key nobody needs moved.
 */
export const ENV_VAR_BY_PROVIDER: Readonly<Record<string, string>> = {
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY'
};

/**
 * `.env` parser (minimal format, no dependency):
 * - `KEY=value`, one per line;
 * - empty lines and `#` comments are ignored;
 * - `export KEY=value` accepted (the file can be `source`d in the shell);
 * - single/double quotes around the value are removed;
 * - `#` AFTER an unquoted value starts a comment.
 *
 * Pure (string → object) so it is testable without touching the disk.
 */
export function parseDotEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) continue;

    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = withoutExport.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      // Unquoted value: `#` starts an end-of-line comment.
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

/**
 * Loads a `.env` into `process.env` WITHOUT overwriting anything already set —
 * the shell beats the file. Thus `OPENAI_API_KEY=x npm run dev` keeps working,
 * and a stale `.env` cannot hijack the session.
 *
 * A missing/unreadable file is not an error: env seeding is a convenience,
 * never a boot requirement.
 */
export function loadDotEnvFile(filePath: string): number {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return 0;
  }

  let applied = 0;
  for (const [key, value] of Object.entries(parseDotEnv(content))) {
    if (process.env[key] !== undefined) continue; // shell wins
    process.env[key] = value;
    applied += 1;
  }
  return applied;
}

/**
 * Keys found in the environment, per provider. Blank values count as absent
 * (an exported empty var must not zero anything out).
 */
export function collectEnvApiKeys(
  env: NodeJS.ProcessEnv = process.env
): Partial<Record<string, string>> {
  const found: Partial<Record<string, string>> = {};
  for (const [provider, varName] of Object.entries(ENV_VAR_BY_PROVIDER)) {
    const value = env[varName]?.trim();
    if (value) found[provider] = value;
  }
  return found;
}

/**
 * Writes every stored key into `env` under its provider's variable name —
 * called right BEFORE the backend spawn, because the child freezes its
 * environment at spawn.
 *
 * Overwrites on purpose: by the time this runs the store has already been
 * reconciled with the shell (`seedApiKeysFromEnv` — the shell wins), so the
 * stored value is the freshest signal in every case. A provider the map does
 * not know (openaiAdmin) is skipped.
 */
export function injectStoredKeysIntoEnv(
  stored: Readonly<Record<string, { key: string }>>,
  env: NodeJS.ProcessEnv = process.env
): void {
  for (const [provider, varName] of Object.entries(ENV_VAR_BY_PROVIDER)) {
    const key = stored[provider]?.key;
    if (key) env[varName] = key;
  }
}

/**
 * Decides WHICH providers should be seeded from the environment.
 *
 * Two rules, one stronger than the other:
 * 1. An EMPTY slot always receives the env key (first boot / reset).
 * 2. A FILLED slot holding a key DIFFERENT from the env one is OVERWRITTEN.
 *    The principle is the same as `loadDotEnvFile`: the shell beats the
 *    settings file. The motivating case: a key that was valid and stopped
 *    being (revoked, project deleted) — without this rule the broken key
 *    would occupy the slot forever and the good env key would be ignored.
 *
 * The risk of "a stale env overwriting a key the user typed in the UI" is
 * REAL, and the mitigation is the same as `.env`: the shell wins. Someone who
 * updates the key in the UI must update the environment too — or unset the
 * variable and let the settings file alone drive. There is no way to decide
 * which of the two keys is the "right" one without a network call (which
 * costs latency and money on every boot), so the rule is explicit and
 * predictable: environment > disk, always.
 *
 * Pure: receives what exists and what the environment offers, returns the
 * delta.
 */
export function pickProvidersToSeed(
  stored: Readonly<Record<string, { key: string }>>,
  fromEnv: Partial<Record<string, string>>
): Array<{ provider: string; key: string }> {
  const seeds: Array<{ provider: string; key: string }> = [];
  for (const [provider, key] of Object.entries(fromEnv)) {
    if (!key || stored[provider]?.key === key) continue; // already the same key or empty — nothing to do
    seeds.push({ provider, key });
  }
  return seeds;
}
