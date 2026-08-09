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

/**
 * What each state is called.
 *
 * Below `md` the caption is not rendered, so these strings survive only as the
 * button's `title` and `aria-label`: on a phone this map is the entire textual
 * account of what the call is doing. A state missing from it would leave a
 * screen reader announcing an unlabelled button.
 */
export const MIC_BUTTON_LABELS: Record<MicButtonState, string> = {
  idle: "Conectar e conversar",
  connecting: "Conectando...",
  listening: "Ao vivo — pode falar",
  hearing: "Ouvindo você",
  speaking: "Falando — pode interromper",
};

/** The call button's own box: 64px, well past the 44px a finger needs. */
export const MIC_BUTTON_TARGET =
  "relative inline-flex size-16 items-center justify-center rounded-full";

/**
 * The caption under the button.
 *
 * Stacked under a 64px circle it makes the bottom bar ~92px tall, and on a
 * phone that is a fifth of the transcript spent restating what the two rings
 * already show. Hidden below `md` rather than dropped: at `md` and up the
 * caption is the only place the session state is written down, and the
 * `aria-label` carries it either way.
 */
export const MIC_CAPTION_CLASS = "hidden text-xs text-muted-foreground md:block";

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
        title={MIC_BUTTON_LABELS[state]}
        aria-label={MIC_BUTTON_LABELS[state]}
        disabled={disabled || state === "connecting"}
        onClick={() => (live ? onDisconnect() : onConnect())}
        className={cn(
          MIC_BUTTON_TARGET,
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

      <span className={MIC_CAPTION_CLASS}>{MIC_BUTTON_LABELS[state]}</span>
    </div>
  );
}
