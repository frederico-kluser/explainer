"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { FileText, PanelRightClose, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { useMotionUITransition } from "@/components/motion-ui/ui-theme";
import { DocumentPanel } from "@/components/ui/DocumentPanel";
import {
  MIN_WIDTH,
  clampWidth,
  maxWidth,
  readStoredWidth,
  widthFromKey,
  widthFromPointer,
  writeStoredWidth,
} from "@/components/ui/document-sidebar";

export interface DocumentSidebarProps {
  conversationId: string | null;
  /** From the mode: what this document is called on this screen. */
  title: string;
  /** From the mode: what the panel says while the document is empty. */
  placeholder: string;
  content: string;
  onContentChange: (content: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The phone shell. A pane you drag makes no sense on a 360px screen. */
  compact: boolean;
}

function viewportWidth(): number {
  return typeof window === "undefined" ? 1280 : window.innerWidth;
}

/**
 * The markdown, beside the conversation.
 *
 * Two shells, chosen by `compact`, because the same pane cannot serve both: on
 * a desktop it is a column you drag to whatever width the document needs, and
 * on a phone there is no width to negotiate — it is the screen or it is
 * nothing, so it becomes a full overlay.
 *
 * Closed on a desktop it leaves a rail behind rather than disappearing. A
 * document the model is writing into while nothing on screen says so is the one
 * state this feature cannot afford: the rail is how the user knows there is
 * something to open.
 */
export function DocumentSidebar({
  conversationId,
  title,
  placeholder,
  content,
  onContentChange,
  open,
  onOpenChange,
  compact,
}: DocumentSidebarProps) {
  const transition = useMotionUITransition("gentle");
  const [width, setWidth] = useState(() => readStoredWidth(viewportWidth()));
  const draggingRef = useRef(false);

  // A window that shrank below what the stored width allows would otherwise
  // leave the pane wider than the cap, with the transcript squeezed to nothing.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onResize = () => setWidth((current) => clampWidth(current, window.innerWidth));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const commit = useCallback((next: number) => {
    setWidth(next);
    writeStoredWidth(next);
  }, []);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    // Pointer capture is what keeps the drag alive when the cursor outruns the
    // 6px handle — without it the first fast drag drops on the first frame.
    event.currentTarget.setPointerCapture(event.pointerId);
    draggingRef.current = true;
  }, []);

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    // Not committed to storage on every frame: a drag is dozens of moves and
    // the last one is the only one worth remembering.
    setWidth(widthFromPointer(event.clientX, viewportWidth()));
  }, []);

  const endDrag = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      event.currentTarget.releasePointerCapture(event.pointerId);
      commit(widthFromPointer(event.clientX, viewportWidth()));
    },
    [commit],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const next = widthFromKey(event.key, width, viewportWidth());
      if (next === null) return;
      event.preventDefault();
      commit(next);
    },
    [commit, width],
  );

  const panel = (
    <DocumentPanel
      conversationId={conversationId}
      content={content}
      placeholder={placeholder}
      onContentChange={onContentChange}
    />
  );

  // ── Phone ────────────────────────────────────────────────────────
  if (compact) {
    if (!open) return null;
    return (
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={transition}
        className="fixed inset-0 z-40 flex flex-col bg-background"
        role="dialog"
        aria-label={title}
      >
        <header
          className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1"
          style={{ paddingTop: "max(0.25rem, env(safe-area-inset-top))" }}
        >
          <FileText className="size-4 text-muted-foreground" />
          <span className="flex-1 text-sm font-medium text-foreground">{title}</span>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="inline-flex size-11 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label="Fechar"
          >
            <X className="size-5" />
          </button>
        </header>
        <div className="min-h-0 flex-1">{panel}</div>
      </motion.div>
    );
  }

  // ── Desktop, closed ──────────────────────────────────────────────
  if (!open) {
    return (
      <aside className="flex w-9 shrink-0 flex-col items-center border-l border-border bg-muted/10 py-2">
        <button
          type="button"
          onClick={() => onOpenChange(true)}
          className="flex flex-col items-center gap-2 rounded-md px-1 py-2 text-muted-foreground transition-colors hover:text-foreground"
          aria-label={`Abrir ${title}`}
          title={`Abrir ${title}`}
        >
          <FileText className="size-4" />
          <span
            className="text-[10px] font-medium uppercase tracking-wider"
            style={{ writingMode: "vertical-rl" }}
          >
            {title}
          </span>
        </button>
      </aside>
    );
  }

  // ── Desktop, open ────────────────────────────────────────────────
  return (
    <aside
      className="flex shrink-0 flex-row border-l border-border bg-background"
      style={{ width }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Largura do painel"
        aria-valuenow={width}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={maxWidth(viewportWidth())}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
        className={cn(
          "w-1.5 shrink-0 cursor-col-resize bg-transparent transition-colors",
          "hover:bg-primary/40 focus-visible:bg-primary/60 focus-visible:outline-none",
        )}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
          <FileText className="size-3.5 text-muted-foreground" />
          <span className="flex-1 text-xs font-medium text-foreground">{title}</span>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="inline-flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label={`Fechar ${title}`}
          >
            <PanelRightClose className="size-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1">{panel}</div>
      </div>
    </aside>
  );
}
