"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { AlertTriangle, Loader, Maximize2, Minus, Plus } from "lucide-react";

import { cn } from "@/lib/utils";
import { useMotionUITransition } from "@/components/motion-ui/ui-theme";
import { BottomSheet } from "@/components/ui/sheet";
import {
  DIAGRAM_SVG_SIZING,
  TAP_ROW,
  TAP_TARGET,
  clampView,
  fitView,
  initialView,
  overflowsBox,
  panView,
  pinchFactor,
  showsWholeDiagram,
  viewBoxSize,
  zoomAround,
  zoomLabel,
  type DiagramView,
  type Size,
} from "@/components/ui/mobile-content";
// The canonical name of the data is `MermaidDiagram`, and so is the name of the
// component below it — one module cannot export both. The component keeps the
// bare name because that is what every call site writes, and the type is
// aliased on the way in: a renamed import is local to this file, while a renamed
// export would make `@/types` disagree with `backend/src/types/deep-tools.ts`
// about what the contract is called.
import type { MermaidDiagram as MermaidDiagramType } from "@/types";
import {
  MERMAID_SECURITY_CONFIG,
  describeRenderFailure,
  renderDiagramSource,
  sanitizeSvgElement,
} from "./mermaid-safety";

export interface MermaidDiagramProps {
  diagram: MermaidDiagramType;
  className?: string;
}

/**
 * Load and configure mermaid once, on the first diagram of the session.
 *
 * Dynamic, not static: mermaid is by far the heaviest thing this app could
 * depend on, and it belongs to a feature most voice calls never reach. The
 * import gives Vite its split point, so the parser is fetched when a diagram
 * actually arrives and never on the path to the microphone.
 *
 * Measured, three `vite build` runs against the same `node_modules`. The split
 * works, and it is not free:
 *
 *   before this component existed         entry 490,45 kB / 156,14 gz
 *                                         css    45,87 kB /   8,82 gz
 *   this branch, nothing importing it     entry 490,50 kB / 156,18 gz
 *   MermaidDiagram in the entry graph     entry 497,83 kB / 159,06 gz
 *                                         css    47,05 kB /   8,98 gz
 *                                         + mermaid.core 635,62 kB, lazy
 *
 * So the parser does leave the initial chunk, and the price paid before the
 * microphone is +7,38 kB raw / +2,92 kB gzip of JavaScript, plus +1,18 kB of CSS
 * that Tailwind emits for these files whether or not anything imports them.
 *
 * The middle row is the trap, and it is worth naming: while this component
 * existed but no screen rendered it, the build reported +0,05 kB — two orders of
 * magnitude below the real figure. Rollup tree-shook it out, and the build
 * measured its own absence. `App.tsx` renders it now, so the third row is the
 * one in force and the figure can be trusted again.
 *
 * The promise is memoised rather than the module, so ten diagrams arriving at
 * once share one download and one `initialize` — and, more importantly, none of
 * them can start rendering before the security config is installed. The
 * memoisation is dropped again if the import fails: a rejected promise left in
 * this slot is permanent, and one chunk request lost to a deploy mid-session, a
 * tunnel or a stale service worker would disable every diagram for the life of
 * the page even after the network came back.
 */
let mermaidReady: Promise<typeof import("mermaid").default> | null = null;

function loadMermaid(): Promise<typeof import("mermaid").default> {
  mermaidReady ??= import("mermaid")
    .then(({ default: mermaid }) => {
      mermaid.initialize(MERMAID_SECURITY_CONFIG);
      return mermaid;
    })
    .catch((err: unknown) => {
      mermaidReady = null;
      throw err;
    });
  return mermaidReady;
}

/**
 * A generated diagram, drawn.
 *
 * The end of the round trip the user asked for: the model describes what it
 * wants, the backend turns that into mermaid source, and this is where the
 * source becomes a picture. Everything about *how* it is drawn safely lives in
 * `mermaid-safety.ts`, next to the research that justifies it.
 *
 * The `caption` is deliberately not printed. The voice model has already said
 * it out loud by the time this mounts, and a screenful of text repeating what
 * the user just heard makes the picture harder to read, not easier. It is
 * attached as the accessible description instead, so it still reaches anyone
 * reading the page with assistive tech rather than listening to it.
 */
