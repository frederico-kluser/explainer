import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import {
  clearProviderKey,
  providerKey,
  providerKeyPresent,
  providerKeySource,
  setProviderKey,
} from "../services/providers/keys.js";
import providerKeysRouter from "../routes/provider-keys.js";
import { errorHandler } from "../middleware/error-handler.js";
import { OpenAIError } from "../services/openai.js";
import type { ThinkerProvider } from "../types/thinker-roster.js";

// The mapping under test, restated rather than imported: a test that imported
// the module's own map would still pass if that map were rewritten wholesale.
const ENV: Record<ThinkerProvider, string> = {
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
};

const PROVIDERS = Object.keys(ENV) as ThinkerProvider[];
const VARS = Object.values(ENV);

// These variables are usually populated in the developer's real shell, so every
// test starts by clearing all three and ends by restoring them EXACTLY —
// `undefined` back to deleted, `""` back to empty. Collapsing those two states
// on the way out would leak an empty string into whatever runs next, which is
// the same thing this module treats as a missing key.
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const name of VARS) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
  // The runtime store outlives a test the way an environment variable does, and
  // it now OUTRANKS one — a key left behind by an earlier case would mask every
  // env assertion below it and the suite would still be green.
  for (const provider of PROVIDERS) clearProviderKey(provider);
});

afterEach(() => {
  for (const provider of PROVIDERS) clearProviderKey(provider);
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  saved.clear();
});

