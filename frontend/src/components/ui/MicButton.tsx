"use client";

import { motion, AnimatePresence } from "motion/react";
import { Mic, MicOff, Loader } from "lucide-react";
import { useMotionUITransition } from "@/components/motion-ui/ui-theme";

export type MicButtonState = "idle" | "recording" | "processing";

export interface MicButtonProps {
  onStart: () => void;
  onStop: () => void;
  state: MicButtonState;
}

const tooltips: Record<MicButtonState, string> = {
  idle: "Clique para gravar",
  recording: "Gravando...",
  processing: "Processando...",
};

export function MicButton({ onStart, onStop, state }: MicButtonProps) {
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
      title={tooltips[state]}
      aria-label={tooltips[state]}
      disabled={isDisabled}
      onClick={handleClick}
      className={`relative inline-flex items-center justify-center rounded-full size-14 transition-colors ${
        state === "recording"
          ? "bg-destructive text-destructive-foreground ring-4 ring-destructive/30"
          : "bg-primary text-primary-foreground"
      } ${isDisabled ? "cursor-not-allowed opacity-70" : "cursor-pointer"}`}
      whileHover={!isDisabled ? { scale: 1.05 } : undefined}
      whileTap={!isDisabled ? { scale: 0.95 } : undefined}
      transition={snap}
    >
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
            className="animate-pulse"
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
            className="animate-spin"
          >
            <Loader className="size-6" />
          </motion.span>
        )}
      </AnimatePresence>
    </motion.button>
  );
}
