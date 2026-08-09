// === Provider API keys ===
//
// The ONE place a provider key is resolved, on purpose. Two sources feed it: the
// environment the backend booted with, and keys handed to this process AFTER
// boot — typed into the setup screen and delivered over
// `PUT /api/provider-keys/:provider`. Every caller written against the two
// original functions below picks the second source up for free; a caller that
// read `process.env` directly would not, and would keep reporting "no key" while
// the user is looking at the key they just saved.

import type { ThinkerProvider } from "../../types/thinker-roster.js";
import { OpenAIError } from "../openai.js";

/** Which of the two sources answered. `null` from `providerKeySource`: neither. */
export type ProviderKeySource = "runtime" | "env";

/** What the app is allowed to learn about a key. Never the key. */
export interface ProviderKeyStatus {
  provider: ThinkerProvider;
  env_var: string;
  present: boolean;
  source: ProviderKeySource | null;
  console_url: string;
}

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
 * The three providers, in the order the setup screen should list them.
 *
 * Derived from `KEYS` rather than restated, so a fourth provider added to the
 * map cannot silently miss the route that asks the user for its key.
 */
export const PROVIDERS: readonly ThinkerProvider[] = Object.keys(KEYS) as ThinkerProvider[];

/**
 * Keys handed to this process after boot. Memory only — never disk, never a log.
 *
 * Not persisted, deliberately. This process has no encryption boundary of its
 * own; the Electron shell has one (`secret-crypto` behind the settings store)
 * and the browser has the user. Writing a plaintext key into the backend's data
 * directory would put a third copy in the one place nobody is guarding, and
 * having to retype a key after a restart is a far cheaper failure than a key
 * sitting unencrypted under `~/.local/share`.
 */
const runtimeKeys = new Map<ThinkerProvider, string>();

/**
 * Bounds on what may be stored — and a deliberate refusal to check the shape.
 *
 * NO PREFIX VALIDATION. The temptation is `sk-or-v1-` for OpenRouter and `sk-`
 * for the other two, and every part of that is a moving target: OpenAI already
 * migrated `sk-` to `sk-proj-` and now also issues `sk-svcacct-` and
 * `sk-admin-`, while OpenRouter's prefix literally carries a version number,
 * which is a promise that a v2 exists one day. No provider documents its prefix
 * as a contract. A wrong prefix rule rejects the user's GOOD key at the one
 * moment they are trying to get started, which is strictly worse than accepting
 * a bad one — a bad key gets a 401 from the provider either way, and that error
 * names the real problem.
 *
 * So the checks are only the ones that hold regardless of format: something was
 * typed; it is long enough to be a credential rather than a fragment; it is
 * short enough to be a credential rather than a payload; and every character in
 * it is one an `Authorization` header can carry — printable ASCII plus the
 * printable half of Latin-1, and nothing else.
 *
 * That last one is the one that matters, and it breaks in two unrelated ways:
 *
 * - A CR or LF inside the value is header injection in any client that does not
 *   validate, and a hard throw in the ones that do.
 * - Anything above U+00FF has no single-byte form at all, so a header cannot
 *   hold it. Both clients this backend can end up on refuse it outright rather
 *   than transliterating — `fetch` throws `TypeError: Cannot convert argument to
 *   a ByteString`, `node:http` throws `Invalid character in header content` —
 *   and neither `TypeError` carries a `.status`, so `errorHandler` maps it to an
 *   opaque 500. That 500 lands on the FIRST real provider call, long after the
 *   PUT accepted the key and answered `present: true`, which is precisely the
 *   diagnosis this whole guard exists to prevent.
 */
const MIN_KEY_LENGTH = 20;
const MAX_KEY_LENGTH = 512;

/**
 * True when the string carries a control character — C0, DEL, or C1.
 *
 * C0 and DEL are the safety half: CR and LF are header injection, NUL and TAB
 * are rejected by the clients that validate.
 *
 * C1 (U+0080–U+009F) is a deliberate widening BEYOND what the header invariant
 * demands, recorded here so nobody later reads it as an injection claim it is
 * not: those code points sit inside Latin-1, so a header carries them as raw
 * bytes and neither `fetch` nor `node:http` objects. They are rejected because
 * no credential alphabet contains one — keys are base64, hex or alphanumeric —
 * so a C1 byte in a pasted key can only be the residue of a mojibake round-trip,
 * and letting it through buys the user a 401 that reads like a revoked key.
 *
 * The printable half of Latin-1 (U+00A0–U+00FF) stays accepted. No provider
 * issues those either, but a header carries them and they are not control
 * characters, so rejecting them would be this module guessing at format — the
 * one thing the note above says it will not do.
 */
function hasControlChars(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
    if (code >= 0x80 && code <= 0x9f) return true;
  }
  return false;
}

/**
 * True when the string carries a character no HTTP header can encode.
 *
 * A header value is bytes; U+0100 and up have no byte form, and both clients
 * throw a `.status`-less `TypeError` rather than transliterating (see the module
 * note above for what that costs).
 *
 * Separate from `hasControlChars` only so the user gets the right advice. The
 * realistic source is nothing exotic: a key copied out of a chat message or a
 * document where an autocorrector turned a hyphen into an em dash (U+2014) or a
 * non-breaking hyphen (U+2011). It looks correct in the field and cannot work.
 * Iteration is by code point, so an astral character counts once and a lone
 * surrogate — which also has no byte form — is caught by the same comparison.
 */
function hasUnencodableChars(value: string): boolean {
  for (const char of value) {
    if ((char.codePointAt(0) ?? 0) > 0xff) return true;
  }
  return false;
}

