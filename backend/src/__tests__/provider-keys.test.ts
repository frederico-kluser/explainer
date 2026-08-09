import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { providerKey, providerKeyPresent } from "../services/providers/keys.js";
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
});

afterEach(() => {
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
