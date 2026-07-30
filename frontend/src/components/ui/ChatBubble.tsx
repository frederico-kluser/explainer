"use client";

import { motion } from "motion/react";
import { useMotionUITransition } from "@/components/motion-ui/ui-theme";

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
      className={`flex flex-col ${isUser ? "items-end" : "items-start"}`}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={transition}
    >
      <motion.div
        className={`max-w-[80%] px-4 py-3 text-sm leading-relaxed ${
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
          className="mt-1 px-1 text-xs text-muted-foreground"
        >
          {clock}
        </time>
      )}
    </motion.div>
  );
}