export function MermaidDiagram({ diagram, className }: MermaidDiagramProps) {
  const transition = useMotionUITransition("gentle");
  const hostRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(true);
  const [showSource, setShowSource] = useState(false);
  /** The drawing itself, kept so the enlarged view can clone it. */
  const [drawn, setDrawn] = useState<Element | null>(null);
  const [natural, setNatural] = useState<Size | null>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [enlarged, setEnlarged] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // `mermaid.render` is a promise, and the source can change or the component
    // can unmount while it is in flight. This flag is what stops a resolved
    // render from writing into a card that is no longer on screen — and stops
    // an older, slower render from overwriting a newer one.
    let live = true;

    setPending(true);
    setError(null);
    setDrawn(null);
    setNatural(null);
    setOverflowing(false);

    void (async () => {
      const outcome = await renderDiagramSource(
        diagram.source,
        async (id, text) => (await loadMermaid()).render(id, text),
      );
      if (!live) return;

      if (outcome.svg === null) {
        host.replaceChildren();
        setPending(false);
        setError(outcome.error ?? describeRenderFailure(null));
        return;
      }

      try {
        // Parsed as XML into a detached document: nothing here is connected to
        // the page yet, so nothing in it can run while it is being inspected.
        const parsed = new DOMParser().parseFromString(
          outcome.svg,
          "image/svg+xml",
        );
        if (
          parsed.querySelector("parsererror") ||
          parsed.documentElement.tagName.toLowerCase() !== "svg"
        ) {
          throw new Error("O renderizador devolveu algo que não é um SVG.");
        }

        sanitizeSvgElement(parsed.documentElement);

        // Adopted as nodes, never as a string. `dangerouslySetInnerHTML` would
        // re-parse the sanitised markup with the HTML parser and hand back
        // exactly the constructs the walk above just removed.
        const svg = document.importNode(parsed.documentElement, true);
        const size = giveBackNaturalSize(svg);

        host.replaceChildren(svg);
        setDrawn(svg);
        setNatural(size);
        setPending(false);
      } catch (err) {
        // Everything above this line is synchronous, so `live` cannot have
        // changed since it was checked.
        host.replaceChildren();
        setPending(false);
        setError(describeRenderFailure(err));
      }
    })();

    return () => {
      live = false;
    };
  }, [diagram.source]);

  // The hint is owed by the picture's width against the box's, not by the
  // breakpoint, so it is measured rather than asked of `useCompactLayout`: at
  // `md` the cap in `DIAGRAM_SVG_SIZING` puts the SVG inside its box and there
  // is nothing to offer, while a desktop window dragged below 768px earns the
  // hint for the same reason a phone does.
  //
  // Two measurements, because there are two ways the answer changes. This one
  // runs on the commit that reveals the host — until then it is `hidden` and
  // reports zero for both widths, so measuring inside the render above would
  // always say "fits".
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    setOverflowing(overflowsBox(host.scrollWidth, host.clientWidth));
  }, [drawn]);

  // And this one for every later change of the column's width, which includes
  // crossing the breakpoint in either direction.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      setOverflowing(overflowsBox(host.scrollWidth, host.clientWidth));
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  return (
    <motion.figure
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={transition}
      data-role="diagram"
      data-diagram-kind={diagram.kind}
      className={cn(
        "my-2 rounded-lg border border-border bg-muted/20 px-3 py-3",
        error && "border-destructive/40 bg-destructive/5",
        className,
      )}
    >
      {diagram.title && (
        <figcaption className="mb-2 text-xs font-medium text-foreground">
          {diagram.title}
        </figcaption>
      )}

      {pending && !error && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader className="size-3 animate-spin" />
          Desenhando o diagrama…
        </p>
      )}

      {/* `role="img"` is what makes the caption reach a screen reader: on a
          bare div an aria-label is ignored, and the SVG underneath is a pile of
          paths that describes nothing. */}
      <div
        ref={hostRef}
        role="img"
        aria-label={diagram.caption}
        className={cn(
          "overflow-x-auto overscroll-x-contain",
          DIAGRAM_SVG_SIZING,
          (pending || error) && "hidden",
        )}
      />

      {/* Only mounted once the diagram is genuinely too wide for its box, which
          keeps a `<dialog>` per drawing out of a transcript full of them. The
          `|| enlarged` is for the window resized past `md` while the drawer is
          open: unmounting an open dialog under the user is worse than one that
          outstays the hint that opened it. */}
      {(overflowing || enlarged) && !error && (
        <>
          {overflowing && (
            <button
              type="button"
              onClick={() => setEnlarged(true)}
              className={cn(
                TAP_ROW,
                "mt-1 flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground",
              )}
            >
              <Maximize2 className="size-3.5 shrink-0" />
              <span className="underline underline-offset-2">
                Tocar para ampliar
              </span>
            </button>
          )}

          <BottomSheet
            open={enlarged}
            onOpenChange={setEnlarged}
            title={diagram.title || "Diagrama"}
          >
            <DiagramViewer
              drawn={drawn}
              natural={natural}
              caption={diagram.caption}
            />
          </BottomSheet>
        </>
      )}

      {error && (
        <div data-role="diagram-error" className="text-xs">
          <p className="flex items-start gap-1.5 text-destructive">
            <AlertTriangle className="mt-px size-3.5 shrink-0" />
            <span>{error}</span>
          </p>
          <button
            type="button"
            onClick={() => setShowSource((value) => !value)}
            className={cn(
              TAP_ROW,
              "mt-1 flex items-center text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground",
            )}
          >
            {showSource ? "Esconder o código" : "Ver o código do diagrama"}
          </button>
          {showSource && (
            <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words rounded border border-border bg-muted/40 p-2 font-mono text-[11px] text-muted-foreground">
              {diagram.source}
            </pre>
          )}
        </div>
      )}
    </motion.figure>
  );
}

