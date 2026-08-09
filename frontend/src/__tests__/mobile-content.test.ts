import { describe, it, expect } from "vitest";

import {
  BUBBLE_MAX_WIDTH,
  DIAGRAM_MAX_SCALE,
  DIAGRAM_MIN_SCALE,
  DIAGRAM_SVG_SIZING,
  TAP_ROW,
  TAP_TARGET,
  TAP_TARGET_RAIL,
  clampScale,
  clampView,
  fitScale,
  fitView,
  initialView,
  overflowsBox,
  panView,
  pinchFactor,
  scaleBounds,
  showsWholeDiagram,
  viewBoxSize,
  zoomAround,
  zoomLabel,
} from "@/components/ui/mobile-content";

// No jsdom here, so none of these components is mounted: what is asserted is
// the part of them that decides. The sizing contracts that make a diagram
// readable on a phone, the geometry of the enlarged view, and the two class
// recipes that used to be written from outside the components that need them.
//
// A 360px phone against a 1200px flowchart is the case every number below is
// aimed at, because that is the one that was broken.

// ---------------------------------------------------------------------------
// The three class contracts
// ---------------------------------------------------------------------------

describe("the inline diagram sizing", () => {
  it("lets the SVG be wider than its box below md", () => {
    // The whole bug in one utility: with `max-w-full` at every width the
    // picture is defined never to exceed its box, so the `overflow-x-auto`
    // around it can never have anything to scroll.
    expect(DIAGRAM_SVG_SIZING).toContain("[&_svg]:max-w-none");
  });

  it("still fits the SVG to the column at md and up", () => {
    expect(DIAGRAM_SVG_SIZING).toContain("md:[&_svg]:max-w-full");
  });

  it("caps nothing unconditionally", () => {
    // `[&_svg]:max-w-full` without the `md:` prefix is the regression this
    // case exists to catch: it would win at every width and put the squeeze
    // back.
    expect(DIAGRAM_SVG_SIZING).not.toMatch(/(^|\s)\[&_svg\]:max-w-full/);
  });

  it("leaves the aspect ratio to the height", () => {
    expect(DIAGRAM_SVG_SIZING).toContain("[&_svg]:h-auto");
  });
});

describe("the bubble width", () => {
  it("gives a phone back all but 8% of the column", () => {
    expect(BUBBLE_MAX_WIDTH).toContain("max-w-[92%]");
  });

  it("keeps the desktop cap at md", () => {
    expect(BUBBLE_MAX_WIDTH).toContain("md:max-w-[80%]");
  });
});

describe("the tap targets", () => {
  it("are 44px", () => {
    // `size-11` is 2.75rem at the default 16px root. The same figure the top
    // bar uses, and the smallest a thumb hits reliably.
    expect(TAP_TARGET).toContain("size-11");
    expect(TAP_ROW).toContain("min-h-11");
  });

  it("shrink back for a mouse where the control exists at both widths", () => {
    // These cards also live in the 288px rail. A column of 44px cancel buttons
    // there pushes the cost readout off its row.
    expect(TAP_TARGET_RAIL).toContain("md:size-6");
    expect(TAP_ROW).toContain("md:min-h-0");
  });

  it("keeps the plain target at 44px everywhere", () => {
    // The zoom controls only exist inside the enlarged sheet, which is only
    // reachable below md. Shrinking them at a width they never see would be a
    // rule nobody can check.
    expect(TAP_TARGET).not.toContain("md:size-");
  });
});

// ---------------------------------------------------------------------------
// The size mermaid hides in the viewBox
// ---------------------------------------------------------------------------

