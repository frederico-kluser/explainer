"use client";

import { Menu, MoreHorizontal } from "lucide-react";

import { cn } from "@/lib/utils";

export interface MobileTopBarProps {
  /** The active conversation's title. */
  title: string;
  live: boolean;
  connecting: boolean;
  /** What this session has cost so far, in dollars. */
  sessionUsd: number;
  /** How many pi agents are still working, for the badge on the panels button. */
  runningJobs: number;
  onOpenConversations: () => void;
  onOpenPanels: () => void;
}

/** 44px, the smallest target a thumb hits reliably. */
const TAP_TARGET =
  "inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";

/**
 * The phone's only permanent chrome.
 *
 * Everything the 288px rail used to hold is behind one of these two buttons, so
 * the bar carries what a rail shows without being asked: where you are, whether
 * the call is running and what it has cost, and whether an agent is still
 * working somewhere you cannot see.
 */
export function MobileTopBar({
  title,
  live,
  connecting,
  sessionUsd,
  runningJobs,
  onOpenConversations,
  onOpenPanels,
}: MobileTopBarProps) {
  return (
    <header
      className="flex shrink-0 items-center gap-1 border-b border-border bg-background px-1 pb-1"
      // The page is viewport-fit=cover, so the first row of pixels is under the
      // notch until this pushes it down.
      style={{ paddingTop: "max(0.25rem, env(safe-area-inset-top))" }}
    >
      <button
        type="button"
        onClick={onOpenConversations}
        className={TAP_TARGET}
        aria-label="Conversas"
      >
        <Menu className="size-5" />
      </button>

      <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
        {title}
      </span>

      {(live || connecting) && (
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium",
            live
              ? "bg-emerald-500/10 text-emerald-400"
              : "bg-primary/10 text-primary",
          )}
          title={live ? "Chamada aberta" : "Conectando"}
        >
          <span
            className={cn(
              "size-1.5 rounded-full",
              live ? "bg-emerald-400" : "bg-primary",
            )}
          />
          {live ? (
            <span className="tabular-nums">${sessionUsd.toFixed(4)}</span>
          ) : (
            "conectando"
          )}
        </span>
      )}

      <button
        type="button"
        onClick={onOpenPanels}
        className={cn(TAP_TARGET, "relative")}
        aria-label="Agentes, voz, custo e memória"
      >
        <MoreHorizontal className="size-5" />
        {runningJobs > 0 && (
          <span
            className="absolute right-1.5 top-1.5 inline-flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium tabular-nums text-primary-foreground"
            aria-label={`${runningJobs} agente(s) trabalhando`}
          >
            {runningJobs}
          </span>
        )}
      </button>
    </header>
  );
}
