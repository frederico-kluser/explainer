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
import { TAP_ROW, TAP_TARGET_RAIL } from "@/components/ui/mobile-content";
import type { DeepThinkJob, ThinkerResult, ThinkerStatus } from "@/types";

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

  // Collected rather than rendered inline, because the row prints them in two
  // different places depending on the width and a list is cheaper to move than
  // two conditional spans.
  const meta: string[] = [];
  if (thinker.searches !== undefined && thinker.searches > 0) {
    meta.push(
      `${thinker.searches} ${thinker.searches === 1 ? "busca" : "buscas"}`,
    );
  }
  if (thinker.usd !== undefined) meta.push(`$${thinker.usd.toFixed(4)}`);

  return (
    <motion.li
      initial={{ opacity: 0, x: -4 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ ...transition, delay: index * stagger }}
      className="border-t border-border/60 first:border-t-0"
    >
      {/* Two rows on a phone, one on the rail. The angle is what tells the user
          which of the ten is stuck, and sharing its row with a search count, a
          cost and a chevron left it about twenty characters at 360px — the round
          became readable only once it was over, which is the opposite of what
          this list is for. Below `md` the meta moves under the angle and the
          angle gets the width. */}
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        disabled={!expandable}
        className={cn(
          TAP_ROW,
          "flex w-full flex-col items-stretch gap-0.5 py-1.5 text-left md:flex-row md:items-center md:gap-1.5 md:py-1",
          expandable ? "cursor-pointer" : "cursor-default",
        )}
      >
        <span className="flex min-w-0 items-start gap-1.5 md:flex-1 md:items-center">
          <ThinkerIcon status={thinker.status} />
          <span
            className={cn(
              "min-w-0 flex-1 md:truncate",
              thinker.status === "pending"
                ? "text-muted-foreground"
                : "text-foreground",
            )}
          >
            {thinker.angle}
          </span>
          {/* On a phone the chevron closes the first row, so the finger has one
              target for the whole line rather than a 12px glyph at the end of a
              second one. The rail keeps it last, after the numbers. */}
          {expandable && (
            <ChevronDown
              className={cn(
                "mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform md:hidden",
                open && "rotate-180",
              )}
            />
          )}
        </span>

        {/* 18px is the icon's 12 plus the row's 6, so the numbers line up under
            the angle rather than under the status dot. */}
        {meta.length > 0 && (
          <span className="flex shrink-0 gap-2 pl-[18px] text-muted-foreground md:gap-1.5 md:pl-0">
            {meta.map((item) => (
              <span key={item} className="tabular-nums">
                {item}
              </span>
            ))}
          </span>
        )}

        {expandable && (
          <ChevronDown
            className={cn(
              "hidden size-3 shrink-0 text-muted-foreground transition-transform md:block",
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
                      part of the answer the user can go and check, so on a phone
                      they get a row a thumb can land on rather than a 10px glyph
                      and a line of underlined text. */}
                  <a
                    href={citation.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    title={citation.snippet}
                    className={cn(
                      TAP_ROW,
                      "flex max-w-full items-center gap-1.5 text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground md:gap-1",
                    )}
                  >
                    <ExternalLink className="size-3 shrink-0 md:size-2.5" />
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
          <Brain className="mt-0.5 size-3.5 shrink-0 text-muted-foreground md:mt-0" />
        )}
        {/* `activity` names the phase the round is in — "pesquisando",
            "sintetizando" — and it is what makes a card that runs for minutes
            worth looking at twice. Truncated after "Pensamento profundo — " it
            never survives a phone. */}
        <span className="line-clamp-2 min-w-0 flex-1 font-medium text-foreground md:line-clamp-none md:truncate">
          Pensamento profundo — {job.activity || job.status}
        </span>
        {running && onCancel && (
          <button
            type="button"
            onClick={() => onCancel(job.id)}
            className={cn(TAP_TARGET_RAIL, "-my-2 md:my-0")}
            aria-label="Cancelar pensamento profundo"
            title="Cancelar pensamento profundo"
          >
            <X className="size-4 md:size-3.5" />
          </button>
        )}
        {job.cost_usd !== undefined && (
          <span className="hidden shrink-0 tabular-nums text-muted-foreground md:inline">
            ${job.cost_usd.toFixed(4)}
          </span>
        )}
      </div>

      {job.thinkers.length > 0 && (
        <>
          <p className="mt-1 pl-[22px] text-muted-foreground md:pl-0">
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

      {/* The cost keeps its place on the rail's header row and takes a line of
          its own on a phone, where the header has a 44px cancel button on it. */}
      {job.cost_usd !== undefined && (
        <p className="mt-0.5 pl-[22px] tabular-nums text-muted-foreground md:hidden">
          ${job.cost_usd.toFixed(4)}
        </p>
      )}

      {job.synthesis && (
        <div className="mt-2 rounded-md border border-border bg-background/40 px-2 py-1.5">
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground md:text-[10px]">
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
