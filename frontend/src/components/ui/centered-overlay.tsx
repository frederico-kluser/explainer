"use client";

import { useRef, type ReactNode } from "react";

import {
  Backdrop,
  useFocusTrap,
  useScrollLock,
} from "@/components/motion-ui/overlay";

export interface CenteredOverlayProps {
  open: boolean;
  onClose: () => void;
  /** The heading, which is also the dialog's accessible name. */
  title: string;
  children?: ReactNode;
  /**
   * Rendered below the scrollable body, pinned to the bottom of the card —
   * the one part of the modal that never scrolls away.
   */
  footer?: ReactNode;
}

/**
 * A centered modal overlay, as opposed to the bottom-sheet drawer.
 *
 * Uses the same primitives the vendored sheet runs on — focus trap, scroll
 * lock, and a dimming scrim — but positions the panel in the centre of the
 * viewport instead of pinning it to the bottom. The panel carries its own
 * scroll container, so long content scrolls inside the modal rather than
 * pushing the page behind it.
 */
export function CenteredOverlay({
  open,
  onClose,
  title,
  children,
  footer,
}: CenteredOverlayProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useScrollLock(open);
  useFocusTrap({
    active: open,
    container: containerRef,
    onEscape: onClose,
    initialFocus: closeRef,
    restoreFocus: true,
  });

  if (!open) return null;

  return (
    <>
      <Backdrop
        onClick={onClose}
        label="Fechar"
        className="fixed inset-0 z-50"
      />

      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
      >
        <div className="relative flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl">
          {/* Header */}
          <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold text-foreground">{title}</h2>
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              aria-label="Fechar"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            </button>
          </div>

          {/* Scrollable body — grows to fill the card, so the footer below it
              stays pinned while the body scrolls. */}
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">
            {children}
          </div>

          {/* Footer — outside the scroll container, always visible. */}
          {footer && (
            <div className="shrink-0 border-t border-border px-4 py-3">
              {footer}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
