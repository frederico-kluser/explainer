"use client";

import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { AlertTriangle, Loader } from "lucide-react";

import { cn } from "@/lib/utils";
import { useMotionUITransition } from "@/components/motion-ui/ui-theme";
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
        host.replaceChildren(document.importNode(parsed.documentElement, true));
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
          "overflow-x-auto [&_svg]:h-auto [&_svg]:max-w-full",
          (pending || error) && "hidden",
        )}
      />

      {error && (
        <div data-role="diagram-error" className="text-xs">
          <p className="flex items-start gap-1.5 text-destructive">
            <AlertTriangle className="mt-px size-3.5 shrink-0" />
            <span>{error}</span>
          </p>
          <button
            type="button"
            onClick={() => setShowSource((value) => !value)}
            className="mt-1 text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground"
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
