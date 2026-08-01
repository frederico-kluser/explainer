import { describe, it, expect } from "vitest";
import { VOICES, defaultSettings, normalizeSettings } from "../services/settings.js";

describe("normalizeSettings", () => {
  it("keeps a valid voice and speed", () => {
    expect(normalizeSettings({ voice: "cedar", speed: 1.2 })).toEqual({
      voice: "cedar",
      speed: 1.2,
    });
  });

  it("falls back to the default voice for anything unknown", () => {
    // The value comes off disk or off the wire; an invented voice would make the
    // whole session mint fail with a 400 instead of just sounding different.
    expect(normalizeSettings({ voice: "morgan-freeman" }).voice).toBe(
      defaultSettings().voice,
    );
    expect(normalizeSettings(null).voice).toBe(defaultSettings().voice);
    expect(normalizeSettings("nope").voice).toBe(defaultSettings().voice);
  });

  it("clamps speed into the range the API accepts", () => {
    expect(normalizeSettings({ speed: 9 }).speed).toBe(1.5);
    expect(normalizeSettings({ speed: 0 }).speed).toBe(0.25);
    expect(normalizeSettings({ speed: "fast" }).speed).toBe(1);
  });

  it("accepts a numeric string, because form inputs produce them", () => {
    expect(normalizeSettings({ speed: "1.25" }).speed).toBe(1.25);
  });
});

describe("VOICES", () => {
  it("leads with the two OpenAI recommends", () => {
    expect(VOICES[0]).toBe("marin");
    expect(VOICES[1]).toBe("cedar");
  });
});
