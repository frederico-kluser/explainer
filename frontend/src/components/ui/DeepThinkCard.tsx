"use client";

import { useState } from "react";
import { motion } from "motion/react";
import {
  AlertTriangle,
  Brain,
  Check,
  ChevronDown,
  Circle,
  ExternalLink,
  Loader,
  X,
} from "lucide-react";

import { cn } from "@/lib/utils";
import {
  useMotionUITheme,
  useMotionUITransition,
} from "@/components/motion-ui/ui-theme";
import type { DeepThinkJob, ThinkerResult, ThinkerStatus } from "./contracts";

export interface DeepThinkCardProps {
  job: DeepThinkJob;
  /** Omitted, the card shows no way to stop the round. */
  onCancel?: (jobId: string) => void;
}

/** One icon per thinker state, so a ten-row list is scannable without reading. */
function ThinkerIcon({ status }: { status: ThinkerStatus }) {
  if (status === "running") {
    return <Loader className="size-3 shrink-0 animate-spin text-primary" />;
  }
  if (status === "done") {
    return <Check className="size-3 shrink-0 text-foreground" />;
  }
  if (status === "error") {
    return <AlertTriangle className="size-3 shrink-0 text-destructive" />;
  }
  return <Circle className="size-3 shrink-0 text-muted-foreground/50" />;
}

/**
 * One thinker: its angle always, its reasoning and sources on demand.
 *
 * Collapsed by default because ten expanded thinkers is a wall of prose over a
 * card that has to stay readable while the round is still running.
 */
function ThinkerRow({
  thinker,
  index,
  stagger,
}: {
  thinker: ThinkerResult;
  index: number;
  stagger: number;
}) {
  const transition = useMotionUITransition("snap");
  const [open, setOpen] = useState(false);

  const expandable = Boolean(
    thinker.thinking || thinker.error || thinker.citations?.length,
  );

  return (
    <motion.li
      initial={{ opacity: 0, x: -4 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ ...transition, delay: index * stagger }}
      className="border-t border-border/60 first:border-t-0"
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        disabled={!expandable}
        className={cn(
          "flex w-full items-center gap-1.5 py-1 text-left",
          expandable ? "cursor-pointer" : "cursor-default",
        )}
      >
        <ThinkerIcon status={thinker.status} />
        <span
          className={cn(
            "flex-1 truncate",
            thinker.status === "pending"
              ? "text-muted-foreground"
              : "text-foreground",
          )}
        >
          {thinker.angle}
        </span>
        {thinker.searches !== undefined && thinker.searches > 0 && (
          <span className="shrink-0 tabular-nums text-muted-foreground">
            {thinker.searches} {thinker.searches === 1 ? "busca" : "buscas"}
          </span>
        )}
        {thinker.usd !== undefined && (
          <span className="shrink-0 tabular-nums text-muted-foreground">
            ${thinker.usd.toFixed(4)}
          </span>
        )}
        {expandable && (
          <ChevronDown
            className={cn(
              "size-3 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-180",
            )}
          />
        )}
      </button>

      {open && (
        <div className="space-y-1.5 pb-2 pl-[18px]">
          {thinker.error && <p className="text-destructive">{thinker.error}</p>}
          {thinker.thinking && (
            <p className="whitespace-pre-wrap break-words leading-snug text-muted-foreground">
              {thinker.thinking}
            </p>
          )}
          {thinker.citations && thinker.citations.length > 0 && (
            <ul className="space-y-0.5">
              {thinker.citations.map((citation) => (
                <li key={citation.url}>
                  {/* The pages this thinker actually opened. They are the only
                      part of the answer the user can go and check. */}
                  <a
                    href={citation.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    title={citation.snippet}
                    className="inline-flex max-w-full items-center gap-1 text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground"
                  >
                    <ExternalLink className="size-2.5 shrink-0" />
                    <span className="truncate">{citation.title}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </motion.li>
  );
}

/**
 * A deep-think round, while it thinks.
 *
 * Same shape and the same state vocabulary as `AgentJobCard` — a round is
 * another thing the voice model starts and does not wait for — but a round
 * fans out to as many as ten thinkers and can run for minutes, so what happens
 * in the middle has to be readable, not only the answer at the end. That is
 * what the per-thinker list and the "N de M" counter are for: `activity` is one
 * sentence, and one sentence cannot say which angle is stuck.
 */
export function DeepThinkCard({ job, onCancel }: DeepThinkCardProps) {
  const transition = useMotionUITransition("gentle");
  const { stagger } = useMotionUITheme();
  const running = job.status === "running";

  const done = job.thinkers.filter((t) => t.status === "done").length;
  const failed = job.thinkers.filter((t) => t.status === "error").length;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={transition}
      data-role="deep-think"
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
          <Brain className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="flex-1 truncate font-medium text-foreground">
          Pensamento profundo — {job.activity || job.status}
        </span>
        {running && onCancel && (
          <button
            type="button"
            onClick={() => onCancel(job.id)}
            className="shrink-0 text-muted-foreground hover:text-foreground"
            aria-label="Cancelar pensamento profundo"
            title="Cancelar pensamento profundo"
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

      {job.thinkers.length > 0 && (
        <>
          <p className="mt-1 text-muted-foreground">
            {done} de {job.thinkers.length}{" "}
            {job.thinkers.length === 1 ? "pensador pronto" : "pensadores prontos"}
            {failed > 0 &&
              ` · ${failed} ${failed === 1 ? "falhou" : "falharam"}`}
          </p>
          <ul className="mt-1">
            {job.thinkers.map((thinker, index) => (
              <ThinkerRow
                key={thinker.id}
                thinker={thinker}
                index={index}
                stagger={stagger.tight}
              />
            ))}
          </ul>
        </>
      )}

      {job.synthesis && (
        <div className="mt-2 rounded-md border border-border bg-background/40 px-2 py-1.5">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Síntese
          </p>
          <p className="mt-0.5 whitespace-pre-wrap break-words leading-snug text-foreground">
            {job.synthesis}
          </p>
        </div>
      )}

      {job.error && <p className="mt-1 text-destructive">{job.error}</p>}
    </motion.div>
  );
}
