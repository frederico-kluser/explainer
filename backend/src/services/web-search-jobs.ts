import { EventEmitter } from "node:events";
import { v4 as uuidv4 } from "uuid";

import { executeWebSearch } from "../tools/web-search.js";
import type { WebSearchEvent, WebSearchJob } from "../types/deep-tools.js";

// ---------------------------------------------------------------------------
// Why this exists
// ---------------------------------------------------------------------------
//
// A web search takes up to 45 seconds on the OpenAI path plus another 30 on the
// surf fallback. A realtime voice conversation cannot hold that open: the model
// gets a `function_call_output` in milliseconds ("search dispatched") and keeps
// talking, and the actual answer is injected into the conversation later, when
// it lands. This module owns that background half — the same shape as
// `agent-jobs.ts` and `deep-think.ts`, for the same reason.
//
// The search itself (`executeWebSearch`) already books its own cost through
// `addCost(source: "web_search")`, so this module never touches the ledger; it
// only mirrors the number onto the `web_search_done` event for the UI.

const DEFAULT_TIMEOUT_MS = 180_000;
// The worst legitimate case is 45 s on OpenAI plus 30 s on the surf fallback —
// 75 s total. A shorter timeout would kill the job inside the fallback, which
// is why this is not the 45 s the search call itself uses.
const MAX_JOBS_RETAINED = 50;

const bus = new EventEmitter();
// Many SSE clients may follow the same job; the default cap of 10 is too low.
bus.setMaxListeners(0);

const jobs = new Map<string, WebSearchJob>();
// Budget timers of the running searches, so `finish` can disarm them. Cancel
// finishes a job without settling the search, so `runSearch`'s finally never
// runs on that path — the one path where the timer would otherwise stay armed
// for the whole remaining budget, holding the job closure and the event loop.
const timers = new Map<string, NodeJS.Timeout>();

export class WebSearchJobError extends Error {
  public readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "WebSearchJobError";
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getWebSearchJob(id: string): WebSearchJob | undefined {
  return jobs.get(id);
}

export function listWebSearchJobs(conversationId: string): WebSearchJob[] {
  return [...jobs.values()].filter((j) => j.conversation_id === conversationId);
}

export function subscribeWebSearch(
  listener: (event: WebSearchEvent) => void,
): () => void {
  bus.on("event", listener);
  return () => bus.off("event", listener);
}

export function cancelWebSearch(id: string): boolean {
  const job = jobs.get(id);
  if (!job || job.status !== "running") return false;

  // No child process to kill: the search is a promise already in flight.
  // Marking the job cancelled is what makes the background run discard its own
  // late arrival — `finish` and the stage checks refuse to touch a job that is
  // no longer `running`.
  finish(job, { status: "cancelled", error: "Cancelado pelo usuario." });
  return true;
}

export interface WebSearchOptions {
  conversationId: string;
  /** The query, as the voice model phrased it. */
  query: string;
  /**
   * The conversation block from `research-context.ts`, so the synthesis model
   * answers against what was just said instead of from the query alone.
   */
  context?: string;
  /** Injected so a job can be exercised without waiting 180 s. */
  timeoutMs?: number;
}

/**
 * Start a web search and return immediately.
 *
 * The caller gets a job whose `status` is `running`; progress and the final
 * answer arrive on the event bus.
 */
export function dispatchWebSearch(options: WebSearchOptions): WebSearchJob {
  const { conversationId } = options;

  const running = listWebSearchJobs(conversationId).find((j) => j.status === "running");
  if (running) {
    throw new WebSearchJobError(
      `Ja existe uma busca em andamento nesta conversa (job ${running.id}). ` +
        "Espere ela terminar ou cancele antes de disparar outra.",
      409,
    );
  }

  const job: WebSearchJob = {
    id: uuidv4(),
    conversation_id: conversationId,
    query: options.query.trim(),
    status: "running",
    activity: "buscando na web",
    started_at: new Date().toISOString(),
  };

  jobs.set(job.id, job);
  pruneJobs();
  void runSearch(job, options);

  return job;
}

// ---------------------------------------------------------------------------
// The search
// ---------------------------------------------------------------------------

async function runSearch(job: WebSearchJob, options: WebSearchOptions): Promise<void> {
  const budget = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => {
    if (job.status !== "running") return;
    finish(job, {
      status: "error",
      error: `A busca passou de ${Math.round(budget / 1000)}s e foi interrompida.`,
    });
  }, budget);
  timers.set(job.id, timer);

  try {
    setActivity(job, "buscando na web");
    const { text, cost_usd } = await executeWebSearch(
      job.query,
      job.conversation_id,
      undefined,
      options.context,
    );
    if (job.status !== "running") return; // cancelled or timed out while searching

    setActivity(job, "formatando os resultados");
    finish(job, { status: "done", result: text, ...(cost_usd !== undefined ? { cost_usd } : {}) });
  } catch (err) {
    if (job.status !== "running") return;
    finish(job, { status: "error", error: `A busca falhou: ${errText(err)}` });
  } finally {
    clearTimeout(timer);
    timers.delete(job.id);
  }
}

// ---------------------------------------------------------------------------
// Completion and the bus
// ---------------------------------------------------------------------------

function finish(
  job: WebSearchJob,
  outcome: {
    status: WebSearchJob["status"];
    result?: string;
    error?: string;
    cost_usd?: number;
  },
): void {
  // The cancelled and timeout paths race the background search; whoever gets
  // here first wins, and the late arrival is dropped instead of overwriting
  // the job with a result nobody asked for.
  if (job.status !== "running") return;

  // Disarm the budget timer on every terminal transition, not only in
  // `runSearch`'s finally: cancel finishes the job without settling the
  // search, and the timeout path fires from inside the timer itself.
  // clearTimeout on an already-fired timer is a no-op, so the double cleanup
  // is safe.
  const timer = timers.get(job.id);
  if (timer) {
    clearTimeout(timer);
    timers.delete(job.id);
  }

  job.status = outcome.status;
  job.finished_at = new Date().toISOString();
  if (outcome.result !== undefined) job.result = outcome.result;
  if (outcome.error !== undefined) job.error = outcome.error;
  if (outcome.cost_usd !== undefined) job.cost_usd = outcome.cost_usd;
  job.activity = outcome.status === "done" ? "concluido" : (outcome.error ?? job.activity);

  if (outcome.status === "done") {
    emit({
      type: "web_search_done",
      job_id: job.id,
      result: job.result ?? "",
      ...(job.cost_usd !== undefined ? { cost_usd: job.cost_usd } : {}),
    });
    return;
  }

  emit({
    type: "web_search_error",
    job_id: job.id,
    error: job.error ?? "Falha desconhecida na busca.",
  });
}

function setActivity(job: WebSearchJob, activity: string): void {
  if (job.status !== "running") return;
  job.activity = activity;
  emit({ type: "web_search_activity", job_id: job.id, activity });
}

function emit(event: WebSearchEvent): void {
  bus.emit("event", event);
}

function pruneJobs(): void {
  if (jobs.size <= MAX_JOBS_RETAINED) return;
  const finished = [...jobs.values()]
    .filter((j) => j.status !== "running")
    .sort((a, b) => a.started_at.localeCompare(b.started_at));
  for (const job of finished.slice(0, jobs.size - MAX_JOBS_RETAINED)) {
    jobs.delete(job.id);
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
