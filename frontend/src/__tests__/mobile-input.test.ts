import { describe, expect, it } from "vitest";

import {
  DIRECTORY_TARGETS,
} from "@/components/ui/DirectoryBrowser";
import {
  MATERIAL_TAB_KINDS,
  PICKER_TARGETS,
  DEFAULT_MATERIAL_KIND,
  initialPickerKind,
} from "@/components/ui/MaterialPicker";
import {
  MIC_BUTTON_LABELS,
  MIC_BUTTON_TARGET,
  MIC_CAPTION_CLASS,
} from "@/components/ui/MicButton";
import type { MicButtonState } from "@/components/ui/MicButton";
import type { SourceKind } from "@/types";

// There is no jsdom in this suite, so none of these controls can be rendered
// and measured. What can be measured is the class list each one is built from,
// which is why the three components hand their tap targets out as data.
//
// The bug this file is the guard against shipped once already: `usar` in the
// directory listing was `text-[10px] px-1.5 py-0.5`, about 20px tall, sitting
// 8px from a navigate button that covered the rest of the row. On a phone that
// is not a small target, it is a coin flip between "open this folder" and
// "this is the folder", and one of those two answers ends the browse.

// ---------------------------------------------------------------------------
// Reading a Tailwind class list as a box
// ---------------------------------------------------------------------------

/** Tailwind v4's `--spacing`, and the root font size the app renders at. */
const SPACING_REM = 0.25;
const ROOT_PX = 16;

/**
 * What a finger needs. Apple and Google both land here (44pt / 48dp), and it is
 * the number the shell of this wave was built to.
 */
const TAP_FLOOR_PX = 44;

/** Under this, iOS Safari zooms the page in on focus — and never back out. */
const NO_ZOOM_FONT_PX = 16;

/**
 * Only the utilities with no variant prefix.
 *
 * A `md:` token describes the desktop box, and a `hover:` token describes a
 * colour. The phone is what is left, and the phone is what is being measured.
 */
function baseTokens(classes: string): string[] {
  return classes.split(/\s+/).filter((token) => token && !token.includes(":"));
}

/** The px a numeric Tailwind size utility resolves to, or null if it is not one. */
function scalePx(value: string): number | null {
  const arbitrary = /^\[(\d+(?:\.\d+)?)px\]$/.exec(value);
  if (arbitrary) return Number(arbitrary[1]);
  // `h-full`, `h-auto`, `h-px`, `size-fit` — real utilities, but not a number
  // this test can compare against 44.
  if (!/^\d+(?:\.\d+)?$/.test(value)) return null;
  return Number(value) * SPACING_REM * ROOT_PX;
}

/** The tallest height the unprefixed half of a class list pins down. */
function heightPx(classes: string): number | null {
  let tallest: number | null = null;
  for (const token of baseTokens(classes)) {
    const match = /^(?:min-h|h|size)-(.+)$/.exec(token);
    if (!match) continue;
    const px = scalePx(match[1]!);
    if (px === null) continue;
    tallest = tallest === null ? px : Math.max(tallest, px);
  }
  return tallest;
}

/** The widest width the unprefixed half of a class list pins down. */
function widthPx(classes: string): number | null {
  let widest: number | null = null;
  for (const token of baseTokens(classes)) {
    const match = /^(?:min-w|w|size)-(.+)$/.exec(token);
    if (!match) continue;
    const px = scalePx(match[1]!);
    if (px === null) continue;
    widest = widest === null ? px : Math.max(widest, px);
  }
  return widest;
}

const FONT_PX: Record<string, number> = {
  "text-xs": 12,
  "text-sm": 14,
  "text-base": 16,
  "text-lg": 18,
};

/** The font size the unprefixed half of a class list asks for. */
function fontPx(classes: string): number | null {
  for (const token of baseTokens(classes)) {
    const named = FONT_PX[token];
    if (named !== undefined) return named;
    const arbitrary = /^text-\[(\d+(?:\.\d+)?)px\]$/.exec(token);
    if (arbitrary) return Number(arbitrary[1]);
  }
  return null;
}

