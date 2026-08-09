import { Router } from "express";

import { OpenAIError } from "../services/openai.js";
import { adapterFor } from "../services/providers/index.js";
import {
  PROVIDERS,
  isProvider,
  providerKeyPresent,
  providerKeyStatus,
  type ProviderKeyStatus,
} from "../services/providers/keys.js";
import {
  defaultRoster,
  getRoster,
  setRoster,
} from "../services/thinker-roster.js";
import type {
  ModelChoice,
  ReasoningEffort,
  ThinkerProvider,
  ThinkerRoster,
} from "../types/thinker-roster.js";

// === /api/thinkers — the roster of thinkers, over the wire ===
//
// A thin layer over `services/thinker-roster.ts`, which already normalises
// anything it is handed and never throws for want of a usable file. So this
// router does only the two things the store deliberately does not:
//
//   1. It REFUSES a body that claims a protocol version this build does not
//      speak, instead of merging it. The store cannot make that call — refusing
//      a version while WRITING destroys exactly what the refusal protects, which
//      is why `setRoster` pins `version: 1` and never reads the patch's. Here
//      nothing has been written yet, so a 422 costs the caller nothing and tells
//      them the truth. Answering 200 to a client that believes it is speaking
//      version 2 is the alternative, and it is a lie.
//   2. It WARNS when a chosen provider has no key. The store is about what a
//      roster IS; whether it can be CALLED depends on `providers/keys.ts`, which
//      the store deliberately does not import.
//
// Every response carries the same envelope — roster, provider key status,
// warnings — because the UI cannot render one without the others: a roster
// pointing slot 3 at OpenRouter is fine right up until OpenRouter has no key,
// and a screen that had to ask twice would show a roster that does not run until
// the second answer lands.

const router = Router();

/** Why a warning was raised. A union of one, so the UI can switch on it. */
export type RosterWarningCode = "provider_key_missing";

/** Which row of the settings screen a warning is about. */
export type RosterRole = "master" | "planner" | "thinker";

export interface RosterWarning {
  code: RosterWarningCode;
  /**
   * The row this is about. `slot_index` alone would not do it: absent would mean
   * "master or planner", and the UI has to know which of the two to mark.
   */
  role: RosterRole;
  provider: ThinkerProvider;
  /** 1..MAX_THINKERS. Present only when `role` is `"thinker"`. */
  slot_index?: number;
  /** Brazilian Portuguese — it reaches the settings screen verbatim. */
  message: string;
}

