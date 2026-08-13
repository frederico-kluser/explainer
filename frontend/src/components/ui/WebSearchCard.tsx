"use client";

import { motion } from "motion/react";
import { Globe, Loader } from "lucide-react";

import { cn } from "@/lib/utils";
import { useMotionUITransition } from "@/components/motion-ui/ui-theme";
import type { WebSearchJob } from "@/types";

export interface WebSearchCardProps {
  job: WebSearchJob;
}

/**
 * A background web search, while it runs.
 *
 * The model does not wait for it — it says "vou pesquisar" and keeps talking —
 * so this card is where the user sees that the search is still in flight, and
 * `activity` is what turns a silent wait into a phase name ("pesquisando").
 * Same shape and state vocabulary as `AgentJobCard`; a search has no thinkers
 * fan, so there is nothing else to show in the middle.
 *
 * No `onCancel`, like `DeepThinkCard`: `POST /api/agents/:jobId/cancel`
 * resolves the id through the pi job registry, so a search's id 404s there.
 */
export function WebSearchCard({ job }: WebSearchCardProps) {
  const transition = useMotionUITransition("gentle");
  const running = job.status === "running";

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={transition}
      data-role="web-search"
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
          <Globe className="mt-0.5 size-3.5 shrink-0 text-muted-foreground md:mt-0" />
        )}
        {/* Wrapped rather than truncated on a phone, the same call `AgentJobCard`
            makes: after "Busca web — " an ellipsis at 360px leaves about two
            words of the phase. */}
        <span className="line-clamp-2 min-w-0 flex-1 font-medium text-foreground md:line-clamp-none md:truncate">
          Busca web — {job.activity || job.status}
        </span>
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
