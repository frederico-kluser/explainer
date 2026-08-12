// === The geometry of the document sidebar ===
//
// Pure functions, separated from the component for the reason the rest of this
// folder separates them: the frontend suite has no browser, so the arithmetic
// that decides how wide the pane gets is only testable if it does not need one.
// The component does the pointer capture and the DOM; everything here is
// numbers in, numbers out.

/** Below this the markdown editor is narrower than the text it holds. */
export const MIN_WIDTH = 300;

/** What it opens at the first time, before anybody has dragged it. */
export const DEFAULT_WIDTH = 440;

/**
 * The pane may not take more than this share of the window.
 *
 * The conversation is the reason the app exists; a sidebar that can swallow it
 * whole is a way to lose the transcript with one clumsy drag and no undo.
 */
export const MAX_FRACTION = 0.6;

export const WIDTH_KEY = "explainer.document_width";

/** Never below `MIN_WIDTH`, even on a window too narrow for the fraction. */
export function maxWidth(viewport: number): number {
  const fraction = Number.isFinite(viewport) ? viewport * MAX_FRACTION : 0;
  return Math.max(MIN_WIDTH, Math.round(fraction));
}

export function clampWidth(width: number, viewport: number): number {
  if (!Number.isFinite(width)) return DEFAULT_WIDTH;
  return Math.min(maxWidth(viewport), Math.max(MIN_WIDTH, Math.round(width)));
}

/**
 * The width a pointer at `clientX` is asking for.
 *
 * The handle sits on the pane's left edge and the pane is flush with the right
 * of the window, so the width is everything to the right of the pointer.
 */
export function widthFromPointer(clientX: number, viewport: number): number {
  return clampWidth(viewport - clientX, viewport);
}

/** How much one arrow key moves the edge. */
export const KEYBOARD_STEP = 24;

/**
 * The width a key press asks for, or null when the key is not one of ours.
 *
 * Left widens and right narrows, because the handle is on the left edge: the
 * edge follows the key, not the pane.
 */
export function widthFromKey(
  key: string,
  width: number,
  viewport: number,
): number | null {
  switch (key) {
    case "ArrowLeft":
      return clampWidth(width + KEYBOARD_STEP, viewport);
    case "ArrowRight":
      return clampWidth(width - KEYBOARD_STEP, viewport);
    case "Home":
      return maxWidth(viewport);
    case "End":
      return MIN_WIDTH;
    default:
      return null;
  }
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Safari in private mode throws on access rather than answering null.
    return null;
  }
}

/** The width this browser last chose, clamped to the window it is in now. */
export function readStoredWidth(viewport: number): number {
  const raw = storage()?.getItem(WIDTH_KEY);
  if (raw === null || raw === undefined) return clampWidth(DEFAULT_WIDTH, viewport);
  const parsed = Number(raw);
  return Number.isFinite(parsed)
    ? clampWidth(parsed, viewport)
    : clampWidth(DEFAULT_WIDTH, viewport);
}

export function writeStoredWidth(width: number): void {
  try {
    storage()?.setItem(WIDTH_KEY, String(Math.round(width)));
  } catch {
    /* an unwritable store is not a reason to fail a drag */
  }
}
