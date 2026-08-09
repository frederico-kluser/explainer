"use client";

import { motion } from "motion/react";
import { useMotionUITransition } from "@/components/motion-ui/ui-theme";
import { BUBBLE_MAX_WIDTH } from "@/components/ui/mobile-content";

export interface ChatBubbleProps {
  role: "user" | "assistant";
  content: string;
  timestamp?: string;
}

function renderContent(content: string) {
  return content.split("\n\n").map((paragraph, i) => (
    <p key={i} className={`whitespace-pre-wrap ${i > 0 ? "mt-2" : ""}`}>
      {paragraph}
    </p>
  ));
}

/** ISO 8601 in, "14:32" out. Returns null for anything unparseable. */
function formatClock(timestamp: string): string | null {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function ChatBubble({ role, content, timestamp }: ChatBubbleProps) {
  const transition = useMotionUITransition("gentle");

  const isUser = role === "user";
  const clock = timestamp ? formatClock(timestamp) : null;

  return (
    <motion.div
      // Who said it, in the DOM: the transcript is the only place a test can
      // check that the model actually spoke, rather than that some text merely
      // appeared on the page.
      data-role={role}
      className={`flex flex-col ${isUser ? "items-end" : "items-start"}`}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={transition}
    >
      {/* Bigger type inside smaller padding on a phone, and the two pay for
          each other: 15px is where a spoken answer stops being squinted at, and
          the 8px trimmed off each side is most of what the extra line-length
          costs. Both go back to the desktop figures at `md`. */}
      <motion.div
        className={`${BUBBLE_MAX_WIDTH} px-3 py-2.5 text-[0.9375rem] leading-relaxed md:px-4 md:py-3 md:text-sm ${
          isUser
            ? "bg-primary text-primary-foreground rounded-2xl rounded-br-sm"
            : "bg-secondary text-secondary-foreground rounded-2xl rounded-bl-sm"
        }`}
        layout
      >
        {renderContent(content)}
      </motion.div>
      {clock && (
        <time
          dateTime={timestamp}
          title={new Date(timestamp!).toLocaleString("pt-BR")}
          className="mt-1 px-1 text-[11px] text-muted-foreground md:text-xs"
        >
          {clock}
        </time>
      )}
    </motion.div>
  );
}