/**
 * Put the size mermaid measured back onto the element it drew, in place.
 *
 * The reasoning is in `viewBoxSize`; this is the mutation half. Two attributes
 * written as numbers this function parsed itself, and one inline declaration
 * removed — nothing from the diagram's source reaches the element here, which is
 * why this sits outside `mermaid-safety.ts` rather than inside it. It also runs
 * strictly after `sanitizeSvgElement`, so the walk still sees exactly what
 * mermaid produced.
 */
function giveBackNaturalSize(svg: Element): Size | null {
  const size = viewBoxSize(svg.getAttribute("viewBox"));
  if (!size) return null;

  svg.setAttribute("width", String(size.width));
  svg.setAttribute("height", String(size.height));

  // `style="max-width: <w>px"` is an inline declaration, so it outranks every
  // class: while it is there, neither cap in `DIAGRAM_SVG_SIZING` decides
  // anything. The element is an `SVGSVGElement` at runtime — `documentElement`
  // is typed `HTMLElement` whatever the document's namespace — so the style map
  // is reached through the interface both of them implement.
  (svg as Partial<ElementCSSInlineStyle>).style?.removeProperty("max-width");

  return size;
}

interface DiagramViewerProps {
  /** The sanitised SVG already drawn on the card. */
  drawn: Element | null;
  /** The size it was drawn at, or `null` if its viewBox did not say. */
  natural: Size | null;
  caption: string;
}

/** One tap of a zoom button. Coarse on purpose: three taps have to cross the
 *  distance between an overview and a readable label. */
const ZOOM_STEP = 1.6;

/**
 * The diagram, filling the drawer, with a drag and a pinch on it.
 *
 * Every gesture here is implemented rather than borrowed, and the reason is the
 * drawer. `BottomSheet` puts `touch-action: pan-y` on the panel so its contents
 * can still scroll under a vendored `touch-action: none`, and a browser
 * intersects that value with every descendant's: inside this panel there is no
 * horizontal panning and no pinch to be had, whatever this element asks for. So
 * it asks for `touch-none` — the one direction the intersection can still move —
 * and reads the pointers itself. That also settles the other half of the
 * problem, which is that a downward drag over the picture would otherwise be
 * the drawer's dismiss gesture.
 */
