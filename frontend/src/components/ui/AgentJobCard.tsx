"use client";

import { motion } from "motion/react";
import { Bot, Loader, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { useMotionUITransition } from "@/components/motion-ui/ui-theme";
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
        "rounded-lg border px-3 py-2 text-xs",
        running
          ? "border-primary/40 bg-primary/5"
          : job.status === "done"
            ? "border-border bg-muted/30"
            : "border-destructive/40 bg-destructive/5",
      )}
    >
      <div className="flex items-center gap-2">
        {running ? (
          <Loader className="size-3.5 shrink-0 animate-spin text-primary" />
        ) : (
          <Bot className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="flex-1 truncate font-medium text-foreground">
          Agente pi — {job.activity || job.status}
        </span>
        {running && (
          <button
            type="button"
            onClick={() => onCancel(job.id)}
            className="shrink-0 text-muted-foreground hover:text-foreground"
            aria-label="Cancelar agente"
            title="Cancelar agente"
          >
            <X className="size-3.5" />
          </button>
        )}
        {job.cost_usd !== undefined && (
          <span className="shrink-0 tabular-nums text-muted-foreground">
            ${job.cost_usd.toFixed(4)}
          </span>
        )}
      </div>

      {job.error && <p className="mt-1 text-destructive">{job.error}</p>}
    </motion.div>
  );
}