describe("the class-list reader itself", () => {
  it("measures the utilities these components use", () => {
    expect(heightPx("min-h-11")).toBe(44);
    expect(heightPx("size-16")).toBe(64);
    expect(widthPx("min-w-11")).toBe(44);
    expect(fontPx("text-base")).toBe(16);
  });

  it("ignores the desktop half and the state variants", () => {
    // `md:h-6` is the 24px desktop box, not a phone target, and `hover:h-11`
    // would be a size nobody can reach without a mouse.
    expect(heightPx("min-h-11 md:h-6")).toBe(44);
    expect(fontPx("text-base md:text-sm")).toBe(16);
  });

  it("reports nothing when no height is pinned down at all", () => {
    // This is the shape of the bug: padding and a font size, no box. A target
    // built this way is as tall as whatever happens to be inside it.
    expect(heightPx("px-1.5 py-0.5 text-[10px]")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Walking somebody else's machine, with a thumb
// ---------------------------------------------------------------------------

describe("the directory browser's targets", () => {
  it("gives every one of them a fingertip on a phone", () => {
    for (const [name, classes] of Object.entries(DIRECTORY_TARGETS)) {
      expect(heightPx(classes), `${name} pins no height`).not.toBeNull();
      expect(heightPx(classes), `${name} is too short`).toBeGreaterThanOrEqual(
        TAP_FLOOR_PX,
      );
    }
  });

  it("makes `usar` as wide as it is tall", () => {
    // Four characters of text would otherwise leave a target about 50px wide
    // and 44 tall on a row whose other 80% opens a different folder. The width
    // is the half that stops a thumb landing on the navigate button.
    expect(widthPx(DIRECTORY_TARGETS.pick)).toBeGreaterThanOrEqual(TAP_FLOOR_PX);
  });

  it("keeps the two answers apart", () => {
    // Navigating fills the row and `usar` refuses to be squeezed by it, so the
    // pick target keeps its full box no matter how long the folder name is —
    // the failure mode being a 12px sliver at the end of a long path.
    expect(DIRECTORY_TARGETS.navigate).toContain("flex-1");
    expect(DIRECTORY_TARGETS.pick).toContain("shrink-0");
  });

  it("leaves the desktop rows the size they were", () => {
    // The phone needed 44px; a desktop list of folders did not, and growing its
    // rows by 60% would push half the listing out of the scroll box.
    expect(DIRECTORY_TARGETS.navigate).toContain("md:min-h-0");
    expect(DIRECTORY_TARGETS.breadcrumb).toContain("md:min-h-0");
    expect(DIRECTORY_TARGETS.pick).toContain("md:h-6");
  });
});

// ---------------------------------------------------------------------------
// The front door of the app on a phone
// ---------------------------------------------------------------------------

describe("the material picker's targets", () => {
  it("gives every one of them a fingertip on a phone", () => {
    for (const [name, classes] of Object.entries(PICKER_TARGETS)) {
      // The textarea is sized by `rows`, so it is the one control here with no
      // height utility to read; it is checked for its font size instead.
      if (name === "markdownInput") continue;
      expect(heightPx(classes), `${name} pins no height`).not.toBeNull();
      expect(heightPx(classes), `${name} is too short`).toBeGreaterThanOrEqual(
        TAP_FLOOR_PX,
      );
    }
  });

  it("never puts sub-16px text in a field", () => {
    // A 14px field is the whole iOS Safari zoom trap: focus the input, the page
    // scales up, and nothing scales it back. The user is then reading a call
    // transcript through a magnifying glass.
    for (const field of [PICKER_TARGETS.repoInput, PICKER_TARGETS.markdownInput]) {
      expect(fontPx(field)).toBeGreaterThanOrEqual(NO_ZOOM_FONT_PX);
      expect(field).toContain("md:text-sm");
    }
  });

  it("keeps the desktop picker the size it was", () => {
    expect(PICKER_TARGETS.tab).toContain("md:min-h-0");
    expect(PICKER_TARGETS.chipRemove).toContain("md:size-auto");
    expect(PICKER_TARGETS.submit).toContain("md:h-8");
  });
});

// ---------------------------------------------------------------------------
// Which tab the picker opens on
// ---------------------------------------------------------------------------

describe("initialPickerKind", () => {
  it("keeps the repository tab when nobody says otherwise", () => {
    // Adding the prop must not move the default: the desktop picker has always
    // opened on "Repositório" and no caller there passes anything.
    expect(initialPickerKind(undefined)).toBe("repo");
    expect(initialPickerKind()).toBe(DEFAULT_MATERIAL_KIND);
  });

  it("opens where the caller already asked", () => {
    // The first-contact overlay asked the same question in bigger words. A user
    // who tapped "Um documento" up there and lands on "Repositório" down here
    // has been asked twice and answered once.
    for (const kind of MATERIAL_TAB_KINDS) {
      expect(initialPickerKind(kind)).toBe(kind);
    }
  });

  it("has a tab for every kind a caller can name", () => {
    // `initialKind` is typed as `SourceKind`, so a kind without a tab would be
    // a value the picker accepts and then silently cannot show.
    const everyKind: SourceKind[] = ["repo", "markdown", "machine"];
    expect([...MATERIAL_TAB_KINDS].sort()).toEqual([...everyKind].sort());
    expect(MATERIAL_TAB_KINDS).toContain(DEFAULT_MATERIAL_KIND);
  });
});

// ---------------------------------------------------------------------------
// The one control of a call
// ---------------------------------------------------------------------------

describe("the microphone button", () => {
  it("is already past the floor and stays there", () => {
    expect(heightPx(MIC_BUTTON_TARGET)).toBeGreaterThanOrEqual(TAP_FLOOR_PX);
    expect(widthPx(MIC_BUTTON_TARGET)).toBeGreaterThanOrEqual(TAP_FLOOR_PX);
  });

  it("drops the caption below md and keeps it above", () => {
    // Stacked under the 64px circle the caption makes the bottom bar ~92px
    // tall. Hidden, not deleted: at md and up it is the only place the session
    // state is written down.
    expect(MIC_CAPTION_CLASS).toContain("hidden");
    expect(MIC_CAPTION_CLASS).toContain("md:block");
  });

  it("names every state it can be in", () => {
    // With the caption gone on a phone, this map is the button's accessible
    // name and its tooltip. A missing entry is an unlabelled circle.
    const states: MicButtonState[] = [
      "idle",
      "connecting",
      "listening",
      "hearing",
      "speaking",
    ];
    for (const state of states) {
      expect(MIC_BUTTON_LABELS[state].trim().length).toBeGreaterThan(0);
    }
    expect(Object.keys(MIC_BUTTON_LABELS).sort()).toEqual([...states].sort());
  });
});