function DiagramViewer({ drawn, natural, caption }: DiagramViewerProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<Size>({ width: 0, height: 0 });
  const [view, setView] = useState<DiagramView | null>(null);

  // Mirrors, for the native listeners below: they are registered once and would
  // otherwise keep reading the first render's numbers for the whole gesture.
  const viewRef = useRef<DiagramView | null>(null);
  const boxRef = useRef<Size>({ width: 0, height: 0 });
  useEffect(() => {
    viewRef.current = view;
  }, [view]);
  useEffect(() => {
    boxRef.current = box;
  }, [box]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    if (!drawn) {
      stage.replaceChildren();
      return;
    }
    // Cloned rather than rendered again: mermaid's layout is the expensive half
    // and this is the same picture. The two copies share element ids, which
    // costs nothing — a `url(#arrowhead)` resolves to the first identical
    // definition in document order and draws the same marker either way.
    stage.replaceChildren(drawn.cloneNode(true));
  }, [drawn]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const measure = () => {
      const rect = viewport.getBoundingClientRect();
      // The drawer is `display: none` until it opens, so the first honest
      // measurement is usually the observer's rather than this one's.
      if (rect.width <= 0 || rect.height <= 0) return;
      const size = { width: rect.width, height: rect.height };
      const content = natural ?? size;
      setBox(size);
      setView((current) =>
        current ? clampView(current, content, size) : initialView(content, size),
      );
    };

    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [natural]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const points = new Map<number, { x: number; y: number }>();
    let pinchDistance: number | null = null;

    const apply = (
      next: (
        current: DiagramView,
        content: Size,
        viewport: Size,
      ) => DiagramView,
    ) => {
      const size = boxRef.current;
      const current = viewRef.current;
      if (!current || size.width <= 0) return;
      const updated = next(current, natural ?? size, size);
      viewRef.current = updated;
      setView(updated);
    };

    const onDown = (event: PointerEvent) => {
      // The panel's dismiss-drag starts from a `pointerdown` on the panel
      // element itself, and React delivers its synthetic events from the root
      // container — far too late to stop it. The gesture ends here instead.
      event.stopPropagation();
      viewport.setPointerCapture(event.pointerId);
      points.set(event.pointerId, { x: event.clientX, y: event.clientY });
      pinchDistance = null;
    };

    const onMove = (event: PointerEvent) => {
      const previous = points.get(event.pointerId);
      if (!previous) return;
      event.stopPropagation();

      const position = { x: event.clientX, y: event.clientY };
      points.set(event.pointerId, position);

      const active = [...points.values()];
      const first = active[0];
      const second = active[1];

      if (first && second) {
        const distance = Math.hypot(second.x - first.x, second.y - first.y);
        // The first move of a pinch only establishes the span; scaling from it
        // would jump the picture by whatever the second finger travelled before
        // the browser reported it.
        if (pinchDistance === null) {
          pinchDistance = distance;
          return;
        }
        const factor = pinchFactor(pinchDistance, distance);
        pinchDistance = distance;

        const rect = viewport.getBoundingClientRect();
        const focal = {
          x: (first.x + second.x) / 2 - rect.left,
          y: (first.y + second.y) / 2 - rect.top,
        };
        apply((current, content, size) =>
          zoomAround(current, factor, focal, content, size),
        );
        return;
      }

      pinchDistance = null;
      const dx = position.x - previous.x;
      const dy = position.y - previous.y;
      apply((current, content, size) => panView(current, dx, dy, content, size));
    };

    const onRelease = (event: PointerEvent) => {
      points.delete(event.pointerId);
      if (points.size < 2) pinchDistance = null;
      if (viewport.hasPointerCapture(event.pointerId)) {
        viewport.releasePointerCapture(event.pointerId);
      }
    };

    viewport.addEventListener("pointerdown", onDown);
    viewport.addEventListener("pointermove", onMove);
    viewport.addEventListener("pointerup", onRelease);
    viewport.addEventListener("pointercancel", onRelease);
    return () => {
      viewport.removeEventListener("pointerdown", onDown);
      viewport.removeEventListener("pointermove", onMove);
      viewport.removeEventListener("pointerup", onRelease);
      viewport.removeEventListener("pointercancel", onRelease);
    };
  }, [natural]);

  const content = natural ?? box;
  const whole = view ? showsWholeDiagram(view, content, box) : false;
  const centre = { x: box.width / 2, y: box.height / 2 };

  const step = (factor: number) => {
    if (!view || box.width <= 0) return;
    setView(zoomAround(view, factor, centre, content, box));
  };

  const toggle = () => {
    if (!view || box.width <= 0) return;
    setView(
      whole
        ? zoomAround(view, 1 / view.scale, centre, content, box)
        : fitView(content, box),
    );
  };

  return (
    <div className="flex h-[62dvh] flex-col gap-2">
      <div
        ref={viewportRef}
        className="relative min-h-0 flex-1 touch-none select-none overflow-hidden rounded-lg border border-border bg-background"
      >
        <div
          ref={stageRef}
          role="img"
          aria-label={caption}
          className="absolute left-0 top-0 origin-top-left [&_svg]:h-auto [&_svg]:max-w-none"
          style={{
            transform: view
              ? `translate(${view.x}px, ${view.y}px) scale(${view.scale})`
              : undefined,
          }}
        />
      </div>

      <div className="flex items-center justify-center gap-2">
        <button
          type="button"
          className={TAP_TARGET}
          onClick={() => step(1 / ZOOM_STEP)}
          aria-label="Diminuir o zoom"
          title="Diminuir o zoom"
        >
          <Minus className="size-4" />
        </button>
        <button
          type="button"
          onClick={toggle}
          className="inline-flex min-h-11 min-w-16 items-center justify-center rounded-lg px-3 text-xs tabular-nums text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title={whole ? "Ver no tamanho original" : "Ver o diagrama inteiro"}
        >
          {view ? zoomLabel(view.scale) : "…"}
        </button>
        <button
          type="button"
          className={TAP_TARGET}
          onClick={() => step(ZOOM_STEP)}
          aria-label="Aumentar o zoom"
          title="Aumentar o zoom"
        >
          <Plus className="size-4" />
        </button>
      </div>

      {/* Said out loud because the gestures are this component's, not the
          browser's: nothing here responds to a two-finger page zoom. */}
      <p className="text-center text-[11px] text-muted-foreground">
        Arraste para mover, pince para aproximar.
      </p>
    </div>
  );
}
