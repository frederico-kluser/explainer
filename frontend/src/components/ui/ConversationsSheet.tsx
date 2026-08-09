"use client";

import type { ReactNode } from "react";
import { Search } from "lucide-react";

import { BottomSheet } from "@/components/ui/sheet";

export interface ConversationsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Opens the command palette, after closing this sheet — see below. */
  onSearch: () => void;
  /** The `Sidebar`, with its rail styling undone. */
  children?: ReactNode;
}

/**
 * The conversation list, as a drawer.
 *
 * The search button is here because ⌘K is not a gesture a phone has, and the
 * palette's own trigger is parked off-screen in `App`. It is a full-width row
 * rather than the rail's 20px `⌘K` chip for the same reason.
 *
 * `Sidebar` is the rail's file and belongs to another wave, so its fixed 288px
 * width, its divider and its recessed ground are undone from out here instead
 * of edited in place — a rail 288px wide inside a 344px drawer is the same bug
 * this layout exists to fix.
 */
export function ConversationsSheet({
  open,
  onOpenChange,
  onSearch,
  children,
}: ConversationsSheetProps) {
  return (
    <BottomSheet open={open} onOpenChange={onOpenChange} title="Conversas">
      <button
        type="button"
        onClick={onSearch}
        className="mb-2 flex h-11 w-full items-center gap-2 rounded-lg border border-border bg-card px-3 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <Search className="size-4 shrink-0" />
        Buscar conversa
      </button>

      <div className="[&>aside]:w-full [&>aside]:border-r-0 [&>aside]:bg-transparent">
        {children}
      </div>
    </BottomSheet>
  );
}
