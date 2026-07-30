"use client";

import { useState } from "react";
import { motion } from "motion/react";
import { Wrench } from "lucide-react";
import { useMotionUITransition } from "@/components/motion-ui/ui-theme";

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
      <div className="max-w-[80%] rounded-lg border border-border bg-muted/40 px-3 py-2">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Wrench className="size-3" />
          <span>Ferramenta</span>
        </div>
        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">
          {shown}
        </pre>
        {isLong && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="mt-1 text-xs text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground"
          >
            {expanded ? "Mostrar menos" : "Mostrar tudo"}
          </button>
        )}
      </div>
    </motion.div>
  );
}
