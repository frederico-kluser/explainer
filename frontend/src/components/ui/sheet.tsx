"use client";

import { useId, type ReactNode } from "react";

import {
  Sheet,
  SheetBackdrop,
  SheetClose,
  SheetHandle,
  SheetPanel,
} from "@/components/motion-ui/sheet";

export interface BottomSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The heading, which is also the dialog's accessible name. */
  title: string;
  children?: ReactNode;
}

/**
 * The app's drawer: the vendored sheet, dressed and made safe to scroll.
 *
 * Everything hard here already ships in `motion-ui/sheet` — a native `<dialog>`
 * with real modal focus handling, a spring panel that dismisses on a downward
 * drag or a flick, and a scrim whose opacity tracks the drag. This wrapper adds
 * the three things the registry cannot know about:
 *
 *  - `touch-pan-y!`. The panel sets `touch-action: none` inline so a vertical
 *    drag becomes the dismiss gesture instead of a page scroll. An ancestor at
 *    `none` also freezes every scroller inside it, which is most of what these
 *    sheets contain — the conversation list, the four panels. The `!` is the
 *    point: an author `!important` declaration is the only thing that outranks
 *    an inline style, and the inline style lives in a vendored file. What the
 *    browser does with `pan-y` is exactly the split we want: a touch that lands
 *    on the list scrolls the list, and a touch on the handle or the header,
 *    where nothing can scroll, still reaches the drag.
 *  - A unique `labelledBy`. The default id is a constant, and two sheets are
 *    mounted at once.
 *  - The bottom inset. The page is `viewport-fit=cover`, so the panel's own
 *    margin is measured to the physical edge, under the home indicator.
 */
export function BottomSheet({
  open,
  onOpenChange,
  title,
  children,
}: BottomSheetProps) {
  const titleId = useId();

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetBackdrop className="bg-black/70" label="Fechar" />
      <SheetPanel labelledBy={titleId} className="touch-pan-y!">
        <SheetHandle />

        <div className="flex items-center gap-3 pb-3">
          <h2 id={titleId} className="text-sm font-semibold text-foreground">
            {title}
          </h2>
          <SheetClose label="Fechar" className="ml-auto size-9" />
        </div>

        <div className="max-h-[62dvh] overflow-y-auto overscroll-contain">
          {children}
        </div>

        <div className="h-[env(safe-area-inset-bottom)]" aria-hidden="true" />
      </SheetPanel>
    </Sheet>
  );
}