/**
 * Reads the key at CALL TIME, never at import, and says which source answered.
 *
 * A module-level constant would freeze whatever the environment held when the
 * import graph was first walked, which is both untestable and wrong now that a
 * key can arrive after boot.
 *
 * PRECEDENCE: RUNTIME BEATS ENVIRONMENT. A runtime key exists only because
 * somebody deliberately typed it in this session; an environment variable is
 * whatever the shell happened to be carrying at boot, possibly hours old and
 * possibly revoked. Letting the environment win produces the classic bug where
 * the user saves a new key, the app keeps calling with the old one, and the 401
 * blames the key they are looking at.
 *
 * `electron/main/services/envKeys.ts` decided the OPPOSITE — "the shell beats
 * the file" — and both are right, because they are not the same comparison.
 * There the loser is a `.env` on DISK, a cache that outlives every session, and
 * the winner is the developer's live shell. Here the loser is the environment
 * and the winner is a human action taken seconds ago. In both cases the fresher,
 * more deliberate signal wins; anyone "fixing" one to match the other inverts
 * exactly that.
 *
 * A blank or whitespace-only value counts as ABSENT — the precedent is
 * `services/brave.ts`, which trims before deciding. An empty `export FOO=` in a
 * shell profile is the common way to end up with a defined-but-useless variable,
 * and sending `Authorization: Bearer ` produces a 401 that reads like a revoked
 * key instead of a missing one.
 */
function read(
  provider: ThinkerProvider,
): { key: string; source: ProviderKeySource } | undefined {
  // Stored already trimmed and validated, so it needs no second check here.
  const runtime = runtimeKeys.get(provider);
  if (runtime) return { key: runtime, source: "runtime" };

  const env = process.env[KEYS[provider].env]?.trim();
  return env ? { key: env, source: "env" } : undefined;
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
  const found = read(provider);
  if (!found) {
    const { env, console: url } = KEYS[provider];
    throw new OpenAIError(
      500,
      `${env} não está definida. Crie uma chave em ${url} e exporte ${env} ` +
        "antes de subir o backend.",
    );
  }
  return found.key;
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

/**
 * Which source a present key came from, or `null` when there is none.
 *
 * Exists so the setup screen can say "veio do ambiente" instead of showing a
 * filled field the user never filled — and so it knows that clearing a runtime
 * key may not leave the provider empty, because the environment can still be
 * there underneath.
 */
export function providerKeySource(provider: ThinkerProvider): ProviderKeySource | null {
  return read(provider)?.source ?? null;
}

/**
 * Stores a key for the rest of this process's life.
 *
 * Trims first: a key pasted from a settings field or a here-doc commonly carries
 * a trailing newline, and sent verbatim it produces a 401 that reads like a
 * revoked key rather than a formatting problem.
 *
 * The rejection messages are Brazilian Portuguese — unlike the error above, they
 * are read by the end user typing into the setup screen, not by the operator.
 * None of them quotes the value: an invalid key is still a secret-shaped string,
 * and this error travels into an HTTP response.
 *
 * @throws {OpenAIError} 400 when the value could not be a credential.
 */
export function setProviderKey(provider: ThinkerProvider, key: string): void {
  // The guard is not redundant: this value starts life as an unvalidated JSON
  // field, so `key` can be a number or an object however the parameter is typed.
  const trimmed = typeof key === "string" ? key.trim() : "";

  if (!trimmed) {
    throw new OpenAIError(400, "Cole a chave antes de salvar — o campo está vazio.");
  }
  if (trimmed.length < MIN_KEY_LENGTH) {
    throw new OpenAIError(
      400,
      `Essa chave é curta demais para ser válida (menos de ${MIN_KEY_LENGTH} ` +
        "caracteres). Confira se ela foi copiada inteira.",
    );
  }
  if (trimmed.length > MAX_KEY_LENGTH) {
    throw new OpenAIError(
      400,
      `Essa chave é longa demais (mais de ${MAX_KEY_LENGTH} caracteres). ` +
        "Confira se você colou só a chave.",
    );
  }
  if (hasControlChars(trimmed)) {
    throw new OpenAIError(
      400,
      "A chave tem uma quebra de linha ou um caractere invisível no meio. " +
        "Copie de novo, sem o texto ao redor.",
    );
  }
  if (hasUnencodableChars(trimmed)) {
    throw new OpenAIError(
      400,
      "A chave tem um caractere inválido — em geral um traço ou uma aspa que um " +
        `editor de texto trocou sozinho. Copie de novo direto de ${KEYS[provider].console}.`,
    );
  }

  runtimeKeys.set(provider, trimmed);
}

/**
 * Forgets the runtime key for a provider. Idempotent.
 *
 * Does NOT make the provider unconfigured: if the environment carries a key, the
 * next read falls back to it. That is why `providerKeySource` exists — after a
 * clear the UI has to re-read the state rather than assume it emptied.
 */
export function clearProviderKey(provider: ThinkerProvider): void {
  runtimeKeys.delete(provider);
}

/** Whether an arbitrary value — a route param, a JSON field — names a provider. */
export function isProvider(value: unknown): value is ThinkerProvider {
  return typeof value === "string" && (PROVIDERS as readonly string[]).includes(value);
}

/**
 * Everything the app may know about a provider's key, and nothing more.
 *
 * Built here rather than in the route on purpose: the module that holds the
 * secret is the module that decides what leaves it, so there is exactly one
 * place to audit. A field added here is a field somebody chose to publish.
 */
export function providerKeyStatus(provider: ThinkerProvider): ProviderKeyStatus {
  const found = read(provider);
  return {
    provider,
    env_var: KEYS[provider].env,
    present: found !== undefined,
    source: found?.source ?? null,
    console_url: KEYS[provider].console,
  };
}
