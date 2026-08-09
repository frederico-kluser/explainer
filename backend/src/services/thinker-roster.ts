// === The thinker roster, as one file the whole application shares ===
//
// Which model each of the ten thinkers runs on, which model plans the angles and
// which one reads every trace and writes the answer. The contract is frozen in
// `types/thinker-roster.ts`; this is the half that reads it off disk, writes it
// back, and refuses to believe anything it is handed.
//
// Two decisions worth stating before the code:
//
//   - It is GLOBAL, not per conversation. `services/settings.ts` is per
//     conversation because a voice and a playback speed are properties of one
//     call. The roster is not: it is which models the operator pays for, and a
//     second conversation silently deliberating on a different bill is not a
//     feature anyone asked for. So there is one file, at the top of `DATA_ROOT`,
//     rather than a blob inside each conversation's metadata.
//   - The defaults reproduce what `services/deep-think.ts` does TODAY. Turning
//     the roster on must not change the behaviour of an operator who never opens
//     the settings screen; see `defaultRoster` for the field-by-field
//     derivation.

import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { DATA_ROOT, ensureDir } from "../middleware/sandbox.js";
import { TEXT_MODEL } from "./openai.js";
import {
  MAX_THINKERS,
  type ModelChoice,
  type ReasoningEffort,
  type ThinkerProvider,
  type ThinkerRoster,
  type ThinkerSlot,
} from "../types/thinker-roster.js";

// ---------------------------------------------------------------------------
// Where it lives
// ---------------------------------------------------------------------------

/**
 * The one roster file.
 *
 * Under `DATA_ROOT` — the same base directory `storage.ts` and `memory.ts` write
 * beneath, reached through the same `middleware/sandbox.ts` export — so there is
 * exactly one answer to "where does this app keep state", and so a data
 * directory moved by `HOME` moves this with it. Exported because the routes and
 * the tests both have reason to name the file rather than guess at it.
 */
export const ROSTER_PATH = resolve(DATA_ROOT, "thinker-roster.json");

// ---------------------------------------------------------------------------
// The closed vocabularies a stored roster is allowed to contain
// ---------------------------------------------------------------------------

// Mirrors of the unions in `types/thinker-roster.ts`. A union is erased at
// runtime and a stored roster is runtime data, so the check has to exist as a
// value — the same reason `services/memory.ts` keeps its own copies.
//
// Deliberately not read out of `services/providers/keys.ts`: that module answers
// "which key and which console", which is a different question that happens to
// be keyed by the same three names today.
const THINKER_PROVIDERS: readonly ThinkerProvider[] = [
  "openai",
  "openrouter",
  "deepseek",
];

const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  "minimal",
  "low",
  "medium",
  "high",
];

/** A model id is an identifier, not a document. */
const MAX_MODEL_ID_CHARS = 200;

/**
 * A hand-written angle rides inside that thinker's prompt on every round, so an
 * unbounded one is not a one-off cost — it is re-billed every time the roster is
 * used. `ThinkerSpec.angle` is a short label ("riscos", "custo"); 200 characters
 * is already generous for one.
 */
const MAX_ANGLE_CHARS = 200;

/** `DEEP_THINK_THINKERS` when it is unset or unusable — `.env.example` says 4. */
const DEFAULT_THINKER_COUNT = 4;

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

function isoNow(): string {
  return new Date().toISOString();
}

/**
 * How many slots are born enabled.
 *
 * Read at call time, like every tunable in `services/deep-think.ts`, and clamped
 * the way `clampThinkerCount` clamps it there — so a roster created today fans
 * out to exactly the number of thinkers the round would have picked on its own.
 */
function defaultEnabledCount(): number {
  const raw = Number(process.env.DEEP_THINK_THINKERS);
  const requested =
    Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_THINKER_COUNT;
  return Math.min(MAX_THINKERS, Math.max(1, Math.floor(requested)));
}

/**
 * The model id every role starts on: the expression `deepThinkModel()` in
 * `services/deep-think.ts` resolves, character for character.
 */
function defaultModelId(): string {
  return (
    process.env.OPENAI_DEEPTHINK_MODEL || process.env.OPENAI_TEXT_MODEL || TEXT_MODEL
  );
}

