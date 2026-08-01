"use client";

import { motion, AnimatePresence } from "motion/react";
import { Loader, Mic, PhoneOff, Volume2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useMotionUITransition } from "@/components/motion-ui/ui-theme";

/**
 * The one control of a realtime conversation.
 *
 * There is nothing to press and hold any more: the session is either open or it
 * is not, and the model decides when a turn ended. So the button is a call
 * button, and its animation is the only signal of who currently has the floor.
 */
export type MicButtonState =
  | "idle"
  | "connecting"
  | "listening"
  | "hearing"
  | "speaking";

export interface MicButtonProps {
  state: MicButtonState;
  onConnect: () => void;
  onDisconnect: () => void;
  disabled?: boolean;
}

const labels: Record<MicButtonState, string> = {
  idle: "Conectar e conversar",
  connecting: "Conectando...",
  listening: "Ao vivo — pode falar",
  hearing: "Ouvindo você",
  speaking: "Falando — pode interromper",
};

export function MicButton({
  state,
  onConnect,
  onDisconnect,
  disabled = false,
}: MicButtonProps) {
  const snap = useMotionUITransition("snap");
  const live = state !== "idle" && state !== "connecting";

  return (
    <div className="flex flex-col items-center gap-2">
      <motion.button
        type="button"
        title={labels[state]}
        aria-label={labels[state]}
        disabled={disabled || state === "connecting"}
        onClick={() => (live ? onDisconnect() : onConnect())}
        className={cn(
          "relative inline-flex size-16 items-center justify-center rounded-full",
          live
            ? "bg-destructive text-destructive-foreground"
            : "bg-primary text-primary-foreground",
          disabled || state === "connecting"
            ? "cursor-not-allowed opacity-70"
            : "cursor-pointer",
        )}
        whileHover={!disabled ? { scale: 1.05 } : undefined}
        whileTap={!disabled ? { scale: 0.95 } : undefined}
        transition={snap}
      >
        {/* Who has the floor: the user's ring is tight and fast, the model's is
            wide and slow. Two rings, no text needed. */}
        {state === "hearing" && (
          <motion.span
            className="pointer-events-none absolute inset-0 rounded-full ring-2 ring-emerald-400/70"
            animate={{ scale: [1, 1.35], opacity: [0.9, 0] }}
            transition={{ repeat: Infinity, duration: 0.9, ease: "easeOut" }}
          />
        )}
        {state === "speaking" && (
          <>
            <motion.span
              className="pointer-events-none absolute inset-0 rounded-full ring-2 ring-primary/50"
              animate={{ scale: [1, 1.8], opacity: [0.8, 0] }}
              transition={{ repeat: Infinity, duration: 1.6, ease: "easeOut" }}
            />
            <motion.span
              className="pointer-events-none absolute inset-0 rounded-full ring-2 ring-primary/30"
              animate={{ scale: [1, 1.8], opacity: [0.8, 0] }}
              transition={{
                repeat: Infinity,
                duration: 1.6,
                delay: 0.8,
                ease: "easeOut",
              }}
            />
          </>
        )}
        {state === "connecting" && (
          <motion.span
            className="pointer-events-none absolute inset-0 rounded-full ring-2 ring-primary/30"
            animate={{ scale: [1, 1.5], opacity: [0.7, 0] }}
            transition={{ repeat: Infinity, duration: 1.2, ease: "easeOut" }}
          />
        )}

        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={state}
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            transition={snap}
          >
            {state === "idle" && <Mic className="size-7" />}
            {state === "connecting" && <Loader className="size-7 animate-spin" />}
            {state === "listening" && <PhoneOff className="size-7" />}
            {state === "hearing" && <Mic className="size-7" />}
            {state === "speaking" && <Volume2 className="size-7" />}
          </motion.span>
        </AnimatePresence>
      </motion.button>

      <span className="text-xs text-muted-foreground">{labels[state]}</span>
    </div>
  );
}
