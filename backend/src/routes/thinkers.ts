import { Router } from "express";

import {
  PROVIDERS,
  providerKeyPresent,
  providerKeyStatus,
  type ProviderKeyStatus,
} from "../services/providers/keys.js";
import {
  defaultRoster,
  getRoster,
  setRoster,
} from "../services/thinker-roster.js";
import type { ThinkerProvider, ThinkerRoster } from "../types/thinker-roster.js";

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

export default router;