function defaultChoice(): ModelChoice {
  return {
    provider: "openai",
    model: defaultModelId(),
    context_window: null,
    supports_tools: true,
    rate: null,
  };
}

/**
 * The roster a machine that has never opened the settings screen runs on.
 *
 * Every field is derived from what `services/deep-think.ts` already does, not
 * from a preference, because switching the roster on must not change the
 * behaviour of someone who never touched it:
 *
 *   - provider `openai` — the round talks to `OPENAI_BASE_URL` with the OpenAI
 *     key, and it is the only provider deep-think has ever used.
 *   - model — `OPENAI_DEEPTHINK_MODEL || OPENAI_TEXT_MODEL || TEXT_MODEL`. The
 *     planner (`max_output_tokens: 1_200`), the thinkers (`1_400`) and the
 *     synthesiser (`1_000`) all call that one resolver today, so master, planner
 *     and every slot start on the same id. That they START together is not the
 *     same as the planner FOLLOWING the master: they are independent fields from
 *     here on, which is the point `ThinkerRoster.planner` makes about the five-
 *     fold bill a master upgrade would otherwise drag along.
 *   - enabled slots — `DEEP_THINK_THINKERS` (4 by default). The rest are born
 *     disabled but WITH the model filled in, because a disabled slot keeps its
 *     model.
 *   - `effort` absent — deep-think sends no reasoning field at all, and per
 *     `ChatRequest.effort` an absent effort means "send nothing", which is not
 *     the same as sending a default: a non-reasoning model rejects the field
 *     outright.
 *   - `supports_tools: true` — the thinkers are already called with
 *     `tools: [SEARCH_TOOL]`. It describes what the MODEL accepts; the planner
 *     and the synthesiser are called without tools regardless, and that is a
 *     call-site decision rather than a property of their model.
 *   - `context_window: null`, `rate: null` — nothing has been discovered yet.
 *     Null rate is both the honest value and the safe one here: the default id
 *     is on `services/pricing.ts`'s rate card, so the ledger already prices it,
 *     and copying the published number onto the choice would create a second
 *     rate card to keep in step with the first.
 */
