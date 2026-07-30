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
    <p key={i} className={i > 0 ? "mt-2" : ""}>
      {paragraph}
    </p>
  ));
}

export function ChatBubble({ role, content, timestamp }: ChatBubbleProps) {
  const transition = useMotionUITransition("gentle");

  const isUser = role === "user";

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
      {timestamp && (
        <span className="mt-1 px-1 text-xs text-muted-foreground">
          {timestamp}
        </span>
      )}
    </motion.div>
  );
}
