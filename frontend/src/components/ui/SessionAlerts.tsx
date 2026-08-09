"use client";

import { motion } from "motion/react";
import { Download, MicOff, PhoneOff, Volume2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { useMotionUITransition } from "@/components/motion-ui/ui-theme";
import { Button, buttonVariants } from "@/components/ui/button";
import { sessionAlert } from "@/components/ui/mobile-shell";
import { CERTIFICATE_URL, type MicrophoneFailure } from "@/hooks/useRealtimeSession";

export interface SessionAlertsProps {
  micFailure: MicrophoneFailure | null;
  /** The hook's own sentence about the microphone. Written where the failure is
   *  classified, so it is not restated here. */
  micMessage: string | null;
  audioBlocked: boolean;
  callDropped: boolean;
  /** Opens the call again. `connect()` clears all three flags on its way in. */
  onRetry: () => void;
  /** Must run inside the tap: WebKit only starts audio from a real gesture. */
  onPlayAudio: () => void;
}

const CALL_DROPPED_MESSAGE =
  "A chamada caiu enquanto o aparelho estava em espera. Toque para voltar.";

const AUDIO_BLOCKED_MESSAGE =
  "O navegador segurou o áudio desta página. Toque para ouvir a resposta.";

const MICROPHONE_FALLBACK =
  "Não consegui abrir o microfone. Toque em conectar de novo.";

/**
 * The three session states a toast cannot carry.
 *
 * A toast is five seconds and one line. The certificate message is four
 * sentences and ends in a path the user has to visit, which on a phone means a
 * link they can tap, not a string they retype from memory — so these render as
 * a panel that stays until the problem is gone.
 *
 * Which of them is on screen, and what its button does, is decided by
 * `sessionAlert` against the failure kind. Never against the wording: the copy
 * below is copy, and the day it is rewritten nothing here should change.
 */
export function SessionAlerts({
  micFailure,
  micMessage,
  audioBlocked,
  callDropped,
  onRetry,
  onPlayAudio,
}: SessionAlertsProps) {
  const transition = useMotionUITransition("gentle");
  const alert = sessionAlert({ micFailure, audioBlocked, callDropped });
  if (!alert) return null;

  const message =
    alert.kind === "microphone"
      ? (micMessage ?? MICROPHONE_FALLBACK)
      : alert.kind === "call-dropped"
        ? CALL_DROPPED_MESSAGE
        : AUDIO_BLOCKED_MESSAGE;

  return (
    <motion.div
      role="alert"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={transition}
      className="mx-auto mb-3 max-w-3xl rounded-xl border border-border bg-card p-3"
    >
      <div className="flex items-start gap-2.5">
        {alert.kind === "call-dropped" ? (
          <PhoneOff className="mt-0.5 size-4 shrink-0 text-destructive" />
        ) : alert.kind === "audio-blocked" ? (
          <Volume2 className="mt-0.5 size-4 shrink-0 text-primary" />
        ) : (
          <MicOff className="mt-0.5 size-4 shrink-0 text-destructive" />
        )}
        <p className="min-w-0 flex-1 text-xs leading-relaxed text-foreground">
          {message}
        </p>
      </div>

      {alert.action !== "none" && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {alert.action === "certificate" && (
            <>
              <a
                href={CERTIFICATE_URL}
                download
                className={cn(buttonVariants(), "h-11 px-4 text-sm")}
              >
                <Download className="mr-1.5 size-4" />
                Baixar o certificado
              </a>
              {/* Installing it does not change `isSecureContext` for a document
                  that is already open, so the page has to be loaded again. */}
              <Button
                variant="outline"
                className="h-11 px-4 text-sm"
                onClick={() => window.location.reload()}
              >
                Recarregar a página
              </Button>
            </>
          )}

          {alert.action === "retry" && (
            <Button className="h-11 px-4 text-sm" onClick={onRetry}>
              Tentar de novo
            </Button>
          )}

          {alert.action === "play" && (
            <Button className="h-11 px-4 text-sm" onClick={onPlayAudio}>
              <Volume2 className="mr-1.5 size-4" />
              Tocar áudio
            </Button>
          )}
        </div>
      )}
    </motion.div>
  );
}
