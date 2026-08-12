import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_WIDTH,
  KEYBOARD_STEP,
  MAX_FRACTION,
  MIN_WIDTH,
  WIDTH_KEY,
  clampWidth,
  maxWidth,
  readStoredWidth,
  widthFromKey,
  widthFromPointer,
  writeStoredWidth,
} from "@/components/ui/document-sidebar";

// The pane's arithmetic, without a browser. The component owns the pointer
// capture and the DOM; everything asserted here is numbers in, numbers out —
// which is the only reason it is testable in a suite with no window.

const WIDE = 1440;

describe("clampWidth", () => {
  it("keeps the transcript from being squeezed out", () => {
    // The conversation is the reason the app exists. A drag that could take the
    // whole window is a way to lose it with no undo.
    expect(clampWidth(9999, WIDE)).toBe(Math.round(WIDE * MAX_FRACTION));
    expect(clampWidth(10, WIDE)).toBe(MIN_WIDTH);
    expect(clampWidth(600, WIDE)).toBe(600);
  });

  it("never returns less than the minimum, even on a narrow window", () => {
    // 60% of 400px is below the width at which the editor is narrower than the
    // text in it, and a cap under the floor would invert the two.
    expect(maxWidth(400)).toBe(MIN_WIDTH);
    expect(clampWidth(320, 400)).toBe(MIN_WIDTH);
  });

  it("answers the default for a width that is not a number", () => {
    expect(clampWidth(Number.NaN, WIDE)).toBe(DEFAULT_WIDTH);
  });
});

describe("widthFromPointer", () => {
  it("measures from the pointer to the right edge", () => {
    // The handle is the pane's left edge and the pane is flush with the window,
    // so the width is everything to the right of the cursor.
    expect(widthFromPointer(WIDE - 500, WIDE)).toBe(500);
  });

  it("clamps instead of following the cursor off the window", () => {
    expect(widthFromPointer(-200, WIDE)).toBe(Math.round(WIDE * MAX_FRACTION));
    expect(widthFromPointer(WIDE + 200, WIDE)).toBe(MIN_WIDTH);
  });
});

describe("widthFromKey", () => {
  it("moves the edge, not the pane", () => {
    // The handle is on the left, so left widens. A separator whose arrow keys
    // ran the other way would be the one control on the page that does.
    expect(widthFromKey("ArrowLeft", 500, WIDE)).toBe(500 + KEYBOARD_STEP);
    expect(widthFromKey("ArrowRight", 500, WIDE)).toBe(500 - KEYBOARD_STEP);
  });

  it("jumps to the ends", () => {
    expect(widthFromKey("Home", 500, WIDE)).toBe(maxWidth(WIDE));
    expect(widthFromKey("End", 500, WIDE)).toBe(MIN_WIDTH);
  });

  it("leaves every other key to the browser", () => {
    for (const key of ["ArrowUp", "Enter", "a", " ", "Tab"]) {
      expect(widthFromKey(key, 500, WIDE), key).toBeNull();
    }
  });

  it("clamps at the ends rather than walking past them", () => {
    expect(widthFromKey("ArrowRight", MIN_WIDTH, WIDE)).toBe(MIN_WIDTH);
    expect(widthFromKey("ArrowLeft", maxWidth(WIDE), WIDE)).toBe(maxWidth(WIDE));
  });
});

describe("the remembered width", () => {
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };
  });

  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it("round-trips through storage", () => {
    writeStoredWidth(612);
    expect(store.get(WIDTH_KEY)).toBe("612");
    expect(readStoredWidth(WIDE)).toBe(612);
  });

  it("re-clamps against the window it is opened in", () => {
    // A width chosen on a monitor and reopened on a laptop would otherwise leave
    // the pane wider than the cap it was supposed to obey.
    writeStoredWidth(800);
    expect(readStoredWidth(1000)).toBe(600);
  });

  it("falls back to the default for nothing stored, or for junk", () => {
    expect(readStoredWidth(WIDE)).toBe(DEFAULT_WIDTH);
    store.set(WIDTH_KEY, "muito largo");
    expect(readStoredWidth(WIDE)).toBe(DEFAULT_WIDTH);
  });

  it("survives a storage that throws on access", () => {
    // Safari in private mode throws rather than answering null, and a drag is
    // not worth a crash.
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError");
      },
    });

    expect(readStoredWidth(WIDE)).toBe(DEFAULT_WIDTH);
    expect(() => writeStoredWidth(500)).not.toThrow();
  });
});
