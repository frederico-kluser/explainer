"use client";

import { useState } from "react";
import { motion } from "motion/react";
import { Wrench } from "lucide-react";
import { useMotionUITransition } from "@/components/motion-ui/ui-theme";
import { cn } from "@/lib/utils";
import { BUBBLE_MAX_WIDTH, TAP_ROW } from "@/components/ui/mobile-content";

export interface ToolTraceProps {
  content: string;
}

const PREVIEW_LENGTH = 180;

/**
 * Compact rendering for `role: "tool"` messages.
 *
 * These carry raw grep/web-research output. Rendered through ChatBubble they
 * read as if the assistant said them, so they get their own muted, collapsible
 * treatment instead.
 */
export function ToolTrace({ content }: ToolTraceProps) {
  const transition = useMotionUITransition("snap");
  const [expanded, setExpanded] = useState(false);

  const isLong = content.length > PREVIEW_LENGTH;
  const shown =
    expanded || !isLong ? content : `${content.slice(0, PREVIEW_LENGTH)}…`;

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={transition}
      className="flex justify-start"
    >
      {/* The width comes from the component now. The wrapper in `App.tsx` that
          used to set it reached for `[data-role]`, which this card does not
          carry, so on a phone the tool output was the one thing still capped at
          the desktop 80%. */}
      <div
        className={cn(
          BUBBLE_MAX_WIDTH,
          "rounded-lg border border-border bg-muted/40 px-3 py-2",
        )}
      >
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Wrench className="size-3" />
          <span>Ferramenta</span>
        </div>
        {/* Monospace at 12px is 40 characters on a 360px screen, which is where
            a grep result stops being a result and starts being a texture. */}
        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words font-mono text-[13px] leading-snug text-muted-foreground md:text-xs">
          {shown}
        </pre>
        {isLong && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className={cn(
              TAP_ROW,
              "mt-1 flex items-center text-xs text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground",
            )}
          >
            {expanded ? "Mostrar menos" : "Mostrar tudo"}
          </button>
        )}
      </div>
    </motion.div>
  );
}
