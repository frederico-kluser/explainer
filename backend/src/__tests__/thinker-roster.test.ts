import { describe, it, expect, afterAll } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  existsSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ModelChoice, ThinkerRoster } from "../types/thinker-roster.js";

// `sandbox.ts` freezes its homedir()-derived roots at module load, so HOME has
// to point at a temp dir BEFORE anything imports it. Same technique as
// `storage.test.ts`.
const tmpHome = mkdtempSync(join(tmpdir(), "thinker-roster-test-"));
process.env.HOME = tmpHome;

// The defaults follow the environment on purpose. Pinning it here is what makes
// the "reproduces what deep_think does today" assertions mean anything.
delete process.env.OPENAI_DEEPTHINK_MODEL;
delete process.env.OPENAI_TEXT_MODEL;
delete process.env.DEEP_THINK_THINKERS;

const {
  ROSTER_PATH,
  defaultRoster,
  normalizeRoster,
  getRoster,
  setRoster,
  forgetRoster,
} = await import("../services/thinker-roster.js");
const { TEXT_MODEL } = await import("../services/openai.js");
const { MAX_THINKERS } = await import("../types/thinker-roster.js");

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

function choice(model: string): ModelChoice {
  return {
    provider: "openai",
    model,
    context_window: null,
    supports_tools: true,
    rate: null,
  };
}

/** Stage a file the way a previous build — or a hand edit — would have left it. */
function writeStoredRoster(value: unknown): void {
  mkdirSync(dirname(ROSTER_PATH), { recursive: true });
  writeFileSync(ROSTER_PATH, JSON.stringify(value), "utf-8");
  forgetRoster();
}

function readStoredRoster(): ThinkerRoster {
  return JSON.parse(readFileSync(ROSTER_PATH, "utf-8")) as ThinkerRoster;
}

describe("defaultRoster", () => {
  it("has exactly MAX_THINKERS slots, indexed 1..MAX_THINKERS in order", () => {
    const roster = defaultRoster();
    expect(roster.slots).toHaveLength(MAX_THINKERS);
    expect(roster.slots.map((slot) => slot.index)).toEqual(
      Array.from({ length: MAX_THINKERS }, (_, i) => i + 1),
    );
  });

  it("starts every role on the model deep_think resolves today", () => {
    // `deepThinkModel()` is OPENAI_DEEPTHINK_MODEL || OPENAI_TEXT_MODEL ||
    // TEXT_MODEL, and the planner, the thinkers and the synthesiser all call it.
    // If this drifts, switching the roster on changes the bill of someone who
    // never opened the settings screen.
    const roster = defaultRoster();
    expect(roster.master).toMatchObject({ provider: "openai", model: TEXT_MODEL });
    expect(roster.planner).toMatchObject({ provider: "openai", model: TEXT_MODEL });
    for (const slot of roster.slots) {
      expect(slot.model.provider).toBe("openai");
      expect(slot.model.model).toBe(TEXT_MODEL);
    }
  });

  it("follows OPENAI_DEEPTHINK_MODEL ahead of OPENAI_TEXT_MODEL", () => {
    process.env.OPENAI_TEXT_MODEL = "gpt-5.2-nano";
    process.env.OPENAI_DEEPTHINK_MODEL = "gpt-5.2";
    try {
      expect(defaultRoster().master.model).toBe("gpt-5.2");
      delete process.env.OPENAI_DEEPTHINK_MODEL;
      expect(defaultRoster().master.model).toBe("gpt-5.2-nano");
    } finally {
      delete process.env.OPENAI_DEEPTHINK_MODEL;
      delete process.env.OPENAI_TEXT_MODEL;
    }
  });

  it("enables as many slots as DEEP_THINK_THINKERS asks for, clamped", () => {
    const enabledCount = (): number =>
      defaultRoster().slots.filter((slot) => slot.enabled).length;

    expect(enabledCount()).toBe(4); // .env.example's default

    process.env.DEEP_THINK_THINKERS = "7";
    try {
      expect(enabledCount()).toBe(7);
      process.env.DEEP_THINK_THINKERS = "99";
      expect(enabledCount()).toBe(MAX_THINKERS);
      // Not a positive number, so deep-think's own reader falls back to 4.
      process.env.DEEP_THINK_THINKERS = "0";
      expect(enabledCount()).toBe(4);
      process.env.DEEP_THINK_THINKERS = "muitos";
      expect(enabledCount()).toBe(4);
    } finally {
      delete process.env.DEEP_THINK_THINKERS;
    }
  });

  it("gives a disabled slot its model anyway", () => {
    const roster = defaultRoster();
    const last = roster.slots[MAX_THINKERS - 1]!;
    expect(last.enabled).toBe(false);
    expect(last.model.model).toBe(TEXT_MODEL);
  });

  it("has discovered nothing yet: no effort, null window, null rate", () => {
    const roster = defaultRoster();
    for (const choiceUnderTest of [
      roster.master,
      roster.planner,
      ...roster.slots.map((slot) => slot.model),
    ]) {
      // Absent, not "minimal": `ChatRequest.effort` says undefined means "send
      // nothing", and a non-reasoning model rejects the field outright.
      expect(choiceUnderTest.effort).toBeUndefined();
      expect(choiceUnderTest.context_window).toBeNull();
      expect(choiceUnderTest.rate).toBeNull();
    }
  });
});

