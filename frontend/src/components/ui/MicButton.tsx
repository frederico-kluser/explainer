"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Mic, MicOff, Loader } from "lucide-react";
import { cn } from "@/lib/utils";
import { useMotionUITransition } from "@/components/motion-ui/ui-theme";

export type MicButtonState = "idle" | "recording" | "processing";

export interface MicButtonProps {
  onStart: () => void;
  onStop: () => void;
  state: MicButtonState;
}

const labels: Record<MicButtonState, string> = {
  idle: "Clique para gravar",
  recording: "Gravando... clique para parar",
  processing: "Processando...",
};

export function MicButton({ onStart, onStop, state }: MicButtonProps) {
  const [hovered, setHovered] = useState(false);
  const snap = useMotionUITransition("snap");

  const handleClick = () => {
    if (state === "idle") {
      onStart();
    } else if (state === "recording") {
      onStop();
    }
  };

  const isDisabled = state === "processing";

  return (
    <motion.button
      type="button"
      title={labels[state]}
      aria-label={labels[state]}
      disabled={isDisabled}
      onClick={handleClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={cn(
        "relative inline-flex items-center justify-center rounded-full size-14",
        state === "recording"
          ? "bg-destructive text-destructive-foreground"
          : "bg-primary text-primary-foreground",
        isDisabled ? "cursor-not-allowed opacity-70" : "cursor-pointer"
      )}
      whileHover={!isDisabled ? { scale: 1.05 } : undefined}
      whileTap={!isDisabled ? { scale: 0.95 } : undefined}
      transition={snap}
    >
      {/* Idle pulse ring on hover */}
      {state === "idle" && (
        <motion.span
          className="pointer-events-none absolute inset-0 rounded-full ring-2 ring-primary/40"
          animate={
            hovered
              ? { scale: [1, 1.5], opacity: [0.7, 0] }
              : { scale: 1, opacity: 0 }
          }
          transition={
            hovered
              ? { repeat: Infinity, duration: 1.2, ease: "easeOut" }
              : { duration: 0.25 }
          }
        />
      )}

      {/* Recording pulse rings (continuous) */}
      {state === "recording" && (
        <>
          <motion.span
            className="pointer-events-none absolute inset-0 rounded-full ring-2 ring-destructive/50"
            animate={{ scale: [1, 1.8], opacity: [0.8, 0] }}
            transition={{
              repeat: Infinity,
              duration: 1.5,
              ease: "easeOut",
            }}
          />
          <motion.span
            className="pointer-events-none absolute inset-0 rounded-full ring-2 ring-destructive/30"
            animate={{ scale: [1, 1.8], opacity: [0.8, 0] }}
            transition={{
              repeat: Infinity,
              duration: 1.5,
              delay: 0.75,
              ease: "easeOut",
            }}
          />
        </>
      )}

      {/* Icon */}
      <AnimatePresence mode="wait" initial={false}>
        {state === "idle" && (
          <motion.span
            key="idle"
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            transition={snap}
          >
            <Mic className="size-6" />
          </motion.span>
        )}
        {state === "recording" && (
          <motion.span
            key="recording"
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            transition={snap}
          >
            <MicOff className="size-6" />
          </motion.span>
        )}
        {state === "processing" && (
          <motion.span
            key="processing"
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            transition={snap}
          >
            <Loader className="size-6 animate-spin" />
          </motion.span>
        )}
      </AnimatePresence>
    </motion.button>
  );
}