describe("viewBoxSize", () => {
  it("reads the drawn size off a mermaid viewBox", () => {
    expect(viewBoxSize("0 0 1200 480")).toEqual({ width: 1200, height: 480 });
  });

  it("accepts the comma and the fractional spellings", () => {
    // Mermaid emits fractional widths — the layout is measured, not rounded.
    expect(viewBoxSize("0,0,1234.5,567.25")).toEqual({
      width: 1234.5,
      height: 567.25,
    });
    expect(viewBoxSize("  -8   -8\t1216  496 ")).toEqual({
      width: 1216,
      height: 496,
    });
  });

  it("refuses anything that is not four numbers", () => {
    expect(viewBoxSize(null)).toBeNull();
    expect(viewBoxSize(undefined)).toBeNull();
    expect(viewBoxSize("")).toBeNull();
    expect(viewBoxSize("0 0 1200")).toBeNull();
    expect(viewBoxSize("0 0 1200 480 12")).toBeNull();
    expect(viewBoxSize("0 0 wide tall")).toBeNull();
  });

  it("refuses a viewBox describing no area", () => {
    // Falling through to the caller's `null` leaves the SVG exactly as mermaid
    // drew it, which is worse-looking and never broken.
    expect(viewBoxSize("0 0 0 480")).toBeNull();
    expect(viewBoxSize("0 0 1200 -1")).toBeNull();
  });

  it("does not read an empty field as a zero", () => {
    // `Number("")` is 0, so an emptiness that survives the split would become a
    // legitimate-looking coordinate.
    expect(viewBoxSize("0 0 1200 ")).toBeNull();
  });
});

