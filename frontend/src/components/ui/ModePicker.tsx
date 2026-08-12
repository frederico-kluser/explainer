"use client";

import { useEffect, useState } from "react";
import {
  Compass,
  FileText,
  Lightbulb,
  MessagesSquare,
  Presentation,
  Sparkles,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { CenteredOverlay } from "@/components/ui/centered-overlay";
import { Skeleton } from "@/components/motion-ui/skeleton";
import * as api from "@/lib/api";
import type { ModeSummary } from "@/types";

/**
 * The icons a mode may name.
 *
 * An allowlist rather than a dynamic lookup: the server sends a string, and
 * pulling a component out of the icon package by that string would let whatever
 * is on the wire decide what gets rendered. A name that is not here falls back,
 * so a new mode that picks an unlisted icon looks plain instead of crashing.
 */
const ICONS: Record<string, LucideIcon> = {
  MessagesSquare,
  Presentation,
  FileText,
  Lightbulb,
  Compass,
  Sparkles,
};

export interface ModePickerProps {
  open: boolean;
  onClose: () => void;
  /** Called with the chosen mode's id. The caller creates the conversation. */
  onChoose: (modeId: string) => void;
}

/**
 * What kind of conversation this is going to be.
 *
 * Asked once, when the conversation is created, because the answer is frozen
 * into the session token along with the instructions and the tool list — there
 * is no way to change it later that would not mean tearing down a live call.
 *
 * The list is fetched, never hard-coded. That is the whole modularity claim of
 * this feature: a mode added to `backend/src/modes/registry.ts` shows up here on
 * its own, and this file never learns its name.
 */
export function ModePicker({ open, onClose, onChoose }: ModePickerProps) {
  const [modes, setModes] = useState<ModeSummary[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    setFailed(false);
    void api
      .listModes()
      .then((envelope) => {
        if (!cancelled) setModes(envelope.modes);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  return (
    <CenteredOverlay open={open} onClose={onClose} title="Nova conversa">
      <p className="mb-4 text-sm text-muted-foreground">
        O modo define para que serve esta conversa, e não muda depois.
      </p>

      {failed ? (
        <p className="text-sm text-destructive">
          Não foi possível carregar os modos. Feche e tente de novo.
        </p>
      ) : modes === null ? (
        <div className="space-y-2">
          <Skeleton className="h-20 w-full rounded-lg" animate />
          <Skeleton className="h-20 w-full rounded-lg" animate />
        </div>
      ) : (
        <div className="space-y-2">
          {modes.map((mode) => {
            const Icon = ICONS[mode.icon] ?? Sparkles;
            return (
              <button
                key={mode.id}
                type="button"
                onClick={() => onChoose(mode.id)}
                className={cn(
                  "flex w-full items-start gap-3 rounded-lg border border-border p-3 text-left",
                  "transition-colors hover:border-primary/60 hover:bg-accent",
                )}
              >
                <span className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <Icon className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-foreground">
                    {mode.label}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {mode.description}
                  </span>
                  {!mode.requires_material && (
                    <span className="mt-1.5 inline-block rounded-full bg-muted/60 px-2 py-0.5 text-[10px] text-muted-foreground">
                      não precisa de material
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </CenteredOverlay>
  );
}
