// === Provider API keys ===
//
// The ONE place a provider key is resolved, on purpose. A later wave adds a
// second source — asking the Electron shell for a key the user typed into
// settings, which today never reaches this process — and it lands here as one
// more branch inside these two functions. Every caller written against them
// picks it up for free; a caller that read `process.env` directly would not, and
// would keep reporting "no key" while the user is looking at the key they saved.

import type { ThinkerProvider } from "../../types/thinker-roster.js";
import { OpenAIError } from "../openai.js";

/**
 * Where each provider's key lives, and where the operator gets one.
 *
 * These are the variables the rest of the backend ALREADY uses, which is why no
 * new configuration comes with this contract:
 *
 * - `OPENAI_API_KEY` is the calling key the whole app runs on — `load-env.ts`
 *   warns when it is missing, and `services/openai.ts`, `services/mermaid.ts`
 *   and `services/deep-think.ts` each read it.
 * - `OPENROUTER_API_KEY` and `DEEPSEEK_API_KEY` are exactly the variables
 *   `services/credits.ts` reads to show a balance, so an operator who can
 *   already see their balance can already be called.
 *
 * Note the asymmetry, because it is easy to get wrong: `credits.ts` reads
 * `OPENAI_ADMIN_KEY` for OpenAI, not `OPENAI_API_KEY`. That is a separate
 * admin-scoped key that ONLY reads the Costs API — a project key gets a 401 —
 * and it cannot call a model. Calling and balance-reading are two different
 * keys for OpenAI alone; this map is about calling.
 */
const KEYS: Record<ThinkerProvider, { env: string; console: string }> = {
  openai: { env: "OPENAI_API_KEY", console: "https://platform.openai.com/api-keys" },
  openrouter: { env: "OPENROUTER_API_KEY", console: "https://openrouter.ai/keys" },
  deepseek: { env: "DEEPSEEK_API_KEY", console: "https://platform.deepseek.com/api_keys" },
};

/**
 * Reads the key at CALL TIME, never at import.
 *
 * A module-level constant would freeze whatever the environment held when the
 * import graph was first walked, which is both untestable and wrong once a key
 * can arrive after boot from the Electron shell.
 *
 * A blank or whitespace-only value counts as ABSENT — the precedent is
 * `services/brave.ts`, which trims before deciding. An empty `export FOO=` in a
 * shell profile is the common way to end up with a defined-but-useless variable,
 * and sending `Authorization: Bearer ` produces a 401 that reads like a revoked
 * key instead of a missing one.
 */
function read(provider: ThinkerProvider): string | undefined {
  const value = process.env[KEYS[provider].env]?.trim();
  return value ? value : undefined;
}

/**
 * The key for a provider, or a 500 naming the variable that is missing.
 *
 * Message is Brazilian Portuguese: it surfaces to the operator running the
 * backend, same as the missing-key error in `services/brave.ts`.
 *
 * @throws {OpenAIError} 500 when no key is configured for `provider`.
 */
export function providerKey(provider: ThinkerProvider): string {
  const key = read(provider);
  if (!key) {
    const { env, console: url } = KEYS[provider];
    throw new OpenAIError(
      500,
      `${env} não está definida. Crie uma chave em ${url} e exporte ${env} ` +
        "antes de subir o backend.",
    );
  }
  return key;
}

/**
 * Whether a provider can be called at all. Never throws.
 *
 * For the callers that have to decide whether to OFFER something — the roster UI
 * greying out a provider, discovery skipping one — where a thrown error would be
 * control flow for the ordinary case of a provider the operator never set up.
 *
 * Returns a boolean and NEVER the key itself, deliberately: this result is safe
 * to put in an HTTP response or a log line, and a function that returned the key
 * "for convenience" would eventually have it serialised into one.
 */
export function providerKeyPresent(provider: ThinkerProvider): boolean {
  return read(provider) !== undefined;
}