describe("normalizeRoster", () => {
  it("returns the default for anything that is not an object", () => {
    for (const value of [null, undefined, "nope", 42, []]) {
      expect(normalizeRoster(value).slots).toHaveLength(MAX_THINKERS);
      expect(normalizeRoster(value).master.model).toBe(TEXT_MODEL);
    }
  });

  it("pads a roster that stored fewer slots back to MAX_THINKERS", () => {
    const roster = normalizeRoster({
      version: 1,
      master: choice("gpt-5.2"),
      planner: choice("gpt-5.2-mini"),
      slots: [
        { index: 1, enabled: true, model: choice("a") },
        { index: 2, enabled: true, model: choice("b") },
        { index: 3, enabled: true, model: choice("c") },
      ],
      updated_at: "2026-08-01T00:00:00.000Z",
    });

    expect(roster.slots).toHaveLength(MAX_THINKERS);
    expect(roster.slots.map((slot) => slot.index)).toEqual(
      Array.from({ length: MAX_THINKERS }, (_, i) => i + 1),
    );
    expect(roster.slots.slice(0, 3).map((slot) => slot.model.model)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("repairs a duplicated, out-of-range or non-numeric index without losing the model", () => {
    const roster = normalizeRoster({
      version: 1,
      master: choice("gpt-5.2"),
      planner: choice("gpt-5.2"),
      slots: [
        { index: 2, enabled: true, model: choice("claimed-two") },
        { index: 2, enabled: true, model: choice("duplicate") },
        { index: 99, enabled: true, model: choice("out-of-range") },
        { index: "abc", enabled: true, model: choice("not-a-number") },
        { enabled: true, model: choice("no-index") },
      ],
      updated_at: "2026-08-01T00:00:00.000Z",
    });

    expect(roster.slots.map((slot) => slot.index)).toEqual(
      Array.from({ length: MAX_THINKERS }, (_, i) => i + 1),
    );
    // The honoured claim stays where it asked to be; everything else keeps its
    // model and lands in the free rows, in the order it appeared.
    expect(roster.slots[1]!.model.model).toBe("claimed-two");
    expect(roster.slots.map((slot) => slot.model.model).slice(0, 5)).toEqual([
      "duplicate",
      "claimed-two",
      "out-of-range",
      "not-a-number",
      "no-index",
    ]);
  });

  it("accepts a numeric string index, because form inputs produce them", () => {
    const roster = normalizeRoster({
      version: 1,
      master: choice("gpt-5.2"),
      planner: choice("gpt-5.2"),
      slots: [{ index: "3", enabled: true, model: choice("row-three") }],
      updated_at: "2026-08-01T00:00:00.000Z",
    });
    expect(roster.slots[2]!.index).toBe(3);
    expect(roster.slots[2]!.model.model).toBe("row-three");
  });

  it("refuses a version it cannot read and falls back to the default", () => {
    for (const version of [2, 0, "1", undefined, null]) {
      const refused = normalizeRoster({
        version,
        master: {
          provider: "deepseek",
          model: "deepseek-v4-pro",
          context_window: 128_000,
          supports_tools: true,
          rate: null,
        },
        planner: choice("gpt-5.2"),
        slots: [{ index: 1, enabled: true, model: choice("survivor") }],
        updated_at: "2026-08-01T00:00:00.000Z",
      });

      // Nothing from a shape this build cannot read is salvaged — half a roster
      // nobody wrote is worse than the defaults.
      expect(refused.master.provider).toBe("openai");
      expect(refused.master.model).toBe(TEXT_MODEL);
      expect(refused.slots.map((slot) => slot.model.model)).not.toContain(
        "survivor",
      );
      expect(refused.slots).toHaveLength(MAX_THINKERS);
    }
  });

  it("keeps a disabled slot's model", () => {
    const roster = normalizeRoster({
      version: 1,
      master: choice("gpt-5.2"),
      planner: choice("gpt-5.2"),
      slots: [{ index: 1, enabled: false, model: choice("kept-while-off") }],
      updated_at: "2026-08-01T00:00:00.000Z",
    });
    expect(roster.slots[0]!.enabled).toBe(false);
    expect(roster.slots[0]!.model.model).toBe("kept-while-off");
  });

  it("drops an unknown effort and keeps a known one", () => {
    const build = (effort: unknown): ThinkerRoster =>
      normalizeRoster({
        version: 1,
        master: { ...choice("gpt-5.2"), effort },
        planner: choice("gpt-5.2"),
        slots: [],
        updated_at: "2026-08-01T00:00:00.000Z",
      });

    for (const bad of ["ultra", "LOW", "", 3, null, {}]) {
      expect(build(bad).master.effort).toBeUndefined();
      expect(build(bad).master).not.toHaveProperty("effort");
    }
    for (const good of ["minimal", "low", "medium", "high"]) {
      expect(build(good).master.effort).toBe(good);
    }
  });

  it("turns an unreadable rate into null, never into zero", () => {
    const rateOf = (rate: unknown): ModelChoice["rate"] =>
      normalizeRoster({
        version: 1,
        master: { ...choice("gpt-5.2"), rate },
        planner: choice("gpt-5.2"),
        slots: [],
        updated_at: "2026-08-01T00:00:00.000Z",
      }).master.rate;

    // Zero is indistinguishable from a real published zero once it is on disk,
    // and `services/pricing.ts` already has one way of silently charging zero.
    for (const bad of [
      { input: 1, cached_input: 0.1 },
      { input: null, cached_input: null, output: null },
      { input: "grátis", cached_input: 0, output: 0 },
      { input: -1, cached_input: 0, output: 0 },
      { input: true, cached_input: true, output: true },
      "1/1/1",
      [],
      null,
    ]) {
      expect(rateOf(bad)).toBeNull();
    }

    // A rate that really is complete survives — including a genuine zero.
    expect(rateOf({ input: 0.28, cached_input: 0.028, output: 0.42 })).toEqual({
      input: 0.28,
      cached_input: 0.028,
      output: 0.42,
    });
    expect(rateOf({ input: 0, cached_input: 0, output: 0 })).toEqual({
      input: 0,
      cached_input: 0,
      output: 0,
    });
  });

  it("turns an unreadable context window into null, never into zero", () => {
    const windowOf = (context_window: unknown): number | null =>
      normalizeRoster({
        version: 1,
        master: { ...choice("gpt-5.2"), context_window },
        planner: choice("gpt-5.2"),
        slots: [],
        updated_at: "2026-08-01T00:00:00.000Z",
      }).master.context_window;

    // `null` is the conservative FLOOR for the budgeter; `0` is a window no
    // model has, and the two must not be confusable.
    for (const bad of [0, -5, "", "muito grande", null, true, {}, NaN]) {
      expect(windowOf(bad)).toBeNull();
    }
    expect(windowOf(128_000)).toBe(128_000);
    expect(windowOf("200000")).toBe(200_000);
  });

  it("falls back per field instead of rejecting the whole roster", () => {
    const roster = normalizeRoster({
      version: 1,
      master: { provider: "gemini", model: "   ", supports_tools: "sim" },
      planner: choice("deepseek-v4-pro"),
      slots: [{ index: 1, enabled: "yes", model: choice("kept") }],
      updated_at: 12345,
    });

    expect(roster.master.provider).toBe("openai");
    expect(roster.master.model).toBe(TEXT_MODEL);
    expect(roster.master.supports_tools).toBe(true);
    // A bad `enabled` falls to what the default roster would have said for row 1.
    expect(roster.slots[0]!.enabled).toBe(true);
    expect(roster.slots[0]!.model.model).toBe("kept");
    expect(typeof roster.updated_at).toBe("string");
    expect(Number.isNaN(Date.parse(roster.updated_at))).toBe(false);
  });

  it("clips an oversized angle and drops an empty one", () => {
    const roster = normalizeRoster({
      version: 1,
      master: choice("gpt-5.2"),
      planner: choice("gpt-5.2"),
      slots: [
        { index: 1, enabled: true, model: choice("a"), angle: "x".repeat(5_000) },
        { index: 2, enabled: true, model: choice("b"), angle: "   " },
        { index: 3, enabled: true, model: choice("c"), angle: 7 },
      ],
      updated_at: "2026-08-01T00:00:00.000Z",
    });

    expect(roster.slots[0]!.angle!.length).toBe(200);
    expect(roster.slots[1]!).not.toHaveProperty("angle");
    expect(roster.slots[2]!).not.toHaveProperty("angle");
  });

  it("is idempotent", () => {
    const once = normalizeRoster({
      version: 1,
      master: choice("gpt-5.2"),
      planner: choice("gpt-5.2-mini"),
      slots: [{ index: 4, enabled: false, model: choice("d"), angle: "custo" }],
      updated_at: "2026-08-01T00:00:00.000Z",
    });
    expect(normalizeRoster(once)).toEqual(once);
  });
});

describe("getRoster / setRoster", () => {
  it("returns the default and writes nothing when there is no file yet", async () => {
    expect(existsSync(ROSTER_PATH)).toBe(false);

    const roster = await getRoster();
    expect(roster.version).toBe(1);
    expect(roster.slots).toHaveLength(MAX_THINKERS);
    expect(roster.master.model).toBe(TEXT_MODEL);

    // Reading must not create the file: the defaults follow the environment, and
    // writing them here would freeze today's .env into a file that stops
    // tracking it.
    expect(existsSync(ROSTER_PATH)).toBe(false);
  });

  it("persists a patch, stamps updated_at and reads back the same thing", async () => {
    const before = new Date().toISOString();
    const saved = await setRoster({
      master: {
        provider: "deepseek",
        model: "deepseek-v4-pro",
        context_window: 128_000,
        supports_tools: true,
        rate: { input: 0.28, cached_input: 0.028, output: 0.42 },
      },
    });

    expect(saved.master.model).toBe("deepseek-v4-pro");
    expect(saved.master.provider).toBe("deepseek");
    expect(saved.updated_at >= before).toBe(true);
    expect(existsSync(ROSTER_PATH)).toBe(true);

    forgetRoster();
    const reloaded = await getRoster();
    expect(reloaded.master).toEqual(saved.master);
  });

  it("merges shallowly: a patch leaves what it does not mention alone", async () => {
    const before = await getRoster();
    const saved = await setRoster({ planner: choice("gpt-5.2-mini") });

    expect(saved.planner.model).toBe("gpt-5.2-mini");
    expect(saved.master).toEqual(before.master);
    expect(saved.slots).toHaveLength(MAX_THINKERS);
  });

  it("ignores a version the patch carries as undefined", async () => {
    await setRoster({ master: choice("deepseek-v4-pro") });

    // `{ version: undefined }` is NOT the absence of the key: an object spread
    // copies a key whose value is undefined. Read that as a version, refuse it,
    // and the write persists the whole default roster over models the operator
    // paid to choose — with a console.warn as the only trace.
    const saved = await setRoster({
      version: undefined,
      planner: choice("planner-do-operador"),
    });

    expect(saved.version).toBe(1);
    expect(saved.master.model).toBe("deepseek-v4-pro");
    expect(saved.planner.model).toBe("planner-do-operador");
    expect(readStoredRoster().master.model).toBe("deepseek-v4-pro");
  });

  it("ignores a null version arriving from a JSON body", async () => {
    await setRoster({ master: choice("deepseek-v4-pro") });

    // The shape an HTTP body really produces: `JSON.parse` on a payload that
    // echoed the version back as null. Nothing here is exotic enough to be the
    // operator's fault.
    const body: unknown = JSON.parse(
      '{"version":null,"planner":{"provider":"openai","model":"planner-do-json","context_window":null,"supports_tools":true,"rate":null}}',
    );
    const saved = await setRoster(body);

    expect(saved.version).toBe(1);
    expect(saved.master.model).toBe("deepseek-v4-pro");
    expect(saved.planner.model).toBe("planner-do-json");
    expect(readStoredRoster().master.model).toBe("deepseek-v4-pro");
  });

  it("leaves the slots alone when a patch's slots is not a list", async () => {
    const slots = defaultRoster().slots.map((slot) =>
      slot.index === 7
        ? { ...slot, enabled: false, model: choice("mine-7") }
        : slot,
    );
    await setRoster({ slots });

    // Unreadable is not empty. A write that treated `null` as "the operator sent
    // an empty list" would hand back the ten default rows and persist them.
    for (const junk of [null, {}, "slots", 7, true]) {
      const saved = await setRoster({ slots: junk });
      expect(saved.slots[6]!.model.model).toBe("mine-7");
      expect(saved.slots[6]!.enabled).toBe(false);
    }

    expect(readStoredRoster().slots[6]!.model.model).toBe("mine-7");
  });

  it("still resets the slots for a list that really is empty", async () => {
    await setRoster({
      slots: defaultRoster().slots.map((slot) =>
        slot.index === 7 ? { ...slot, model: choice("mine-7") } : slot,
      ),
    });

    // An empty list IS a list, and normalising it is defined: every row falls
    // back to what `defaultRoster()` would have made. That is the half of the
    // behaviour the guard above must not take away.
    const saved = await setRoster({ slots: [] });
    expect(saved.slots).toHaveLength(MAX_THINKERS);
    expect(saved.slots.map((slot) => slot.model.model)).toEqual(
      Array.from({ length: MAX_THINKERS }, () => TEXT_MODEL),
    );
  });

  it("serves later reads from the cache without losing the write", async () => {
    await setRoster({ planner: choice("cache-check") });
    expect((await getRoster()).planner.model).toBe("cache-check");
  });

  it("hands out a copy, so a caller cannot edit the roster in force", async () => {
    const mine = await getRoster();
    mine.master.model = "mutated-by-a-caller";
    expect((await getRoster()).master.model).not.toBe("mutated-by-a-caller");
  });

  it("does not cache a read that a write overtook", async () => {
    // A read that STARTED before a write and FINISHED after it is holding the
    // previous bytes. Caching those would leave the process running on the old
    // models until it restarts, with a correct file on disk and nothing to see.
    //
    // Making the read actually lose the race takes two arrangements. The stale
    // bytes have to stay reachable after the file has moved on — a rename leaves
    // an already-open fd on the old inode, and a big file keeps that fd busy for
    // a while. And the write must not be stuck reading those same bytes, which
    // is why a small file is swapped in before `setRoster` is called.
    const stale = {
      version: 1,
      master: choice("bytes-antigos"),
      planner: choice("bytes-antigos"),
      slots: [{ index: 1, enabled: true, model: choice("bytes-antigos") }],
      updated_at: "2026-08-01T00:00:00.000Z",
    };
    // `padding` is ignored by the normaliser; it is here only to make the read
    // long enough to be overtaken.
    writeStoredRoster({ ...stale, padding: "x".repeat(48 * 1024 * 1024) });

    const finished: string[] = [];
    const read = getRoster().then((roster) => {
      finished.push("read");
      return roster;
    });

    // Long enough for the open() behind that read to have happened: everything
    // below assumes it is already holding an fd on the stale inode.
    await new Promise<void>((resolve) => setTimeout(resolve, 25));

    const swap = `${ROSTER_PATH}.swap`;
    writeFileSync(swap, JSON.stringify(stale), "utf-8");
    renameSync(swap, ROSTER_PATH);

    const write = setRoster({ planner: choice("won-the-race") }).then(
      (roster) => {
        finished.push("write");
        return roster;
      },
    );

    const [overtaken] = await Promise.all([read, write]);

    // The premises, asserted rather than assumed: the read did get the stale
    // bytes, and it did finish after the write.
    expect(overtaken.planner.model).toBe("bytes-antigos");
    expect(finished).toEqual(["write", "read"]);

    // And it did not install them. Without the generation guard the late read
    // overwrites the cache the write just filled, and the process serves the
    // old models from memory for the rest of its life.
    expect((await getRoster()).planner.model).toBe("won-the-race");
  });

  it("keeps a disabled slot's model across save then load", async () => {
    const slots = defaultRoster().slots.map((slot) =>
      slot.index === 9
        ? { ...slot, enabled: false, model: choice("modelo-guardado") }
        : slot,
    );
    await setRoster({ slots });

    forgetRoster();
    const reloaded = await getRoster();
    expect(reloaded.slots[8]!.enabled).toBe(false);
    expect(reloaded.slots[8]!.model.model).toBe("modelo-guardado");
  });

  it("never lets an invalid effort reach the disk", async () => {
    await setRoster({ master: { ...choice("gpt-5.2"), effort: "ultra" } });
    expect(readFileSync(ROSTER_PATH, "utf-8")).not.toContain("effort");
    expect(readStoredRoster().master).not.toHaveProperty("effort");

    await setRoster({ master: { ...choice("gpt-5.2"), effort: "high" } });
    expect(readStoredRoster().master.effort).toBe("high");
  });

  it("stores an unreadable rate and window as null rather than zero", async () => {
    await setRoster({
      master: {
        ...choice("gpt-5.2"),
        rate: { input: 1, cached_input: 0.1 },
        context_window: 0,
      },
    });

    const stored = readStoredRoster();
    expect(stored.master.rate).toBeNull();
    expect(stored.master.context_window).toBeNull();
  });

  it("falls back to the default when the stored version is unknown", async () => {
    writeStoredRoster({
      version: 2,
      master: choice("deepseek-v4-pro"),
      planner: choice("deepseek-v4-pro"),
      slots: [{ index: 1, enabled: true, model: choice("survivor") }],
      updated_at: "2026-08-01T00:00:00.000Z",
    });

    const roster = await getRoster();
    expect(roster.master.model).toBe(TEXT_MODEL);
    expect(roster.slots).toHaveLength(MAX_THINKERS);
  });

  it("falls back to the default when the file is not JSON, instead of throwing", async () => {
    mkdirSync(dirname(ROSTER_PATH), { recursive: true });
    writeFileSync(ROSTER_PATH, "{ isto nao e json", "utf-8");
    forgetRoster();

    const roster = await getRoster();
    expect(roster.version).toBe(1);
    expect(roster.master.model).toBe(TEXT_MODEL);
  });

  it("normalises a stored roster of three slots back to MAX_THINKERS", async () => {
    writeStoredRoster({
      version: 1,
      master: choice("gpt-5.2"),
      planner: choice("gpt-5.2-mini"),
      slots: [
        { index: 1, enabled: true, model: choice("a") },
        { index: 2, enabled: true, model: choice("b") },
        { index: 3, enabled: true, model: choice("c") },
      ],
      updated_at: "2026-08-01T00:00:00.000Z",
    });

    const roster = await getRoster();
    expect(roster.slots).toHaveLength(MAX_THINKERS);
    expect(roster.slots.map((slot) => slot.index)).toEqual(
      Array.from({ length: MAX_THINKERS }, (_, i) => i + 1),
    );
  });

  it("serialises concurrent writes", async () => {
    const slots = defaultRoster().slots.map((slot) =>
      slot.index === 5 ? { ...slot, model: choice("slot-five") } : slot,
    );

    // Three writers, three distinct top-level fields. Under the lock each one
    // merges over the previous result, so all three survive; without it the last
    // to finish would erase the other two.
    await Promise.all([
      setRoster({ master: choice("concurrent-master") }),
      setRoster({ planner: choice("concurrent-planner") }),
      setRoster({ slots }),
    ]);

    const stored = readStoredRoster();
    expect(stored.master.model).toBe("concurrent-master");
    expect(stored.planner.model).toBe("concurrent-planner");
    expect(stored.slots).toHaveLength(MAX_THINKERS);
    expect(stored.slots[4]!.model.model).toBe("slot-five");

    const leftovers = readdirSync(dirname(ROSTER_PATH)).filter((name) =>
      name.startsWith("thinker-roster.json.tmp"),
    );
    expect(leftovers).toEqual([]);
  });

  it("never lets a reader see half a file", async () => {
    await setRoster({ master: choice("antes-da-escrita") });

    // A reader on every turn of the event loop, for the whole of one write.
    //
    // The window a non-atomic write opens is not subtle: `writeFile(target, …)`
    // opens with O_TRUNC and only then starts writing, and those are two awaited
    // steps, so between them there is a real file of zero bytes for anyone who
    // looks. tmp+rename never exposes it — the target moves from one complete
    // file straight to the next. Serialisation does not cover this: the lock
    // orders WRITERS, and the reader below never takes it.
    const seen: string[] = [];
    let writing = true;
    const poll = (): void => {
      if (!writing) return;
      try {
        seen.push(readFileSync(ROSTER_PATH, "utf-8"));
      } catch {
        seen.push("<unreadable>");
      }
      setImmediate(poll);
    };
    setImmediate(poll);

    await setRoster({ master: choice("depois-da-escrita") });
    writing = false;

    // Not a single reader saw anything but one of the two whole rosters.
    const partial = seen.filter((bytes) => {
      try {
        const parsed = JSON.parse(bytes) as ThinkerRoster;
        return (
          parsed.slots.length !== MAX_THINKERS ||
          !["antes-da-escrita", "depois-da-escrita"].includes(parsed.master.model)
        );
      } catch {
        return true;
      }
    });
    expect(partial).toEqual([]);
    // The poller has to have run inside the write for the line above to mean
    // anything.
    expect(seen.length).toBeGreaterThan(1);
  });
});
