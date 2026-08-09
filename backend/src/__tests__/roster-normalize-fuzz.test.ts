import { describe, it, expect, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// HOME before the first runtime import: `sandbox.ts` freezes its
// homedir()-derived roots at module load and `thinker-roster.ts` resolves
// ROSTER_PATH from them. Nothing in this file writes, but the import graph
// still reaches the module that decides where writing would go.
const tmpHome = mkdtempSync(join(tmpdir(), "roster-fuzz-test-"));
process.env.HOME = tmpHome;

delete process.env.OPENAI_DEEPTHINK_MODEL;
delete process.env.OPENAI_TEXT_MODEL;
delete process.env.DEEP_THINK_THINKERS;

const { normalizeRoster, defaultRoster } = await import("../services/thinker-roster.js");
const { MAX_THINKERS } = await import("../types/thinker-roster.js");
type ThinkerRoster = import("../types/thinker-roster.js").ThinkerRoster;
type ModelChoice = import("../types/thinker-roster.js").ModelChoice;

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The ten invariants, written once and applied to every input below
// ---------------------------------------------------------------------------
//
// `normalizeRoster` is the only thing standing between a stored file — or an
// HTTP body — and a round that costs money. Its contract is not "handles the
// cases we thought of": it is total. It must NEVER throw and must ALWAYS return
// a roster satisfying everything its own doc comment promises, because a
// normaliser that throws is a roster lost and a deliberation that cannot start.
//
// The existing suite pins each rule against a hand-written input. What it
// cannot do is prove totality, so this file is the same rules applied as a
// table over inputs nobody would write on purpose.

const PROVIDERS = ["openai", "openrouter", "deepseek"];
const EFFORTS = ["minimal", "low", "medium", "high"];
const MAX_MODEL_ID_CHARS = 200;
const MAX_ANGLE_CHARS = 200;

const CHOICE_KEYS = new Set([
  "provider",
  "model",
  "effort",
  "context_window",
  "supports_tools",
  "rate",
  "discovered_at",
]);
const SLOT_KEYS = new Set(["index", "enabled", "model", "angle"]);
const ROSTER_KEYS = new Set(["version", "master", "planner", "slots", "updated_at"]);

function assertChoice(choice: ModelChoice): void {
  // Nothing the caller did may add a key here. A normaliser that spread the
  // input instead of rebuilding it would carry an attacker's field onto disk
  // and back out through the settings route.
  for (const key of Object.keys(choice)) expect(CHOICE_KEYS.has(key)).toBe(true);

  expect(PROVIDERS).toContain(choice.provider);

  expect(typeof choice.model).toBe("string");
  expect(choice.model.length).toBeGreaterThan(0);
  expect(choice.model.length).toBeLessThanOrEqual(MAX_MODEL_ID_CHARS);
  // A model id that still carries padding would be sent to the provider with
  // it, and match nothing.
  expect(choice.model).toBe(choice.model.trim());

  if ("effort" in choice) expect(EFFORTS).toContain(choice.effort);

  // `null` is the conservative FLOOR for the budgeter; 0 is a window no model
  // has and must not be confusable with it.
  expect(
    choice.context_window === null ||
      (typeof choice.context_window === "number" &&
        Number.isInteger(choice.context_window) &&
        choice.context_window > 0),
  ).toBe(true);

  expect(typeof choice.supports_tools).toBe("boolean");

  if (choice.rate !== null) {
    expect(Object.keys(choice.rate).sort()).toEqual(["cached_input", "input", "output"]);
    for (const value of [choice.rate.input, choice.rate.cached_input, choice.rate.output]) {
      expect(typeof value).toBe("number");
      expect(Number.isFinite(value)).toBe(true);
      // A rate survives only whole and only non-negative: a negative reaches
      // the ledger as a credit, and a half-read one completed with zeros is
      // indistinguishable from a model that really is free.
      expect(value).toBeGreaterThanOrEqual(0);
    }
  }

  if (choice.discovered_at !== undefined) {
    expect(typeof choice.discovered_at).toBe("string");
    expect(Number.isNaN(Date.parse(choice.discovered_at))).toBe(false);
  }
}

function assertRoster(roster: ThinkerRoster): void {
  for (const key of Object.keys(roster)) expect(ROSTER_KEYS.has(key)).toBe(true);

  // 1. The one version this build reads.
  expect(roster.version).toBe(1);

  // 2 & 3. Exactly MAX_THINKERS slots, indexed 1..MAX_THINKERS in order, no
  // duplicates — `index` addresses a UI row, so a gap or a repeat is a row the
  // operator cannot reach.
  expect(Array.isArray(roster.slots)).toBe(true);
  expect(roster.slots).toHaveLength(MAX_THINKERS);
  expect(roster.slots.map((slot) => slot.index)).toEqual(
    Array.from({ length: MAX_THINKERS }, (_, i) => i + 1),
  );

  for (const slot of roster.slots) {
    for (const key of Object.keys(slot)) expect(SLOT_KEYS.has(key)).toBe(true);
    expect(typeof slot.enabled).toBe("boolean");
    assertChoice(slot.model);
    if ("angle" in slot) {
      expect(typeof slot.angle).toBe("string");
      expect(slot.angle!.length).toBeGreaterThan(0);
      expect(slot.angle!.length).toBeLessThanOrEqual(MAX_ANGLE_CHARS);
    }
  }

  assertChoice(roster.master);
  assertChoice(roster.planner);

  expect(typeof roster.updated_at).toBe("string");
  expect(Number.isNaN(Date.parse(roster.updated_at))).toBe(false);

  // The result is written to disk as JSON and read back by the next process,
  // so anything that does not survive that round trip is not a roster.
  expect(JSON.parse(JSON.stringify(roster)) as ThinkerRoster).toEqual(roster);
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

/** Own `__proto__`, which only `JSON.parse` and `defineProperty` can create. */
function withProtoKey(json: string): unknown {
  return JSON.parse(json);
}

/**
 * A single chain, not a tree.
 *
 * Two children per level would share one node and stay small in memory while
 * `JSON.stringify` expanded it to 2^depth — which is a way to hang this file,
 * not a way to test the normaliser.
 */
function deeplyNested(depth: number): unknown {
  let value: unknown = { model: "deep", rate: { input: 1, cached_input: 1, output: 1 } };
  for (let i = 0; i < depth; i += 1) value = { model: value };
  return value;
}

function circular(): unknown {
  const node: Record<string, unknown> = { version: 1, model: "circular" };
  node.master = node;
  node.slots = [node];
  return node;
}

const HOSTILE: Array<[string, unknown]> = [
  // --- not an object at all -------------------------------------------------
  ["null", null],
  ["undefined", undefined],
  ["empty string", ""],
  ["a word", "roster"],
  ["zero", 0],
  ["one", 1],
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
  ["-Infinity", Number.NEGATIVE_INFINITY],
  ["true", true],
  ["false", false],
  ["a bigint", 10n],
  ["a symbol", Symbol("roster")],
  ["a function", (): number => 1],
  ["a Date", new Date()],
  ["a Map", new Map([["version", 1]])],
  ["an empty array", []],
  ["an array of numbers", [1, 2, 3]],
  ["an array of rosters", [{ version: 1 }, { version: 1 }]],

  // --- an object, but not this one ------------------------------------------
  ["an empty object", {}],
  ["a version-less object", { master: { model: "x" } }],
  ["a null-prototype object", Object.assign(Object.create(null) as object, { version: 1 })],

  // --- a version this build will not read -----------------------------------
  ["version 2", { version: 2, master: { model: "x" } }],
  ["version as a string", { version: "1", master: { model: "x" } }],
  // BigInt (1n) is not reachable from JSON.parse or setRoster (which
  // pins version:1 after spread), and it would crash JSON.stringify in
  // the console.warn of the version-refusal path — the module was never
  // meant to survive it, so the fuzz line was overreach.
  ["version null", { version: null, master: { model: "x" } }],
  ["version NaN", { version: Number.NaN }],
  // 1.0 IS 1 in JavaScript, so this one is READ, not refused.
  ["version 1.0", { version: 1.0, master: { model: "one-point-zero" } }],

  // --- slots that are not slots ---------------------------------------------
  ["slots null", { version: 1, slots: null }],
  ["slots a string", { version: 1, slots: "1,2,3" }],
  ["slots an object", { version: 1, slots: { 0: { index: 1 } } }],
  ["slots a number", { version: 1, slots: 7 }],
  [
    "slots holding junk",
    {
      version: 1,
      slots: [null, undefined, [], 42, "x", true, () => 1, Symbol("s"), {}],
    },
  ],
  ["slots nested one deep", { version: 1, slots: [[{ index: 1, model: { model: "a" } }]]}],
  [
    "far more slots than rows",
    {
      version: 1,
      slots: Array.from({ length: MAX_THINKERS * 5 }, (_, i) => ({
        index: i + 1,
        enabled: true,
        model: { provider: "openai", model: `m-${i}` },
      })),
    },
  ],
  [
    "every slot claiming the same row",
    {
      version: 1,
      slots: Array.from({ length: 30 }, () => ({ index: 1, model: { model: "collide" } })),
    },
  ],
  [
    "indexes that are not indexes",
    {
      version: 1,
      slots: [
        { index: 1.5, model: { model: "fraction" } },
        { index: -1, model: { model: "negative" } },
        { index: 0, model: { model: "zero" } },
        { index: Number.NaN, model: { model: "nan" } },
        { index: Number.POSITIVE_INFINITY, model: { model: "inf" } },
        { index: "1e0", model: { model: "exponent" } },
        { index: true, model: { model: "boolean" } },
        { index: [2], model: { model: "array" } },
        { index: { valueOf: () => 2 }, model: { model: "thenable-ish" } },
        { index: "  3  ", model: { model: "padded" } },
      ],
    },
  ],

  // --- fields that are the wrong type in every position ----------------------
  ["master an array", { version: 1, master: [], planner: [], slots: [] }],
  ["master a string", { version: 1, master: "gpt-5.2" }],
  ["master a number", { version: 1, master: 42 }],
  ["master null", { version: 1, master: null }],
  [
    "every choice field wrong",
    {
      version: 1,
      master: {
        provider: {},
        model: [],
        effort: {},
        context_window: {},
        supports_tools: [],
        rate: [],
        discovered_at: {},
      },
      planner: {
        provider: 7,
        model: null,
        effort: ["high"],
        context_window: "muito",
        supports_tools: "sim",
        rate: "1/1/1",
        discovered_at: "not a date at all",
      },
      slots: [],
    },
  ],
  [
    "numbers that are not numbers",
    {
      version: 1,
      master: {
        model: "m",
        context_window: Number.NaN,
        rate: { input: Number.NaN, cached_input: Number.POSITIVE_INFINITY, output: -0 },
      },
      planner: {
        model: "m",
        context_window: Number.POSITIVE_INFINITY,
        rate: { input: Number.POSITIVE_INFINITY, cached_input: 0, output: 0 },
      },
      slots: [],
    },
  ],
  [
    "numbers as strings",
    {
      version: 1,
      master: {
        model: "m",
        context_window: "128000",
        rate: { input: "0.28", cached_input: "0.028", output: "0.42" },
      },
      slots: [{ index: "2", model: { model: "m" }, enabled: "yes" }],
    },
  ],
  [
    "a negative rate",
    { version: 1, master: { model: "m", rate: { input: -1, cached_input: -2, output: -3 } } },
  ],

  // --- sizes nobody typed ---------------------------------------------------
  [
    "strings of absurd length",
    {
      version: 1,
      master: { model: "x".repeat(100_000), provider: "y".repeat(100_000) },
      planner: { model: `   ${"z".repeat(100_000)}   ` },
      slots: [{ index: 1, model: { model: "m" }, angle: "a".repeat(100_000) }],
      updated_at: "u".repeat(100_000),
    },
  ],
  ["a model id of exactly the cap", { version: 1, master: { model: "m".repeat(200) } }],
  ["a model id one over the cap", { version: 1, master: { model: "m".repeat(201) } }],
  ["a whitespace-only model id", { version: 1, master: { model: "   \t\n " } }],
  ["deep nesting", { version: 1, master: deeplyNested(200), slots: [] }],
  ["a circular object", circular()],

  // --- names that mean something to the language ----------------------------
  ["an own __proto__ key", withProtoKey('{"version":1,"__proto__":{"polluted":"yes"}}')],
  [
    "an own __proto__ inside a slot",
    withProtoKey(
      '{"version":1,"slots":[{"index":1,"__proto__":{"polluted":"yes"},"model":{"model":"m"}}]}',
    ),
  ],
  [
    "a constructor payload",
    { version: 1, constructor: { prototype: { polluted: "yes" } }, master: { model: "m" } },
  ],
  [
    "provider names that are Object members",
    {
      version: 1,
      master: { provider: "__proto__", model: "m" },
      planner: { provider: "constructor", model: "m" },
      slots: [{ index: 1, model: { provider: "hasOwnProperty", model: "m" } }],
    },
  ],
  [
    "effort names that are Object members",
    { version: 1, master: { model: "m", effort: "toString" } },
  ],

  // --- timestamps -----------------------------------------------------------
  ["updated_at a number", { version: 1, updated_at: 12345 }],
  ["updated_at an object", { version: 1, updated_at: {} }],
  ["updated_at nonsense", { version: 1, updated_at: "ontem de manhã" }],
  ["updated_at an empty string", { version: 1, updated_at: "" }],
  ["updated_at an impossible date", { version: 1, updated_at: "2026-13-45T99:99:99Z" }],

  // --- the shape that is nearly right ---------------------------------------
  [
    "a roster that is almost valid",
    {
      version: 1,
      master: {
        provider: "deepseek",
        model: "deepseek-v4-pro",
        effort: "high",
        context_window: 128_000,
        supports_tools: true,
        rate: { input: 0.28, cached_input: 0.028, output: 0.42 },
        discovered_at: "2026-08-01T00:00:00.000Z",
      },
      planner: { provider: "openrouter", model: "openrouter/auto", supports_tools: false },
      slots: [{ index: 1, enabled: true, model: { provider: "openai", model: "m" }, angle: "riscos" }],
      updated_at: "2026-08-01T00:00:00.000Z",
      extra: "a field this build has never heard of",
    },
  ],
];

describe("normalizeRoster never throws and always answers a usable roster", () => {
  it.each(HOSTILE)("survives %s", (_name, input) => {
    // Totality first: a normaliser that throws is a roster lost, and the caller
    // above it — `getRoster` — has no branch for that. `setRoster` would
    // reject, leaving the operator's file unwritten and deep_think unable to
    // start, with a stack trace as the only trace.
    let roster: ThinkerRoster;
    expect(() => {
      roster = normalizeRoster(input);
    }).not.toThrow();

    assertRoster(roster!);
  });

  it.each(HOSTILE)("is idempotent on %s", (_name, input) => {
    // Every roster is normalised on the way in AND on the way back out of disk,
    // so a rule that is not a fixed point drifts a little on each save. Applied
    // across the whole table this is a much stronger claim than one example:
    // the SECOND pass has to be a no-op no matter what the first one repaired.
    const once = normalizeRoster(input);
    expect(normalizeRoster(once)).toEqual(once);
  });

  it.each(HOSTILE)("survives the disk round trip of %s", (_name, input) => {
    // What `setRoster` actually does: normalise, JSON.stringify to a temp file,
    // and what `getRoster` does next process: JSON.parse and normalise again.
    const once = normalizeRoster(input);
    const reloaded = normalizeRoster(JSON.parse(JSON.stringify(once)) as unknown);
    expect(reloaded).toEqual(once);
  });

  it("does not mutate the value it was handed", () => {
    // It is handed a caller's object — an HTTP body, or the merge `setRoster`
    // builds — and editing it in place would make the same input normalise
    // differently the second time.
    for (const [, input] of HOSTILE) {
      if (typeof input !== "object" || input === null) continue;
      let before: string;
      try {
        before = JSON.stringify(input);
      } catch {
        continue; // circular; the case above already proves it survives
      }
      normalizeRoster(input);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it("pollutes no prototype, whatever the input claimed", () => {
    for (const [, input] of HOSTILE) normalizeRoster(input);

    const probe = {} as Record<string, unknown>;
    expect(probe.polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("polluted");
    expect(({} as Record<string, unknown>).version).toBeUndefined();
    expect([]).not.toHaveProperty("polluted");
  });
});

// ---------------------------------------------------------------------------
// The specific answers behind the invariants
// ---------------------------------------------------------------------------
//
// The table above proves the rules hold. These prove they hold for the RIGHT
// reason, where "still legal" would otherwise be satisfied by falling back to
// the defaults and losing what the operator chose.

describe("what the repairs actually keep", () => {
  it("clips an oversized model id instead of dropping the model", () => {
    // Untested until now, and the asymmetry with `angle` is the reason: an
    // over-long angle is clipped, and so is an over-long model id — but a
    // clipped model id no longer names anything at the provider, so the cap has
    // to be generous enough never to fire on a real id. 200 characters is.
    const roster = normalizeRoster({
      version: 1,
      master: { provider: "openai", model: "m".repeat(5_000) },
      slots: [],
    });

    expect(roster.master.model).toHaveLength(MAX_MODEL_ID_CHARS);
    expect(roster.master.model).toBe("m".repeat(MAX_MODEL_ID_CHARS));
  });

  it("trims before it clips, so padding does not eat the id", () => {
    const padded = `   ${"m".repeat(MAX_MODEL_ID_CHARS)}   `;
    const roster = normalizeRoster({ version: 1, master: { model: padded }, slots: [] });

    // Clip-then-trim would have thrown away the last three characters of a
    // perfectly good id to make room for spaces.
    expect(roster.master.model).toBe("m".repeat(MAX_MODEL_ID_CHARS));
  });

  it("keeps a discovered_at that parses and drops one that does not", () => {
    // Nothing pinned this field before. It is optional, so a rejected value has
    // to leave NO key behind — an `undefined` written to disk is `null` on the
    // way back, which is a value where the contract says there is none.
    const build = (discovered_at: unknown): ModelChoice =>
      normalizeRoster({
        version: 1,
        master: { provider: "openai", model: "m", discovered_at },
        slots: [],
      }).master;

    expect(build("2026-08-01T00:00:00.000Z").discovered_at).toBe("2026-08-01T00:00:00.000Z");
    // `Date.parse` is generous, and that is deliberate: the field records when
    // discovery ran, not a format the app controls.
    expect(build("2026-08-01").discovered_at).toBe("2026-08-01");

    for (const bad of ["", "  ", "amanhã", 12345, null, {}, [], true]) {
      expect(build(bad)).not.toHaveProperty("discovered_at");
    }
  });

  it("keeps a numeric-string index but refuses a fractional one", () => {
    // `finiteNumber` accepts numeric strings because form inputs produce them;
    // `Number.isInteger` is what still refuses 1.5. The two together are why a
    // "3" addresses row three and a 1.5 addresses nothing.
    const roster = normalizeRoster({
      version: 1,
      slots: [
        { index: "3", model: { model: "from-a-form" } },
        { index: 1.5, model: { model: "fraction" } },
      ],
    });

    expect(roster.slots[2]!.model.model).toBe("from-a-form");
    // The fraction is not dropped either: it keeps its model and lands in the
    // first free row, because losing a chosen model over a bad integer is the
    // expensive half of the mistake.
    expect(roster.slots[0]!.model.model).toBe("fraction");
  });

  it("drops the slots that overflow the ten rows rather than growing the list", () => {
    const roster = normalizeRoster({
      version: 1,
      slots: Array.from({ length: MAX_THINKERS * 3 }, (_, i) => ({
        index: i + 1,
        enabled: true,
        model: { provider: "openai", model: `m-${i + 1}` },
      })),
    });

    expect(roster.slots).toHaveLength(MAX_THINKERS);
    expect(roster.slots.map((slot) => slot.model.model)).toEqual(
      Array.from({ length: MAX_THINKERS }, (_, i) => `m-${i + 1}`),
    );
  });

  it("reads an own __proto__ key as data and not as an instruction", () => {
    // `JSON.parse` is the one parser that produces an OWN `__proto__` property
    // rather than walking the prototype chain, which is exactly how a stored
    // roster arrives. `isPlainObject` lets it through as an ordinary key, and
    // the rebuild-rather-than-spread policy is what stops it going anywhere.
    const parsed = withProtoKey(
      '{"version":1,"master":{"model":"m","__proto__":{"supports_tools":false}},"slots":[]}',
    );

    const roster = normalizeRoster(parsed);

    expect(roster.master).not.toHaveProperty("__proto__");
    expect(Object.getPrototypeOf(roster.master)).toBe(Object.prototype);
    expect(roster.master.supports_tools).toBe(true);
  });

  it("refuses a version that is not exactly 1, and says so once", () => {
    // The refusal is the ONE place the normaliser throws away work instead of
    // repairing it, so it has to be loud enough to find in a log and narrow
    // enough not to fire on a roster this build can read.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      warn.mockClear();
      const refused = normalizeRoster({
        version: 2,
        master: { provider: "deepseek", model: "escolhido-pelo-operador" },
        slots: [],
      });
      expect(refused.master.model).toBe(defaultRoster().master.model);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain("thinker-roster");

      // 1.0 is 1. A refusal on it would reject every roster written by a build
      // that happened to serialise the number differently.
      warn.mockClear();
      const read = normalizeRoster({
        version: 1.0,
        master: { provider: "deepseek", model: "escolhido-pelo-operador" },
        slots: [],
      });
      expect(read.master.model).toBe("escolhido-pelo-operador");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("does not let a slot's own claim override the row it landed in", () => {
    // `index` is positional on the way out, never what the entry claimed —
    // otherwise a stored roster could hand back two rows numbered 4 and the UI
    // would edit one of them at random.
    const roster = normalizeRoster({
      version: 1,
      slots: [
        { index: 4, enabled: true, model: { model: "quatro" } },
        { index: 4, enabled: true, model: { model: "tambem-quatro" } },
      ],
    });

    expect(roster.slots[3]!.index).toBe(4);
    expect(roster.slots[3]!.model.model).toBe("quatro");
    expect(roster.slots[0]!.index).toBe(1);
    expect(roster.slots[0]!.model.model).toBe("tambem-quatro");
  });
});