describe("providerKey", () => {
  it("reads each provider from its own variable", () => {
    for (const provider of PROVIDERS) {
      process.env[ENV[provider]] = `key-for-${provider}`;
    }

    for (const provider of PROVIDERS) {
      expect(providerKey(provider)).toBe(`key-for-${provider}`);
    }
  });

  it("does not fall back to another provider's key", () => {
    // Only OpenAI is configured. The other two must fail rather than borrow it,
    // because a borrowed key reaches the wrong provider and 401s far from here.
    process.env.OPENAI_API_KEY = "sk-only-openai";

    expect(providerKey("openai")).toBe("sk-only-openai");
    expect(() => providerKey("openrouter")).toThrow(OpenAIError);
    expect(() => providerKey("deepseek")).toThrow(OpenAIError);
  });

  it("throws a 500 naming the variable when the key is absent", () => {
    for (const provider of PROVIDERS) {
      let thrown: unknown;
      try {
        providerKey(provider);
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(OpenAIError);
      const err = thrown as OpenAIError;
      expect(err.status).toBe(500);
      // Names the exact variable to set — an error that only said "missing key"
      // would leave the operator guessing between three of them.
      expect(err.message).toContain(ENV[provider]);
      expect(err.message).toContain("não está definida");
    }
  });

  it("treats an empty variable as absent", () => {
    // `export FOO=` in a shell profile defines the variable with no value. It is
    // present as far as `process.env` is concerned and useless as a credential.
    for (const provider of PROVIDERS) {
      process.env[ENV[provider]] = "";
      expect(() => providerKey(provider)).toThrow(OpenAIError);
      expect(providerKeyPresent(provider)).toBe(false);
    }
  });

  it("treats a whitespace-only variable as absent", () => {
    for (const provider of PROVIDERS) {
      process.env[ENV[provider]] = "   \t\n ";
      expect(() => providerKey(provider)).toThrow(OpenAIError);
      expect(providerKeyPresent(provider)).toBe(false);
    }
  });

  it("trims a key that arrived with surrounding whitespace", () => {
    // A key pasted into a settings field or a here-doc commonly carries a
    // trailing newline; sent verbatim it produces a 401 that reads like a
    // revoked key rather than a formatting problem.
    process.env.DEEPSEEK_API_KEY = "  sk-padded\n";
    expect(providerKey("deepseek")).toBe("sk-padded");
  });

  it("reads the environment at call time, not at import time", () => {
    // This module was imported while all three variables were unset (the
    // `beforeEach` above clears them, and the static imports resolved before any
    // of it ran). A sentinel set here and observed coming back out can only have
    // been read after import — a value frozen at module load could not contain
    // it.
    expect(providerKeyPresent("openrouter")).toBe(false);

    process.env.OPENROUTER_API_KEY = "sk-or-set-after-import";

    expect(providerKeyPresent("openrouter")).toBe(true);
    expect(providerKey("openrouter")).toBe("sk-or-set-after-import");

    // And it keeps tracking changes, rather than caching the first read.
    process.env.OPENROUTER_API_KEY = "sk-or-rotated";
    expect(providerKey("openrouter")).toBe("sk-or-rotated");

    delete process.env.OPENROUTER_API_KEY;
    expect(providerKeyPresent("openrouter")).toBe(false);
  });

  it("does not leak the key into the error it throws", () => {
    // The only value present is unusable, but it is still a secret-shaped
    // string, and this error travels to an HTTP response.
    process.env.DEEPSEEK_API_KEY = "   ";
    try {
      providerKey("deepseek");
      expect.unreachable("providerKey should have thrown");
    } catch (err) {
      expect((err as OpenAIError).message).not.toContain("   ");
    }
  });
});

describe("providerKeyPresent", () => {
  it("answers for each provider without throwing", () => {
    for (const provider of PROVIDERS) {
      expect(providerKeyPresent(provider)).toBe(false);
    }

    for (const provider of PROVIDERS) {
      process.env[ENV[provider]] = `key-for-${provider}`;
      expect(providerKeyPresent(provider)).toBe(true);
    }
  });

  it("returns a boolean and never the key itself", () => {
    // This result is safe to serialise into an HTTP response or a log line, and
    // that is the whole reason it exists next to `providerKey`.
    const secret = "sk-super-secret-value";
    process.env.OPENAI_API_KEY = secret;

    const result = providerKeyPresent("openai");

    expect(typeof result).toBe("boolean");
    expect(result).toBe(true);
    expect(result as unknown).not.toBe(secret);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).toBe("true");
  });

  it("reports false for a provider that is not configured", () => {
    process.env.OPENAI_API_KEY = "sk-only-openai";

    expect(providerKeyPresent("openai")).toBe(true);
    expect(providerKeyPresent("openrouter")).toBe(false);
    expect(providerKeyPresent("deepseek")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The second source: keys handed to the process after boot
// ---------------------------------------------------------------------------

// Long enough to clear MIN_KEY_LENGTH, and shaped like the real thing so a
// prefix rule sneaked in later would have to reject a plausible key to fail.
const RUNTIME_KEY = "sk-or-v1-runtime-typed-by-the-user-0123456789";
const ENV_KEY = "sk-or-v1-stale-value-from-the-shell-9876543210";

describe("setProviderKey / clearProviderKey", () => {
  it("makes a provider callable without any environment variable", () => {
    expect(providerKeyPresent("openrouter")).toBe(false);

    setProviderKey("openrouter", RUNTIME_KEY);

    expect(providerKeyPresent("openrouter")).toBe(true);
    expect(providerKey("openrouter")).toBe(RUNTIME_KEY);
  });

  it("stores each provider separately and never cross-feeds", () => {
    setProviderKey("openai", `${RUNTIME_KEY}-openai`);

    expect(providerKey("openai")).toBe(`${RUNTIME_KEY}-openai`);
    expect(() => providerKey("openrouter")).toThrow(OpenAIError);
    expect(() => providerKey("deepseek")).toThrow(OpenAIError);
  });

  it("trims a key that arrived with surrounding whitespace", () => {
    setProviderKey("deepseek", `\n  ${RUNTIME_KEY}\t `);
    expect(providerKey("deepseek")).toBe(RUNTIME_KEY);
  });

  it("rejects blank and whitespace-only values without storing anything", () => {
    // Same precedent as an empty `export FOO=`: present but useless. It must not
    // become a stored value that then outranks a working environment variable.
    process.env.OPENAI_API_KEY = ENV_KEY;

    for (const blank of ["", "   ", "\t\n "]) {
      let thrown: unknown;
      try {
        setProviderKey("openai", blank);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(OpenAIError);
      expect((thrown as OpenAIError).status).toBe(400);
    }

    // The environment underneath is untouched, and still the answer.
    expect(providerKeySource("openai")).toBe("env");
    expect(providerKey("openai")).toBe(ENV_KEY);
  });

  it("rejects a value too short to be a credential", () => {
    expect(() => setProviderKey("openai", "sk-abc")).toThrow(OpenAIError);
    expect(providerKeyPresent("openai")).toBe(false);
  });

  it("rejects a value far too long to be a credential", () => {
    // A pasted page rather than a key. Storing it would park the payload in
    // memory for the life of the process for nothing.
    expect(() => setProviderKey("openai", "sk-".concat("a".repeat(4000)))).toThrow(
      OpenAIError,
    );
    expect(providerKeyPresent("openai")).toBe(false);
  });

  it("rejects a value carrying a line break or an invisible character", () => {
    // This one is not cosmetic: the value ends up in an `Authorization` header,
    // where a CR or LF is header injection in any client that does not check.
    const nul = String.fromCharCode(0);
    for (const bad of [
      "sk-or-v1-first-half\nsk-or-v1-second-half",
      "sk-or-v1-first-half\r\nX-Injected: yes",
      `sk-or-v1-with-a-null-${nul}-inside-it-000`,
    ]) {
      expect(() => setProviderKey("openrouter", bad)).toThrow(OpenAIError);
    }
    expect(providerKeyPresent("openrouter")).toBe(false);
  });

  it("rejects a character no Authorization header can carry", () => {
    // Regression. Every one of these used to be ACCEPTED and stored: the length
    // and control-character checks all pass, so the PUT answered
    // `present: true` and the failure waited for the first real provider call,
    // where the HTTP client throws a `TypeError` with no `.status` and
    // `errorHandler` turns it into an opaque 500 — exactly the diagnosis the
    // 20-character floor exists to avoid. The em dash is the realistic path: an
    // autocorrector rewriting a hyphen in the document the key was pasted
    // through.
    const unencodable = [
      "sk-or-v1-abcdefghijklm—nopqrstuvwxyz01", // em dash, the autocorrect case
      "sk-or-v1-abcdefghijklm‑nopqrstuvwxyz01", // non-breaking hyphen, same source
      "sk-or-v1-abcdefghijklm－nopqrstuvwxyz01", // fullwidth hyphen-minus
      "sk-or-v1-abcdefghijklmаnopqrstuvwxyz01", // Cyrillic a, an ASCII homoglyph
      "sk-or-v1-abcdefghijklm\u{1f511}nopqrstuvwxy", // astral: one code point, not two
    ];

    for (const bad of unencodable) {
      // The invariant the rule is derived from, asserted rather than assumed: a
      // value that stops throwing here does not belong on this list.
      expect(() => new Headers({ Authorization: `Bearer ${bad}` })).toThrow(TypeError);

      let thrown: unknown;
      try {
        setProviderKey("openrouter", bad);
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(OpenAIError);
      const message = (thrown as OpenAIError).message;
      expect((thrown as OpenAIError).status).toBe(400);
      // Actionable for whoever pasted from the wrong place — and it points at the
      // console instead of quoting the character or its position, either of which
      // would echo the value back out of a module that never quotes it.
      expect(message).toContain("caractere inválido");
      expect(message).toContain("openrouter.ai/keys");
      expect(message).not.toContain(bad);
      // Nor any window of it. Asserting on the offending character alone would
      // be the wrong test: the message carries an em dash of its own, as this
      // file's prose punctuation, and that is not an echo of anything.
      for (let i = 0; i + 8 <= bad.length; i += 1) {
        expect(message).not.toContain(bad.slice(i, i + 8));
      }
    }

    expect(providerKeyPresent("openrouter")).toBe(false);
  });

  it("rejects a C1 control character even though a header would carry it", () => {
    // A deliberate widening, pinned so nobody later reads it as an injection fix
    // and "corrects" it: C1 sits inside Latin-1, so a header transmits it as a
    // raw byte and no client complains. It is rejected because no credential
    // alphabet contains one — a C1 byte in a pasted key is the residue of a
    // mojibake round-trip, and accepting it buys a 401 that reads like a revoked
    // key rather than a bad paste.
    const c1 = [
      "sk-or-v1-abcdefghijklmnopqrstuvwxyz01", // NEL
      "sk-or-v1-abcdefghijklmnopqrstuvwxyz01", // APC
    ];

    for (const bad of c1) {
      // The half of the claim that has to stay true for the comment to be honest.
      expect(() => new Headers({ Authorization: `Bearer ${bad}` })).not.toThrow();
      expect(() => setProviderKey("deepseek", bad)).toThrow(OpenAIError);
    }

    expect(providerKeyPresent("deepseek")).toBe(false);
  });

  it("puts every key it accepts into an Authorization header without throwing", () => {
    // The invariant the module claims, pinned end to end. Whatever
    // `setProviderKey` stores has to survive the one place it is going to end up,
    // so a check loosened later fails here instead of on a user's first call.
    const accepted = [
      "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
      "sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789",
      "a-provider-that-uses-no-prefix-at-all-12345678",
      // Every printable ASCII byte a base64url or hex key can contain, plus the
      // punctuation a provider might pad with.
      "sk-AZaz09-_.~+/=:;,!@#$%^&*()[]{}<>?|\\'\"`",
      // The accepted edge of the rule, spelled out because it is the surprising
      // one: printable Latin-1 rides a header as a raw byte, so U+00A0 (the
      // no-break space in this value) and U+00FF are stored, while the C1 block
      // one code point below U+00A0 is not.
      "sk-latin1-printable- éÿ-0123456789",
      // The upper length bound, which is stored verbatim and headered verbatim.
      `sk-${"a".repeat(509)}`,
    ];

    for (const key of accepted) {
      setProviderKey("openai", key);
      const stored = providerKey("openai");

      expect(stored).toBe(key);
      expect(() => new Headers({ Authorization: `Bearer ${stored}` })).not.toThrow();
      expect(new Headers({ Authorization: `Bearer ${stored}` }).get("authorization")).toBe(
        `Bearer ${stored}`,
      );
    }
  });

  it("accepts every key shape the three providers are known to issue", () => {
    // Deliberate: no prefix validation exists, and this case is what fails if
    // somebody adds one. OpenAI alone has migrated `sk-` to `sk-proj-` and now
    // also issues `sk-svcacct-` and `sk-admin-`; OpenRouter's prefix carries a
    // version number. A rule that guessed wrong would reject a GOOD key at the
    // exact moment the user is trying to get started.
    const shapes = [
      "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
      "sk-svcacct-abcdefghijklmnopqrstuvwxyz01234567",
      "sk-admin-abcdefghijklmnopqrstuvwxyz012345678",
      "sk-abcdefghijklmnopqrstuvwxyz0123456789012345",
      "sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789",
      "sk-or-v2-a-prefix-that-does-not-exist-yet-000",
      "a-provider-that-uses-no-prefix-at-all-12345678",
    ];

    for (const shape of shapes) {
      setProviderKey("deepseek", shape);
      expect(providerKey("deepseek")).toBe(shape);
    }
  });

  it("never quotes the rejected value in the error it throws", () => {
    // An invalid key is still a secret-shaped string, and this error travels
    // into an HTTP response.
    const nearMiss = "sk-live-secret\nleaked";
    try {
      setProviderKey("openai", nearMiss);
      expect.unreachable("setProviderKey should have thrown");
    } catch (err) {
      const message = (err as OpenAIError).message;
      expect(message).not.toContain("sk-live-secret");
      expect(message).not.toContain(nearMiss);
    }
  });

  it("clears a runtime key and is idempotent about it", () => {
    setProviderKey("deepseek", RUNTIME_KEY);
    expect(providerKeyPresent("deepseek")).toBe(true);

    clearProviderKey("deepseek");
    clearProviderKey("deepseek");

    expect(providerKeyPresent("deepseek")).toBe(false);
  });

  it("still throws the 500 naming the variable after a clear", () => {
    // The whole point of keeping one resolver: removing the runtime key returns
    // the caller to exactly the error the operator already knows how to fix.
    setProviderKey("deepseek", RUNTIME_KEY);
    clearProviderKey("deepseek");

    let thrown: unknown;
    try {
      providerKey("deepseek");
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(OpenAIError);
    expect((thrown as OpenAIError).status).toBe(500);
    expect((thrown as OpenAIError).message).toContain("DEEPSEEK_API_KEY");
    expect((thrown as OpenAIError).message).toContain("não está definida");
  });
});

describe("precedence between the two sources", () => {
  it("lets a runtime key beat the environment", () => {
    // The decision this module documents. A key typed seconds ago is a
    // deliberate act; the variable is whatever the shell was carrying at boot,
    // and a stale one is the classic "I saved the new key and it still uses the
    // old one" bug.
    process.env.OPENROUTER_API_KEY = ENV_KEY;
    expect(providerKey("openrouter")).toBe(ENV_KEY);

    setProviderKey("openrouter", RUNTIME_KEY);

    expect(providerKey("openrouter")).toBe(RUNTIME_KEY);
    expect(providerKeySource("openrouter")).toBe("runtime");
  });

  it("falls back to the environment once the runtime key is cleared", () => {
    process.env.OPENROUTER_API_KEY = ENV_KEY;
    setProviderKey("openrouter", RUNTIME_KEY);
    expect(providerKey("openrouter")).toBe(RUNTIME_KEY);

    clearProviderKey("openrouter");

    // Still configured — clearing what the user typed does not unconfigure a
    // provider the shell already supplied.
    expect(providerKeyPresent("openrouter")).toBe(true);
    expect(providerKey("openrouter")).toBe(ENV_KEY);
    expect(providerKeySource("openrouter")).toBe("env");
  });

  it("does not let a blank environment variable hide a runtime key", () => {
    process.env.DEEPSEEK_API_KEY = "   ";
    setProviderKey("deepseek", RUNTIME_KEY);

    expect(providerKey("deepseek")).toBe(RUNTIME_KEY);
    expect(providerKeySource("deepseek")).toBe("runtime");
  });

  it("keeps precedence per provider rather than globally", () => {
    process.env.OPENAI_API_KEY = ENV_KEY;
    setProviderKey("deepseek", RUNTIME_KEY);

    expect(providerKeySource("openai")).toBe("env");
    expect(providerKeySource("deepseek")).toBe("runtime");
    expect(providerKeySource("openrouter")).toBe(null);
  });
});

describe("providerKeySource", () => {
  it("reports null, env and runtime for the three states", () => {
    expect(providerKeySource("openai")).toBe(null);

    process.env.OPENAI_API_KEY = ENV_KEY;
    expect(providerKeySource("openai")).toBe("env");

    setProviderKey("openai", RUNTIME_KEY);
    expect(providerKeySource("openai")).toBe("runtime");
  });

  it("reports null for a variable that is only whitespace", () => {
    process.env.OPENAI_API_KEY = "  \t ";
    expect(providerKeySource("openai")).toBe(null);
  });

  it("never returns the key in place of the source", () => {
    process.env.OPENAI_API_KEY = ENV_KEY;
    const source = providerKeySource("openai");

    expect(source).toBe("env");
    expect(JSON.stringify(source)).not.toContain(ENV_KEY);
  });
});

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------
//
// Mounted the way `index.ts` mounts it, minus `loopbackOnly`: that gate is
// proven in `access-key.test.ts`, and repeating it here would only prove that
// Express chains middleware. `errorHandler` IS included, because the PUT hands
// its rejection to it rather than mapping the status itself.

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use("/api/provider-keys", providerKeysRouter);
app.use(errorHandler);

const server: Server = app.listen(0);
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}/api/provider-keys`;

afterAll(() => {
  server.close();
});

interface StatusRow {
  provider: string;
  env_var: string;
  present: boolean;
  source: string | null;
  console_url: string;
}

async function getAll(): Promise<{ res: Response; text: string; rows: StatusRow[] }> {
  const res = await fetch(base);
  const text = await res.text();
  return { res, text, rows: (JSON.parse(text) as { providers: StatusRow[] }).providers };
}

function put(provider: string, body: unknown): Promise<Response> {
  return fetch(`${base}/${provider}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET /api/provider-keys", () => {
  it("answers for all three providers with the variable and the console url", async () => {
    const { res, rows } = await getAll();

    expect(res.status).toBe(200);
    expect(rows.map((row) => row.provider).sort()).toEqual(
      ["deepseek", "openai", "openrouter"].sort(),
    );
    for (const row of rows) {
      expect(row.env_var).toBe(ENV[row.provider as ThinkerProvider]);
      expect(row.console_url).toMatch(/^https:\/\//);
      expect(row.present).toBe(false);
      expect(row.source).toBe(null);
    }
  });

  it("reports which source answered, per provider", async () => {
    process.env.OPENAI_API_KEY = ENV_KEY;
    setProviderKey("deepseek", RUNTIME_KEY);

    const { rows } = await getAll();
    const by = new Map(rows.map((row) => [row.provider, row]));

    expect(by.get("openai")).toMatchObject({ present: true, source: "env" });
    expect(by.get("deepseek")).toMatchObject({ present: true, source: "runtime" });
    expect(by.get("openrouter")).toMatchObject({ present: false, source: null });
  });

  it("never puts a key in the response body", async () => {
    // The assertion is on the RAW text, not on a parsed field: a key added to
    // some future field would still pass a per-field check.
    process.env.OPENAI_API_KEY = ENV_KEY;
    setProviderKey("openrouter", RUNTIME_KEY);

    const { text } = await getAll();

    expect(text).not.toContain(ENV_KEY);
    expect(text).not.toContain(RUNTIME_KEY);
    expect(text).not.toContain("sk-");
  });
});

describe("PUT /api/provider-keys/:provider", () => {
  it("takes a key and makes the provider callable from that moment on", async () => {
    expect(providerKeyPresent("openrouter")).toBe(false);

    const res = await put("openrouter", { key: RUNTIME_KEY });
    const body = (await res.json()) as StatusRow;

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      provider: "openrouter",
      env_var: "OPENROUTER_API_KEY",
      present: true,
      source: "runtime",
    });
    // The point of the whole wave: no restart between the PUT and the call.
    expect(providerKey("openrouter")).toBe(RUNTIME_KEY);
  });

  it("does not echo the key back", async () => {
    const res = await put("openai", { key: RUNTIME_KEY });
    const text = await res.text();

    expect(text).not.toContain(RUNTIME_KEY);
    expect(text).not.toContain("sk-");
  });

  it("overwrites a key that came from the environment", async () => {
    process.env.OPENROUTER_API_KEY = ENV_KEY;

    await put("openrouter", { key: RUNTIME_KEY });

    expect(providerKey("openrouter")).toBe(RUNTIME_KEY);
    expect(providerKeySource("openrouter")).toBe("runtime");
  });

  it("answers 400 for an unknown provider", async () => {
    const res = await put("anthropic", { key: RUNTIME_KEY });

    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toHaveProperty("error");
  });

  it("answers 400 for a provider name that is an Object property", async () => {
    // `provider` indexes an object two lines later. The guard is an allowlist
    // rather than a "not undefined" check precisely so these never get that far.
    for (const name of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      const res = await put(name, { key: RUNTIME_KEY });
      expect(res.status).toBe(400);
    }
  });

  it("answers 400 for an empty key and stores nothing", async () => {
    for (const key of ["", "   "]) {
      const res = await put("deepseek", { key });
      expect(res.status).toBe(400);
    }
    expect(providerKeyPresent("deepseek")).toBe(false);
  });

  it("answers 400 for a missing or non-string key rather than a 500", async () => {
    for (const body of [{}, { key: 42 }, { key: null }, { key: { a: 1 } }]) {
      const res = await put("deepseek", body);
      expect(res.status).toBe(400);
    }
    expect(providerKeyPresent("deepseek")).toBe(false);
  });

  it("answers 400 for a key carrying a header-injection line break", async () => {
    const res = await put("deepseek", { key: "sk-or-v1-good-half\r\nX-Injected: yes" });

    expect(res.status).toBe(400);
    expect(providerKeyPresent("deepseek")).toBe(false);
  });

  it("never writes the key to the console, on the happy path or the sad one", async () => {
    // `errorHandler` logs whatever it is handed when the status is >= 500, which
    // is exactly why the rejection is a 400 and why this is worth pinning.
    const seen: string[] = [];
    const capture = (...args: unknown[]) => {
      seen.push(args.map((arg) => String(arg)).join(" "));
    };
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(capture),
    );

    try {
      await put("openai", { key: RUNTIME_KEY });
      await put("openai", { key: `${RUNTIME_KEY}\nX-Injected: yes` });
      await getAll();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }

    for (const line of seen) {
      expect(line).not.toContain(RUNTIME_KEY);
      expect(line).not.toContain("sk-");
    }
  });
});

describe("DELETE /api/provider-keys/:provider", () => {
  it("forgets the runtime key and reports the state that is left", async () => {
    setProviderKey("openrouter", RUNTIME_KEY);

    const res = await fetch(`${base}/openrouter`, { method: "DELETE" });
    const body = (await res.json()) as StatusRow;

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ provider: "openrouter", present: false, source: null });
    expect(providerKeyPresent("openrouter")).toBe(false);
  });

  it("reports the environment underneath instead of claiming it emptied", async () => {
    process.env.OPENROUTER_API_KEY = ENV_KEY;
    setProviderKey("openrouter", RUNTIME_KEY);

    const res = await fetch(`${base}/openrouter`, { method: "DELETE" });
    const body = (await res.json()) as StatusRow;

    expect(body).toMatchObject({ present: true, source: "env" });
    expect(providerKey("openrouter")).toBe(ENV_KEY);
  });

  it("answers 400 for an unknown provider", async () => {
    const res = await fetch(`${base}/gemini`, { method: "DELETE" });
    expect(res.status).toBe(400);
  });

  it("is idempotent", async () => {
    const first = await fetch(`${base}/deepseek`, { method: "DELETE" });
    const second = await fetch(`${base}/deepseek`, { method: "DELETE" });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });
});