export function defaultRoster(): ThinkerRoster {
  const enabled = defaultEnabledCount();

  const slots: ThinkerSlot[] = [];
  for (let index = 1; index <= MAX_THINKERS; index += 1) {
    slots.push({ index, enabled: index <= enabled, model: defaultChoice() });
  }

  return {
    version: 1,
    master: defaultChoice(),
    planner: defaultChoice(),
    slots,
    updated_at: isoNow(),
  };
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A number, or nothing.
 *
 * Not `Number(value)`: that maps `null`, `""` and `[]` to 0 and `true` to 1, and
 * every caller below treats 0 as a meaningful reading. A numeric string is
 * accepted because form inputs produce them — the same allowance
 * `normalizeSettings` makes for `speed`.
 */
function finiteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeProvider(
  value: unknown,
  fallback: ThinkerProvider,
): ThinkerProvider {
  return typeof value === "string" &&
    (THINKER_PROVIDERS as readonly string[]).includes(value)
    ? (value as ThinkerProvider)
    : fallback;
}

/** Undefined for anything outside the four levels — see `defaultRoster`. */
function normalizeEffort(value: unknown): ReasoningEffort | undefined {
  return typeof value === "string" &&
    (REASONING_EFFORTS as readonly string[]).includes(value)
    ? (value as ReasoningEffort)
    : undefined;
}

function normalizeModelId(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed === "" ? fallback : trimmed.slice(0, MAX_MODEL_ID_CHARS);
}

/**
 * A context window is a positive count of tokens, or it is unknown.
 *
 * Zero, a negative and a fraction all become `null` rather than a number,
 * because `ModelChoice.context_window` says `null` is the conservative FLOOR the
 * budgeter has to assume. A stored `0` would read instead as a real window of no
 * tokens, which is a thing no model has and no budgeter expects.
 */
function normalizeContextWindow(value: unknown): number | null {
  const parsed = finiteNumber(value);
  if (parsed === null || parsed <= 0) return null;
  return Math.floor(parsed);
}

/**
 * A rate survives only whole.
 *
 * All three numbers or none. A half-read rate completed with zeros is
 * indistinguishable from a model that really is free once it has been written to
 * disk — the same silent zero `services/pricing.ts` reports for a model it has
 * never heard of, arriving through another door. `null` at least means "ask the
 * rate card", which is a question with an answer.
 */
function normalizeRate(value: unknown): ModelChoice["rate"] {
  if (!isPlainObject(value)) return null;

  const input = finiteNumber(value.input);
  const cached_input = finiteNumber(value.cached_input);
  const output = finiteNumber(value.output);

  if (input === null || cached_input === null || output === null) return null;
  if (input < 0 || cached_input < 0 || output < 0) return null;

  return { input, cached_input, output };
}

function normalizeTimestamp(value: unknown): string | undefined {
  return typeof value === "string" && !Number.isNaN(Date.parse(value))
    ? value
    : undefined;
}

function normalizeChoice(value: unknown, fallback: ModelChoice): ModelChoice {
  if (!isPlainObject(value)) return { ...fallback };

  const choice: ModelChoice = {
    provider: normalizeProvider(value.provider, fallback.provider),
    model: normalizeModelId(value.model, fallback.model),
    context_window: normalizeContextWindow(value.context_window),
    supports_tools:
      typeof value.supports_tools === "boolean"
        ? value.supports_tools
        : fallback.supports_tools,
    rate: normalizeRate(value.rate),
  };

  // Both optional fields are assigned only when they survived, so a rejected
  // value leaves no key behind — not on disk, and not on the object a route
  // hands to the browser.
  const effort = normalizeEffort(value.effort);
  if (effort) choice.effort = effort;

  const discoveredAt = normalizeTimestamp(value.discovered_at);
  if (discoveredAt) choice.discovered_at = discoveredAt;

  return choice;
}

function normalizeSlot(
  value: unknown,
  index: number,
  fallback: ThinkerSlot,
): ThinkerSlot {
  if (!isPlainObject(value)) {
    return { index, enabled: fallback.enabled, model: { ...fallback.model } };
  }

  const slot: ThinkerSlot = {
    // Positional, never what the entry claimed: `normalizeRoster` has already
    // decided which row this is.
    index,
    enabled:
      typeof value.enabled === "boolean" ? value.enabled : fallback.enabled,
    // Normalised whether or not the slot is enabled. A disabled slot KEEPS its
    // model, so a round trip through disk must not be the thing that loses it.
    model: normalizeChoice(value.model, fallback.model),
  };

  if (typeof value.angle === "string") {
    const angle = value.angle.trim().slice(0, MAX_ANGLE_CHARS);
    if (angle !== "") slot.angle = angle;
  }

  return slot;
}

/**
 * Make a trustworthy roster out of whatever arrived.
 *
 * Everything here comes off disk or off the wire, so nothing is trusted — the
 * same premise as `normalizeSettings`, and the same policy: a value out of range
 * is corrected rather than rejected, and an absent field falls to the default.
 * Refusing the whole roster because one number was wrong would cost the operator
 * every model they picked.
 *
 * The one exception is `version`. `ThinkerRoster.version` exists so an old
 * stored roster "can be read or refused", and this is the refusal: anything that
 * is not exactly `1` is a shape this build does not know how to read, there is no
 * field-by-field repair for a structure that may have moved, and quietly
 * salvaging half of it would hand the round a roster nobody wrote. It falls back
 * to `defaultRoster()` and says so on the console — the same call
 * `services/memory.ts` makes for a memory file whose version it does not know.
 *
 * What it guarantees on the way out:
 *
 *   - exactly `MAX_THINKERS` slots, `index` 1..MAX_THINKERS in order, no
 *     duplicates;
 *   - `provider` one of the three, `effort` one of the four or absent;
 *   - `model` a non-empty string;
 *   - `context_window` and `rate` `null` whenever they were not fully readable.
 */
export function normalizeRoster(value: unknown): ThinkerRoster {
  const defaults = defaultRoster();
  if (!isPlainObject(value)) return defaults;

  if (value.version !== 1) {
    console.warn(
      `[thinker-roster] refusing a roster whose version is ${JSON.stringify(value.version)} ` +
        "(this build reads version 1); falling back to the default roster",
    );
    return defaults;
  }

  const stored = Array.isArray(value.slots) ? value.slots : [];
  const claimed = new Map<number, Record<string, unknown>>();
  const unplaced: Record<string, unknown>[] = [];

  for (const entry of stored) {
    if (!isPlainObject(entry)) continue;

    const index = finiteNumber(entry.index);
    // A claim is honoured when it is a whole number in range that nobody else
    // took. Everything else — a duplicate, a 0, a 99, "abc", a missing field —
    // is repaired rather than dropped: the entry keeps its model and lands in
    // the first free row below. `index` is addressing, and losing a model the
    // operator chose over a bad integer is the expensive half of that mistake.
    if (
      index !== null &&
      Number.isInteger(index) &&
      index >= 1 &&
      index <= MAX_THINKERS &&
      !claimed.has(index)
    ) {
      claimed.set(index, entry);
    } else {
      unplaced.push(entry);
    }
  }

  const slots: ThinkerSlot[] = [];
  for (let index = 1; index <= MAX_THINKERS; index += 1) {
    // Rows the stored roster never mentioned are born exactly as
    // `defaultRoster()` would have made them.
    const fallback = defaults.slots[index - 1]!;
    slots.push(normalizeSlot(claimed.get(index) ?? unplaced.shift(), index, fallback));
  }

  return {
    version: 1,
    master: normalizeChoice(value.master, defaults.master),
    planner: normalizeChoice(value.planner, defaults.planner),
    slots,
    updated_at: normalizeTimestamp(value.updated_at) ?? defaults.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

interface NodeError extends Error {
  code: string;
}

function isNodeError(err: unknown): err is NodeError {
  return err instanceof Error && "code" in err;
}

/**
 * Write atomically via temp file + rename.
 *
 * A copy of the helper in `storage.ts`, for the reason `memory.ts` records next
 * to its own copy: that one is module-private, and exporting it to share it
 * would promote an internal detail of conversation persistence into API. What is
 * not optional is the atomicity — a roster truncated by a write that died
 * halfway does not parse, and a roster that does not parse takes deep_think with
 * it on the next round.
 */
async function atomicWrite(targetPath: string, data: string): Promise<void> {
  const tmpPath = `${targetPath}.tmp.${randomUUID()}`;
  try {
    await writeFile(tmpPath, data, "utf-8");
    await rename(tmpPath, targetPath);
  } catch (err) {
    // Best-effort cleanup: don't shadow the original error.
    try {
      await unlink(tmpPath);
    } catch {
      // ignore
    }
    throw err;
  }
}

// The roster is one file read-modify-written whole, so two overlapping writes
// lose whichever finished first. Same shape as `withConversationLock` in
// `storage.ts`, with a single chain instead of a map because there is a single
// roster.
//
// `previous.then(operation, operation)` — the same operation on both settle
// paths — is the load-bearing part: chain on success alone and one failed write
// leaves the chain permanently rejected, so every later write is silently
// dropped for the life of the process.
let writeQueue: Promise<unknown> = Promise.resolve();

function withRosterLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = writeQueue.then(operation, operation);
  writeQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * The roster as it was last read or written.
 *
 * Every deep-think round reads it, and this process is the only writer, so a
 * cached copy cannot go stale behind our back. It is handed out as a clone: a
 * caller that mutated the object it was given would be editing the process-wide
 * roster, and the next round would run on an edit nobody saved.
 */
let cache: ThinkerRoster | null = null;

/**
 * Bumped by every completed write.
 *
 * A read that started before a write and finished after it is holding the
 * PREVIOUS version of the file, and caching that would leave the process running
 * on the old models until it restarts — with nothing to see, since the file on
 * disk is correct. So a read only installs its result when the counter has not
 * moved underneath it.
 */
let writeGeneration = 0;

/**
 * Drop the in-memory copy so the next read comes off disk.
 *
 * Nothing in production needs this — the process owns the file. It exists so a
 * test can stage a file directly, and so a future "reload from disk" action has
 * something to call after the operator hand-edits the roster.
 */
export function forgetRoster(): void {
  cache = null;
  writeGeneration += 1;
}

/**
 * The roster in force. Never throws for want of a usable file.
 *
 * A missing file is the normal first-run state, and reading does NOT create one:
 * only a write creates the file. That matters because the defaults follow the
 * environment — writing them here would freeze today's `DEEP_THINK_THINKERS` and
 * today's model id into a file that stops tracking `.env` from then on.
 */
export async function getRoster(): Promise<ThinkerRoster> {
  if (cache) return structuredClone(cache);

  const generation = writeGeneration;

  let raw: string;
  try {
    raw = await readFile(ROSTER_PATH, "utf-8");
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === "ENOENT") return defaultRoster();
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // Not cached and not deleted: the bytes stay for an operator to look at, and
    // the next `setRoster` replaces them. Failing instead would make one bad
    // byte on disk disable deliberation permanently.
    console.warn(
      `[thinker-roster] ${ROSTER_PATH} is not valid JSON; using the default roster:`,
      err instanceof Error ? err.message : String(err),
    );
    return defaultRoster();
  }

  const roster = normalizeRoster(parsed);
  if (writeGeneration === generation) cache = roster;
  return structuredClone(roster);
}

/**
 * Merge `patch` over the roster in force, re-normalise, and persist.
 *
 * Shallow, like `setSettings`: a patch carrying a LIST of `slots` replaces the
 * whole list (normalised straight back to `MAX_THINKERS` entries), one that does
 * not carry it leaves the list alone. `updated_at` is stamped here rather than
 * taken from the patch — it records when this write happened, which is not
 * something a caller can know.
 *
 * Two keys a patch does not get to decide, both for the same reason: this
 * function PERSISTS what it builds, so a value that makes `normalizeRoster`
 * discard the merge does not fail the request, it overwrites the operator's
 * roster. See the two comments in the body.
 */
export async function setRoster(patch: unknown): Promise<ThinkerRoster> {
  return withRosterLock(async () => {
    // Invalidated first, then re-read inside the lock: the merge is a
    // read-modify-write, and what it modifies has to be what is actually stored
    // — not a copy this process cached before the previous write landed.
    cache = null;
    const current = await getRoster();

    // Copied, because the two guards below edit the patch rather than the merge:
    // a caller's object is not ours to mutate.
    const incoming: Record<string, unknown> = isPlainObject(patch)
      ? { ...patch }
      : {};

    // A `slots` that is not a list is not an empty list. `{ slots: [] }` keeps
    // its meaning — an empty list IS a list, and normalising it returns the ten
    // default rows — but `{ slots: null }`, `{ slots: {} }` or a string is
    // unreadable, and the policy for the unreadable is to clamp it rather than
    // act on it. Dropping the key here makes the patch behave as if it had never
    // mentioned slots, so the rows the operator configured stay where they are.
    if (!Array.isArray(incoming.slots)) delete incoming.slots;

    const merged = normalizeRoster({
      ...current,
      ...incoming,
      // Pinned AFTER the spread, and never read off the patch.
      //
      // A spread copies a key whose value is `undefined`, so `{ version:
      // undefined }` — or the `{"version": null}` a JSON body parses into —
      // would replace the `1` that `current` carries by construction, and
      // `normalizeRoster` would then refuse the whole merge and hand back the
      // default roster, which the lines below would write over the operator's
      // models.
      //
      // The asymmetry with the read path is the point. Refusing an unknown
      // version while READING is safe: `getRoster` does not write, so a file
      // this build cannot parse stays on disk, intact, for someone to inspect.
      // Refusing it while WRITING destroys exactly what the refusal was meant to
      // protect. The write path never needed to ask what version a patch claimed:
      // the roster being merged over was already read and normalised as version 1.
      version: 1,
    });
    merged.updated_at = isoNow();

    await ensureDir(DATA_ROOT);
    await atomicWrite(ROSTER_PATH, JSON.stringify(merged, null, 2));

    cache = merged;
    writeGeneration += 1;
    return structuredClone(merged);
  });
}
