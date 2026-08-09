/**
 * What the content inside the compact shell decides, kept out of the JSX.
 *
 * Sibling of `mobile-shell.ts`, and here for the same reason: this suite has no
 * jsdom, so a rule that exists only as markup cannot be proven. What is provable
 * is the deciding — the natural size a rendered diagram claims, how far the
 * enlarged view may be dragged and zoomed, and the width contracts two
 * components used to have imposed on them from outside.
 */

// ---------------------------------------------------------------------------
// Targets a thumb can hit
// ---------------------------------------------------------------------------

/**
 * 44px, the smallest box a thumb hits reliably — the same figure the top bar
 * uses.
 *
 * A string rather than a component because the controls it dresses are
 * different elements — a cancel `X`, a zoom step — and the only thing they
 * share is the box they present to a finger.
 */
export const TAP_TARGET =
  "inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";

/**
 * The same target on a phone, back to a rail-sized icon at `md`.
 *
 * For the controls that exist at both widths. The `md:` half matters as much as
 * the 44 does: the agent cards also live in the 288px rail, where a column of
 * 44px cancel buttons pushes the cost readout off its row.
 */
export const TAP_TARGET_RAIL = `${TAP_TARGET} md:size-6`;

/** The same 44px floor for a control whose width comes from its own text, back
 *  to a plain line of text at `md`. */
export const TAP_ROW = "min-h-11 md:min-h-0";

// ---------------------------------------------------------------------------
// How wide a turn may be
// ---------------------------------------------------------------------------

/**
 * How much of the column one side of the conversation may take.
 *
 * One decision made in two components — `ChatBubble` and `ToolTrace` — and until
 * now made in neither of them: `App.tsx` reached into the transcript with
 * `[&_[data-role]>div]:max-w-[92%] md:…[80%]`. That selector missed `ToolTrace`,
 * which carries no `data-role` and so kept the 80% cap on a phone, and caught
 * `MermaidDiagram`, which carries `data-role="diagram"`, quietly capping every
 * drawing at 92% of the column as well.
 *
 * 80% of 360px throws away 72px of a screen that has none to spare. 8% is the
 * gutter that still reads as "the other side said this" against the far edge.
 */
export const BUBBLE_MAX_WIDTH = "max-w-[92%] md:max-w-[80%]";

// ---------------------------------------------------------------------------
// The diagram, at the size it was drawn
// ---------------------------------------------------------------------------

/**
 * The sizing the inline diagram box imposes on the SVG inside it.
 *
 * `max-w-full` at every width was the bug: it guarantees the picture is never
 * wider than its box, so the `overflow-x-auto` around it can never have anything
 * to scroll, and a 1200px flowchart is drawn at 340px with its labels shrunk to
 * match. Below `md` the cap comes off and the scroll finally has a job; at `md`
 * and up the column is wide enough that fitting is the better answer.
 *
 * The class alone is not the whole fix — see `viewBoxSize`.
 */
export const DIAGRAM_SVG_SIZING =
  "[&_svg]:h-auto [&_svg]:max-w-none md:[&_svg]:max-w-full";

export interface Size {
  width: number;
  height: number;
}

/**
 * The size a rendered mermaid SVG was laid out at, read off its viewBox.
 *
 * Removing the `max-w-full` cap is necessary and not sufficient, and the reason
 * is in mermaid's own `configureSvgSize`: with `useMaxWidth` on — which
 * `MERMAID_SECURITY_CONFIG` sets for flowcharts and which every other diagram
 * type defaults to — the root element ships as `width="100%"` plus an inline
 * `style="max-width: <w>px"`. A `width` of 100% is *defined* to be the width of
 * the box, so no Tailwind cap was ever what limited it, and an inline
 * `max-width` outranks any class that tried. The picture is squeezed by its own
 * attributes.
 *
 * The viewBox is the only place the real width survives, so the component puts
 * it back on the element as `width`/`height` and drops the inline cap. Numbers
 * parsed here and written back as numbers: nothing from the diagram's source
 * reaches an attribute, which is what keeps this out of the security walk in
 * `mermaid-safety.ts`.
 *
 * Returns `null` for anything that is not four finite numbers describing a
 * positive area; the caller then leaves the SVG exactly as mermaid drew it.
 */