describe("overflowsBox", () => {
  it("sees a flowchart that does not fit a phone", () => {
    expect(overflowsBox(1200, 328)).toBe(true);
  });

  it("stays quiet on a fractional viewport", () => {
    // A browser at 110% zoom reports widths that disagree by less than a pixel,
    // and offering to enlarge a diagram that already fits is a hint that reads
    // as a bug.
    expect(overflowsBox(328.4, 328)).toBe(false);
    expect(overflowsBox(328, 328)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The enlarged view
// ---------------------------------------------------------------------------

/** The case the whole feature exists for: a wide flowchart in a drawer. */
const flowchart = { width: 1200, height: 480 };
const drawer = { width: 300, height: 380 };

describe("fitScale", () => {
  it("picks the axis that runs out first", () => {
    expect(fitScale(flowchart, drawer)).toBeCloseTo(0.25, 5);
  });

  it("answers 1 rather than a division by zero", () => {
    // The drawer is display:none until it opens, so a measurement of zero is
    // the ordinary first reading and not an error.
    expect(fitScale(flowchart, { width: 0, height: 0 })).toBe(1);
    expect(fitScale({ width: 0, height: 0 }, drawer)).toBe(1);
  });
});

describe("scaleBounds", () => {
  it("always lets the whole picture be seen", () => {
    // Six screens wide: the ordinary 0.2 floor would leave no zoom level from
    // which the shape of the thing can be made out at all.
    const huge = { width: 6000, height: 480 };
    const bounds = scaleBounds(huge, drawer);
    expect(bounds.min).toBeLessThanOrEqual(fitScale(huge, drawer));
    expect(huge.width * bounds.min).toBeLessThanOrEqual(drawer.width);
  });

  it("does not go below the ordinary floor for a diagram that fits", () => {
    const small = { width: 200, height: 200 };
    expect(scaleBounds(small, drawer).min).toBe(DIAGRAM_MIN_SCALE);
  });

  it("stops zooming in at the documented ceiling", () => {
    expect(scaleBounds(flowchart, drawer).max).toBe(DIAGRAM_MAX_SCALE);
    expect(clampScale(99, flowchart, drawer)).toBe(DIAGRAM_MAX_SCALE);
  });

  it("falls back to the floor for a scale that is not a number", () => {
    expect(clampScale(Number.NaN, flowchart, drawer)).toBe(
      scaleBounds(flowchart, drawer).min,
    );
  });
});

describe("clampView", () => {
  it("never leaves a gap while the picture is larger than the window", () => {
    // Dragging right from the left edge would otherwise pull the diagram off
    // its own frame and show the background where the drawing should be.
    const view = clampView({ scale: 1, x: 200, y: 60 }, flowchart, drawer);
    expect(view.x).toBe(0);
    expect(view.y).toBe(0);
  });

  it("stops at the far edge", () => {
    const view = clampView({ scale: 1, x: -5000, y: 0 }, flowchart, drawer);
    expect(view.x).toBe(drawer.width - flowchart.width);
  });

  it("centres the picture the moment it is smaller than the window", () => {
    // Zooming out otherwise leaves it pinned to whichever corner it was last
    // dragged to, which reads as a rendering failure rather than a small
    // picture.
    const view = clampView({ scale: 0.2, x: -900, y: -300 }, flowchart, drawer);
    expect(view.x).toBeCloseTo((drawer.width - 1200 * 0.2) / 2, 5);
    expect(view.y).toBeCloseTo((drawer.height - 480 * 0.2) / 2, 5);
  });
});

describe("initialView", () => {
  it("opens at the size the diagram was drawn, top-left first", () => {
    // The user tapped a hint that said the picture was too small to read.
    // Answering with the whole thing at a quarter scale is the same complaint
    // in a bigger window.
    const view = initialView(flowchart, drawer);
    expect(view.scale).toBe(1);
    expect(view).toMatchObject({ x: 0, y: 0 });
  });

  it("centres a diagram that already fits", () => {
    const small = { width: 120, height: 100 };
    const view = initialView(small, drawer);
    expect(view.x).toBeCloseTo((drawer.width - 120) / 2, 5);
  });
});

describe("fitView", () => {
  it("shows the whole picture", () => {
    const view = fitView(flowchart, drawer);
    expect(showsWholeDiagram(view, flowchart, drawer)).toBe(true);
  });

  it("is not where the view starts", () => {
    expect(fitView(flowchart, drawer).scale).not.toBe(
      initialView(flowchart, drawer).scale,
    );
  });
});

describe("zoomAround", () => {
  it("leaves the point under the finger where it is", () => {
    const focal = { x: 150, y: 190 };
    const before = { scale: 1, x: -400, y: -100 };
    const after = zoomAround(before, 2, focal, flowchart, drawer);

    const pointBefore = (focal.x - before.x) / before.scale;
    const pointAfter = (focal.x - after.x) / after.scale;
    expect(pointAfter).toBeCloseTo(pointBefore, 5);
    expect(after.scale).toBe(2);
  });

  it("respects the ceiling without losing the anchor", () => {
    const focal = { x: 150, y: 190 };
    const clamped = zoomAround(
      { scale: DIAGRAM_MAX_SCALE, x: -400, y: -100 },
      10,
      focal,
      flowchart,
      drawer,
    );
    expect(clamped.scale).toBe(DIAGRAM_MAX_SCALE);
  });

  it("does nothing rather than divide by a scale of zero", () => {
    const view = zoomAround(
      { scale: 0, x: 0, y: 0 },
      2,
      { x: 10, y: 10 },
      flowchart,
      drawer,
    );
    expect(Number.isFinite(view.x)).toBe(true);
    expect(Number.isFinite(view.y)).toBe(true);
  });
});

describe("panView", () => {
  it("moves by the distance the finger moved", () => {
    const view = panView(
      { scale: 1, x: -400, y: -40 },
      60,
      -20,
      flowchart,
      drawer,
    );
    expect(view.x).toBe(-340);
    expect(view.y).toBe(-60);
  });

  it("stops at the edge instead of following the finger past it", () => {
    // 480px of drawing in a 380px window: 100px of travel and no more, however
    // far the drag goes.
    const view = panView(
      { scale: 1, x: -400, y: -40 },
      0,
      -500,
      flowchart,
      drawer,
    );
    expect(view.y).toBe(drawer.height - flowchart.height);
  });
});

describe("pinchFactor", () => {
  it("is the ratio of the two spans", () => {
    expect(pinchFactor(100, 250)).toBe(2.5);
  });

  it("asks for no change when the gesture starts on top of itself", () => {
    // Two fingers landing in the same place report a distance of zero, and the
    // multiplier that follows would be an infinity applied to the scale.
    expect(pinchFactor(0, 120)).toBe(1);
    expect(pinchFactor(120, 0)).toBe(1);
  });
});

describe("showsWholeDiagram", () => {
  it("is false while the picture is bigger than the window", () => {
    expect(showsWholeDiagram({ scale: 1, x: 0, y: 0 }, flowchart, drawer)).toBe(
      false,
    );
  });

  it("tolerates the half pixel a fractional viewport leaves behind", () => {
    const exact = { width: 300.4, height: 380.4 };
    expect(showsWholeDiagram({ scale: 1, x: 0, y: 0 }, exact, drawer)).toBe(
      true,
    );
  });
});

describe("zoomLabel", () => {
  it("prints the scale as a percentage", () => {
    expect(zoomLabel(1)).toBe("100%");
    expect(zoomLabel(0.25)).toBe("25%");
    expect(zoomLabel(2.5)).toBe("250%");
  });

  it("never prints a zero", () => {
    // A control that reads "0%" says the button no longer does anything, which
    // is exactly wrong: tapping + is what gets out of it.
    expect(zoomLabel(0.001)).toBe("1%");
    expect(zoomLabel(Number.NaN)).toBe("100%");
  });
});
