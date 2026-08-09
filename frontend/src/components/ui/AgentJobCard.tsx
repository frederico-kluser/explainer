"use client";

import { motion } from "motion/react";
import { Bot, Loader, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { useMotionUITransition } from "@/components/motion-ui/ui-theme";
import { TAP_TARGET_RAIL } from "@/components/ui/mobile-content";
import type { AgentJob } from "@/types";

export interface AgentJobCardProps {
  job: AgentJob;
  onCancel: (jobId: string) => void;
}

/**
 * A dispatched `pi` agent, while it works.
 *
 * The model does not wait for it — it says "mandei um agente" and keeps
 * talking — so this card is the only place the user can see that something is
 * still running, what it is doing, and how to stop it.
 */
export function AgentJobCard({ job, onCancel }: AgentJobCardProps) {
  const transition = useMotionUITransition("gentle");
  const running = job.status === "running";

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={transition}
      className={cn(
        "rounded-lg border px-3 py-2 text-[13px] md:text-xs",
        running
          ? "border-primary/40 bg-primary/5"
          : job.status === "done"
            ? "border-border bg-muted/30"
            : "border-destructive/40 bg-destructive/5",
      )}
    >
      <div className="flex items-start gap-2 md:items-center">
        {running ? (
          <Loader className="mt-0.5 size-3.5 shrink-0 animate-spin text-primary md:mt-0" />
        ) : (
          <Bot className="mt-0.5 size-3.5 shrink-0 text-muted-foreground md:mt-0" />
        )}
        {/* Wrapped rather than truncated on a phone. `activity` is the point of
            the card — it is the only place the user learns what the agent is
            doing — and after "Agente pi — " an ellipsis at 360px leaves about two
            words of it. Two lines is the ceiling; a third would push the next
            card off a drawer that only shows two thirds of a screen. */}
        <span className="line-clamp-2 min-w-0 flex-1 font-medium text-foreground md:line-clamp-none md:truncate">
          Agente pi — {job.activity || job.status}
        </span>
        {running && (
          <button
            type="button"
            onClick={() => onCancel(job.id)}
            className={cn(TAP_TARGET_RAIL, "-my-2 md:my-0")}
            aria-label="Cancelar agente"
            title="Cancelar agente"
          >
            <X className="size-4 md:size-3.5" />
          </button>
        )}
        {/* The cost keeps its place on the rail's one row and moves to a line of
            its own on a phone: eight characters of tabular numerals beside a
            44px button leave the activity about twenty, which is the shape of
            the bug this card is being fixed for. */}
        {job.cost_usd !== undefined && (
          <span className="hidden shrink-0 tabular-nums text-muted-foreground md:inline">
            ${job.cost_usd.toFixed(4)}
          </span>
        )}
      </div>

      {job.cost_usd !== undefined && (
        <p className="mt-0.5 pl-[22px] tabular-nums text-muted-foreground md:hidden">
          ${job.cost_usd.toFixed(4)}
        </p>
      )}

      {job.error && <p className="mt-1 text-destructive">{job.error}</p>}
    </motion.div>
  );
}