export interface RosterEnvelope {
  roster: ThinkerRoster;
  providers: ProviderKeyStatus[];
  warnings: RosterWarning[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ROLE_LABEL: Record<Exclude<RosterRole, "thinker">, string> = {
  master: "O master",
  planner: "O planner",
};

function keyWarning(
  role: RosterRole,
  provider: ThinkerProvider,
  slotIndex?: number,
): RosterWarning {
  // The env var and the console url come from the module that owns the key, so
  // there is one answer to "which variable" and it cannot drift from the one the
  // setup screen shows.
  const { env_var, console_url } = providerKeyStatus(provider);
  const where = role === "thinker" ? `O pensador ${slotIndex}` : ROLE_LABEL[role];

  const warning: RosterWarning = {
    code: "provider_key_missing",
    role,
    provider,
    message:
      `${where} usa ${provider}, mas ${env_var} não está configurada — essa ` +
      `chamada vai falhar. Crie uma chave em ${console_url} e cole na tela de ` +
      "configuração.",
  };
  if (slotIndex !== undefined) warning.slot_index = slotIndex;
  return warning;
}

/**
 * One warning per row the round would actually call.
 *
 * DISABLED SLOTS ARE SKIPPED. A disabled slot keeps its model — that is the
 * point of `ThinkerSlot.enabled` — but the round never calls it, so a missing
 * key there is not a failure waiting to happen. Warning about it would put six
 * warnings on a default roster the moment the operator switches provider on one
 * enabled slot, and a warning list nobody can empty is a list nobody reads.
 */
function warningsFor(roster: ThinkerRoster): RosterWarning[] {
  const warnings: RosterWarning[] = [];

  if (!providerKeyPresent(roster.master.provider)) {
    warnings.push(keyWarning("master", roster.master.provider));
  }
  if (!providerKeyPresent(roster.planner.provider)) {
    warnings.push(keyWarning("planner", roster.planner.provider));
  }
  for (const slot of roster.slots) {
    if (!slot.enabled) continue;
    if (!providerKeyPresent(slot.model.provider)) {
      warnings.push(keyWarning("thinker", slot.model.provider, slot.index));
    }
  }

  return warnings;
}

function envelope(roster: ThinkerRoster): RosterEnvelope {
  return {
    roster,
    providers: PROVIDERS.map((provider) => providerKeyStatus(provider)),
    warnings: warningsFor(roster),
  };
}

// ---------------------------------------------------------------------------
// POST /api/thinkers/test — one minimal call per config, before it is saved
// ---------------------------------------------------------------------------

/** How long a config may take to answer. 15s names the usual dead ends. */
const TEST_TIMEOUT_MS = 15_000;

/**
 * Enough to prove the model answers without paying for a real generation —
 * the smallest the two wires accept for a plain completion.
 */
const TEST_MAX_OUTPUT_TOKENS = 10;

/**
 * The full union the type declares, NOT the narrower mirror the roster's own
 * normaliser keeps: the modal's select offers all six ("Esforço (padrão do
 * modelo)" plus minimal..max), and the test endpoint exists to answer for
 * exactly what the operator is looking at — including the levels a save would
 * not keep.
 */
const TEST_EFFORTS: readonly ReasoningEffort[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** A model id is an identifier, not a document — same ceiling as the roster. */
const MAX_TEST_MODEL_CHARS = 200;

/** The index every config's verdict is reported under, on both maps. */
function testKey(config: ModelChoice): string {
  return `${config.provider}::${config.model}::${config.effort ?? "default"}`;
}

export interface ConfigTestEnvelope {
  results: Record<string, "ok" | "error" | "skipped">;
  errors: Record<string, string>;
}

/**
 * One config from the wire, checked field by field.
 *
 * Stricter than the roster's normaliser, on purpose: `normalizeRoster` swaps a
 * bad field for a fallback and saves, while here there IS no fallback — testing
 * `provider: "openrouter"` as if it were `"deepseek"` would spend the wrong key
 * and report a truth about the wrong provider. An entry that cannot be tested
 * as sent is refused, by index and field, so the UI can point at the row.
 *
 * The checks are the same closed vocabularies the roster uses (the three
 * providers, the effort levels) plus a model id that is a string and bounded.
 * Only `provider`, `model` and `effort` matter to the call, so the rest of the
 * choice is neutral "unknown" values rather than wire-supplied numbers that
 * would have to be trusted.
 */
function normalizeTestConfig(value: unknown, index: number): ModelChoice {
  if (!isPlainObject(value)) {
    throw new OpenAIError(400, `configs[${index}] must be an object.`);
  }

  if (!isProvider(value.provider)) {
    throw new OpenAIError(
      400,
      `configs[${index}].provider must be one of ${PROVIDERS.join(", ")}.`,
    );
  }

  const model = typeof value.model === "string" ? value.model.trim() : "";
  if (model === "") {
    throw new OpenAIError(400, `configs[${index}].model must be a non-empty string.`);
  }

  const choice: ModelChoice = {
    provider: value.provider,
    model: model.slice(0, MAX_TEST_MODEL_CHARS),
    context_window: null,
    supports_tools: true,
    rate: null,
  };

  const effort = value.effort;
  if (effort !== undefined) {
    if (
      typeof effort !== "string" ||
      !(TEST_EFFORTS as readonly string[]).includes(effort)
    ) {
      throw new OpenAIError(
        400,
        `configs[${index}].effort must be one of ${TEST_EFFORTS.join(", ")}.`,
      );
    }
    choice.effort = effort as ReasoningEffort;
  }

  return choice;
}

/**
 * English, unlike the 422 below: only a caller that is not sending JSON objects
 * can see this, and that is a bug in the client, not a state the user is in.
 */
const NOT_AN_OBJECT = "Body must be a JSON object describing the roster patch.";

// GET /api/thinkers — the roster in force, plus whether it can be called
router.get("/", async (_req, res) => {
  res.json(envelope(await getRoster()));
});

// PUT /api/thinkers — a PARTIAL patch of the roster; answers with the result
router.put("/", async (req, res) => {
  const body: unknown = req.body;

  if (!isPlainObject(body)) {
    res.status(400).json({ error: NOT_AN_OBJECT });
    return;
  }

  // `null` counts as present, and is refused with the rest. A client that names
  // the field is claiming to know the protocol, and the one it named is not this
  // one; a client that does not know simply omits the key, which is the case the
  // line below lets through and `setRoster` pins to 1.
  //
  // Portuguese, unlike the 400: the realistic source is a UI build older or newer
  // than this backend — an Electron shell that did not update with it — and the
  // person who has to act on that message is the user looking at the screen.
  if (Object.hasOwn(body, "version") && body.version !== 1) {
    res.status(422).json({
      error:
        "Este servidor fala a versão 1 do roster de pensadores, e o pedido " +
        `veio com a versão ${JSON.stringify(body.version)}. Nada foi salvo — ` +
        "atualize o app para uma versão que fale o mesmo protocolo.",
    });
    return;
  }

  res.json(envelope(await setRoster(body)));
});

// POST /api/thinkers/reset — back to the defaults, for whoever tied a knot
//
// Writes the defaults rather than deleting the file, because the store exposes
// no delete. The difference is real and worth stating: a roster that was never
// written FOLLOWS the environment (`DEEP_THINK_THINKERS`, `OPENAI_TEXT_MODEL`),
// while this one freezes today's values into a file. That is the honest reading
// of a reset anyway — the operator asked for the roster they can see now, not
// for a promise to keep tracking `.env`.
router.post("/reset", async (_req, res) => {
  res.json(envelope(await setRoster(defaultRoster())));
});

// POST /api/thinkers/test — one ping per UNIQUE config, on demand
//
// The configs here are the ones the settings modal is still editing — not yet
// saved, maybe not even valid — so this route deliberately never reads the
// roster. The operator is asking which rows of the setup they are LOOKING AT
// would actually answer, and the answer is keyed by the same
// `${provider}::${model}::${effort}` string the UI built the row from.
//
// Three verdicts, per unique config:
//   - "skipped" when the provider has no key — the truth the operator needs is
//     "you cannot test this until you paste a key", not a fake failure;
//   - "ok" when the provider answered the ping;
//   - "error" when it did not, with the adapter's own message in `errors` —
//     pt-BR, and it already names the real cause (timeout, 401, bad model id).
router.post("/test", async (req, res) => {
  const body: unknown = req.body;

  if (!isPlainObject(body)) {
    res.status(400).json({ error: NOT_AN_OBJECT });
    return;
  }
  if (!Array.isArray(body.configs)) {
    res.status(400).json({ error: "Body must carry a `configs` list." });
    return;
  }

  // Throws 400 on the first entry that cannot be tested as sent — same shape
  // the other routes answer with, via `errorHandler`.
  const configs = body.configs.map((entry, index) =>
    normalizeTestConfig(entry, index),
  );

  // Dedup by the key the answer is reported under: identical rows are ONE
  // provider call, billed once. The roster can hold the same choice in several
  // slots — master, planner and slot 3 — and the operator testing the setup
  // should not pay for it three times.
  const seen = new Set<string>();
  const unique: ModelChoice[] = [];
  for (const config of configs) {
    const key = testKey(config);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(config);
  }

  const results: ConfigTestEnvelope["results"] = {};
  const errors: ConfigTestEnvelope["errors"] = {};

  // Concurrent on purpose: each call carries its own 15s deadline, and the
  // operator's question is "which rows answer" — the slowest config should not
  // hold the other verdicts hostage. The count is the modal's, a handful of
  // pings, not a fan-out.
  await Promise.all(
    unique.map(async (config) => {
      const key = testKey(config);

      if (!providerKeyPresent(config.provider)) {
        results[key] = "skipped";
        errors[key] = "Sem chave configurada";
        return;
      }

      try {
        await adapterFor(config.provider).chat({
          model: config.model,
          turns: [{ role: "user", content: "ping" }],
          // Absent means "send nothing", not "send a default": a non-reasoning
          // model rejects the field outright (same rule as `deep-think.ts`).
          ...(config.effort ? { effort: config.effort } : {}),
          maxOutputTokens: TEST_MAX_OUTPUT_TOKENS,
          timeoutMs: TEST_TIMEOUT_MS,
          signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
        });
        results[key] = "ok";
      } catch (err) {
        results[key] = "error";
        // The adapter's messages are pt-BR and name the cause (timeout, 401,
        // unknown model...). The provider's own words beat a home-grown
        // translation that could blame the wrong thing.
        errors[key] = err instanceof Error ? err.message : String(err);
      }
    }),
  );

  res.json({ results, errors });
});

export default router;