export function viewBoxSize(viewBox: string | null | undefined): Size | null {
  if (!viewBox) return null;
  const parts = viewBox.trim().split(/[\s,]+/);
  if (parts.length !== 4) return null;

  // `Number("")` is 0 and `Number(" 12 ")` is 12, so the emptiness of a part has
  // to be caught before the conversion rather than after it.
  if (parts.some((part) => part.length === 0)) return null;
  const numbers = parts.map((part) => Number(part));
  if (numbers.some((value) => !Number.isFinite(value))) return null;

  const width = numbers[2]!;
  const height = numbers[3]!;
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

/**
 * Whether a box is holding content it cannot show.
 *
 * The one pixel of slack is for the fractional widths a zoomed browser reports,
 * which would otherwise offer to enlarge a diagram that already fits.
 */
export function overflowsBox(scrollWidth: number, clientWidth: number): boolean {
  return scrollWidth - clientWidth > 1;
}

// ---------------------------------------------------------------------------
// The enlarged diagram: what a drag and a pinch are allowed to do
// ---------------------------------------------------------------------------

/**
 * Where the enlarged diagram sits: a scale, and the position of its top-left
 * corner inside the viewport, in CSS pixels. The stage's `transform-origin` is
 * that same corner, so the two compose as `translate(x, y) scale(scale)`.
 */
export interface DiagramView {
  scale: number;
  x: number;
  y: number;
}

export const DIAGRAM_MAX_SCALE = 4;

/** The floor the buttons and a pinch can reach — unless the whole picture needs
 *  a smaller one to be visible at all, which `scaleBounds` allows for. */
export const DIAGRAM_MIN_SCALE = 0.2;

/** The scale at which the whole picture fits the window. */
export function fitScale(content: Size, viewport: Size): number {
  if (content.width <= 0 || content.height <= 0) return 1;
  if (viewport.width <= 0 || viewport.height <= 0) return 1;
  return Math.min(
    viewport.width / content.width,
    viewport.height / content.height,
  );
}

/**
 * How far out and how far in the user may go.
 *
 * The floor is never above the scale that shows the whole picture. A diagram
 * six screens wide would otherwise have no zoom level from which its shape can
 * be seen at all, which is the one thing the enlarged view exists to offer.
 */
export function scaleBounds(
  content: Size,
  viewport: Size,
): { min: number; max: number } {
  const min = Math.min(DIAGRAM_MIN_SCALE, fitScale(content, viewport));
  return { min, max: Math.max(min, DIAGRAM_MAX_SCALE) };
}

export function clampScale(
  scale: number,
  content: Size,
  viewport: Size,
): number {
  const { min, max } = scaleBounds(content, viewport);
  if (!Number.isFinite(scale)) return min;
  return Math.min(max, Math.max(min, scale));
}

/**
 * One axis of the pan clamp: no gap at the edge while the picture is larger
 * than the window, and centred the moment it is smaller.
 *
 * Without the second half, zooming out leaves the diagram pinned to the corner
 * it happened to be dragged to, which reads as a rendering failure rather than
 * as a small picture.
 */
function clampAxis(offset: number, drawn: number, available: number): number {
  if (drawn <= available) return (available - drawn) / 2;
  if (!Number.isFinite(offset)) return 0;
  return Math.min(0, Math.max(available - drawn, offset));
}

export function clampView(
  view: DiagramView,
  content: Size,
  viewport: Size,
): DiagramView {
  const scale = clampScale(view.scale, content, viewport);
  return {
    scale,
    x: clampAxis(view.x, content.width * scale, viewport.width),
    y: clampAxis(view.y, content.height * scale, viewport.height),
  };
}

/**
 * Where the enlarged view opens: the size it was drawn at, top-left first.
 *
 * Not fitted. The user tapped a hint that said the diagram was too small to
 * read, and answering that by showing the whole thing at a quarter scale is the
 * same complaint in a bigger window. The overview is one tap away on the zoom
 * button; legibility is what the tap asked for.
 */
export function initialView(content: Size, viewport: Size): DiagramView {
  return clampView({ scale: 1, x: 0, y: 0 }, content, viewport);
}

/** The view that shows the whole picture, centred. */
export function fitView(content: Size, viewport: Size): DiagramView {
  return clampView(
    { scale: fitScale(content, viewport), x: 0, y: 0 },
    content,
    viewport,
  );
}

export function panView(
  view: DiagramView,
  dx: number,
  dy: number,
  content: Size,
  viewport: Size,
): DiagramView {
  return clampView({ ...view, x: view.x + dx, y: view.y + dy }, content, viewport);
}

/**
 * Zoom by `factor`, leaving the content point under `focal` where it is.
 *
 * `focal` is in viewport coordinates: the midpoint of a pinch, or the centre of
 * the window for a button. Zooming around the origin instead would send whatever
 * the user was reading off the edge on every step.
 */
export function zoomAround(
  view: DiagramView,
  factor: number,
  focal: { x: number; y: number },
  content: Size,
  viewport: Size,
): DiagramView {
  if (!(view.scale > 0) || !Number.isFinite(factor) || factor <= 0) {
    return clampView(view, content, viewport);
  }
  const scale = clampScale(view.scale * factor, content, viewport);
  const pointX = (focal.x - view.x) / view.scale;
  const pointY = (focal.y - view.y) / view.scale;
  return clampView(
    { scale, x: focal.x - pointX * scale, y: focal.y - pointY * scale },
    content,
    viewport,
  );
}

/**
 * The multiplier a two-finger spread asks for.
 *
 * `1` — no change — whenever the gesture starts from a distance too small to
 * divide by, which is what a second finger landing on top of the first reports.
 */
export function pinchFactor(startDistance: number, distance: number): number {
  if (!(startDistance > 0) || !Number.isFinite(distance) || distance <= 0) {
    return 1;
  }
  return distance / startDistance;
}

/**
 * Whether the view is already showing all of the picture, within the half pixel
 * a fractional viewport leaves behind.
 *
 * Drives the one zoom button that has two jobs: it offers the overview while
 * the diagram is bigger than the window, and the drawn size once it is not.
 */
export function showsWholeDiagram(
  view: DiagramView,
  content: Size,
  viewport: Size,
): boolean {
  return (
    content.width * view.scale <= viewport.width + 0.5 &&
    content.height * view.scale <= viewport.height + 0.5
  );
}

/** The zoom, as the button prints it. Never "0%": a legible control has to say
 *  something a further tap can change. */
export function zoomLabel(scale: number): string {
  if (!Number.isFinite(scale) || scale <= 0) return "100%";
  return `${Math.max(1, Math.round(scale * 100))}%`;
}
