"use client";

import { motion } from "motion/react";
import { Mic } from "lucide-react";

import { useMotionUITransition } from "@/components/motion-ui/ui-theme";
import { ToolTrace } from "@/components/ui/ToolTrace";
import { CopyButton } from "@/components/ui/CopyButton";
import { Button } from "@/components/ui/button";
import type { ReactEvent } from "@/types";

export interface ChatResponseProps {
  directAnswer: string | null;
  reactEvents: ReactEvent[];
  error: string | null;
  isSending: boolean;
  /** When true, show a card suggesting the user start a voice session. */
  showVoiceHint: boolean;
  /** Called when the user clicks the voice suggestion button. */
  onConnectVoice: () => void;
  /** When false, the "Conectar voz" button is disabled because no materials
   * are loaded — mirrors the guard on MicButton. */
  canConnectVoice?: boolean;
}

function DirectAnswerCard({ answer }: { answer: string }) {
  const transition = useMotionUITransition("gentle");

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={transition}
      className="rounded-lg border border-border bg-card p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
          {answer}
        </p>
        <CopyButton text={answer} />
      </div>
    </motion.div>
  );
}

function ErrorCard({ message }: { message: string }) {
  const transition = useMotionUITransition("gentle");

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={transition}
      className="rounded-lg border border-destructive/40 bg-destructive/5 p-4"
    >
      <p className="text-sm text-destructive">{message}</p>
    </motion.div>
  );
}

function VoiceHintCard({
  onConnect,
  disabled,
}: {
  onConnect: () => void;
  disabled?: boolean;
}) {
  const transition = useMotionUITransition("gentle");

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={transition}
      className="rounded-lg border border-primary/30 bg-primary/5 p-4"
    >
      <p className="mb-3 text-sm text-foreground">
        Essa parece ser uma conversa. Que tal iniciar uma sessao de voz?
      </p>
      <Button onClick={onConnect} size="sm" disabled={disabled}>
        <Mic className="mr-1.5 size-4" />
        Conectar voz
      </Button>
    </motion.div>
  );
}

function AnswerCard({ answer }: { answer: string }) {
  const transition = useMotionUITransition("gentle");

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={transition}
      className="rounded-lg border border-border bg-card p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
          {answer}
        </p>
        <CopyButton text={answer} />
      </div>
    </motion.div>
  );
}

/**
 * Renders the standalone chat response area below the transcript.
 *
 * Handles four states:
 * - Direct answer (single-response card with copy button)
 * - ReAct stream (tool events + final answer with copy button)
 * - Error (red-bordered card)
 * - Voice hint (suggestion to start a voice session)
 */
export function ChatResponse({
  directAnswer,
  reactEvents,
  error,
  isSending,
  showVoiceHint,
  onConnectVoice,
  canConnectVoice = true,
}: ChatResponseProps) {
  if (error) {
    return <ErrorCard message={error} />;
  }

  if (showVoiceHint) {
    return (
      <VoiceHintCard
        onConnect={onConnectVoice}
        disabled={!canConnectVoice}
      />
    );
  }

  if (directAnswer) {
    return <DirectAnswerCard answer={directAnswer} />;
  }

  const toolEvents = reactEvents.filter(
    (e) => e.type === "tool_call" || e.type === "tool_result",
  );
  const answerEvents = reactEvents.filter((e) => e.type === "answer");
  const finalAnswer = answerEvents.map((e) => e.data).join("\n");

  if (toolEvents.length > 0 || finalAnswer) {
    return (
      <div className="space-y-3">
        {toolEvents.map((event, i) => (
          <ToolTrace key={i} content={event.data} />
        ))}
        {finalAnswer && <AnswerCard answer={finalAnswer} />}
        {isSending && !finalAnswer && (
          <p className="text-xs text-muted-foreground">Pensando...</p>
        )}
      </div>
    );
  }

  if (isSending) {
    return <p className="text-xs text-muted-foreground">Enviando...</p>;
  }

  return null;
}
