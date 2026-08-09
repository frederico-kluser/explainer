"use client";

import type { ReactNode } from "react";

import {
  SmoothTabs,
  SmoothTabsList,
  SmoothTabsPanel,
  SmoothTabsPanels,
  SmoothTabsTab,
} from "@/components/motion-ui/smooth-tabs";
import { BottomSheet } from "@/components/ui/sheet";

export interface PanelsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The running and finished agent cards, or an empty state. */
  agents: ReactNode;
  voice: ReactNode;
  cost: ReactNode;
  memory: ReactNode;
}

/** Short enough that four of them fit across 360px. */
const TAB_CLASS = "px-1 py-2 text-xs";

/**
 * The lower half of the rail, as a drawer.
 *
 * On a phone these four are the same kind of thing — settings and readouts you
 * consult and then leave — so they are tabs rather than a stack: one scroll
 * through four unrelated panels is how the rail already reads badly on desktop,
 * and it reads worse in a drawer that only shows two thirds of a screen.
 *
 * Only the selected panel is mounted, which is deliberate: `MemoryPanel` fetches
 * when it appears, and the memory of a conversation is stale exactly when a
 * call has just ended.
 */
export function PanelsSheet({
  open,
  onOpenChange,
  agents,
  voice,
  cost,
  memory,
}: PanelsSheetProps) {
  return (
    <BottomSheet open={open} onOpenChange={onOpenChange} title="Painéis">
      <SmoothTabs defaultValue="agentes" className="flex flex-col gap-3">
        <SmoothTabsList ariaLabel="Painéis da conversa">
          <SmoothTabsTab value="agentes" className={TAB_CLASS}>
            Agentes
          </SmoothTabsTab>
          <SmoothTabsTab value="voz" className={TAB_CLASS}>
            Voz
          </SmoothTabsTab>
          <SmoothTabsTab value="custo" className={TAB_CLASS}>
            Custo
          </SmoothTabsTab>
          <SmoothTabsTab value="memoria" className={TAB_CLASS}>
            Memória
          </SmoothTabsTab>
        </SmoothTabsList>

        <SmoothTabsPanels className="min-h-40">
          <SmoothTabsPanel value="agentes">{agents}</SmoothTabsPanel>
          <SmoothTabsPanel value="voz">{voice}</SmoothTabsPanel>
          <SmoothTabsPanel value="custo">{cost}</SmoothTabsPanel>
          <SmoothTabsPanel value="memoria">{memory}</SmoothTabsPanel>
        </SmoothTabsPanels>
      </SmoothTabs>
    </BottomSheet>
  );
}
