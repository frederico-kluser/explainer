import { spawn, type ChildProcessByStdio } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Readable } from "node:stream";
import { v4 as uuidv4 } from "uuid";

import { addCost } from "./costs.js";
import type { AgentJob } from "../types/index.js";

// ---------------------------------------------------------------------------
// Why this exists
// ---------------------------------------------------------------------------
//
// A `pi` coding agent takes tens of seconds to answer a real question about a
// repository. A realtime voice conversation cannot wait that long: the model
// gets a `function_call_output` in milliseconds ("dispatched, job N") and keeps
// talking, and the actual answer is injected into the conversation later, when
// it lands. This module owns that background half.
//
// The agent runs with a read-only tool allowlist. It is pointed at repositories
// the user did not necessarily write, so it gets no shell and no writes.

/** Read at spawn time, not at import time, so the binary can be repointed
 * without restarting the server. */
function piBin(): string {
  return process.env.PI_BIN || "pi";
}
const READ_ONLY_TOOLS = "read,glob,grep,find,ls";
const DEFAULT_TIMEOUT_MS = Number(process.env.PI_TIMEOUT_MS) || 180_000;
// The question is the model's own phrasing and the whole point of the run, so
// it must not be the casualty when the context section grows; 8 000 characters
// is a ceiling, not a target — a spoken question is a few hundred.
const MAX_PROMPT_CHARS = 8_000;
/**
 * How much of the context section may carry, in characters.
 *
 * The server now attaches the conversation block automatically; 6 000 leaves
 * the model's own `context` argument room on top of the ~3 000-character block
 * without letting the prompt grow without bound. Billed once per run, not per
 * response, so generosity here is cheap.
 */
export const MAX_CONTEXT_CHARS = 6_000;
const MAX_RESULT_CHARS = 12_000;
const MAX_JOBS_RETAINED = 100;

export type AgentJobEvent =
  | { type: "activity"; job_id: string; activity: string }
  | { type: "done"; job_id: string; result: string; cost_usd?: number }
  | { type: "error"; job_id: string; error: string };

const bus = new EventEmitter();
// Many SSE clients may follow the same job; the default cap of 10 is too low.
bus.setMaxListeners(0);

const jobs = new Map<string, AgentJob>();
type PiProcess = ChildProcessByStdio<null, Readable, Readable>;
const processes = new Map<string, PiProcess>();

export class AgentJobError extends Error {
  public readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "AgentJobError";
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getJob(id: string): AgentJob | undefined {
  return jobs.get(id);
}

export function listJobs(conversationId: string): AgentJob[] {
  return [...jobs.values()].filter((j) => j.conversation_id === conversationId);
}

export function subscribe(
  listener: (event: AgentJobEvent) => void,
): () => void {
  bus.on("event", listener);
  return () => bus.off("event", listener);
}

export function cancelJob(id: string): boolean {
  const child = processes.get(id);
  const job = jobs.get(id);
  if (!child || !job || job.status !== "running") return false;

  child.kill("SIGTERM");
  finish(job, { status: "cancelled", error: "Cancelado pelo usuario." });
  return true;
}

export interface DispatchOptions {
  conversationId: string;
  prompt: string;
  cwd: string;
  /** Extra context prepended to the prompt, e.g. what the user is asking about. */
  context?: string;
  timeoutMs?: number;
}

/**
 * Start a `pi` run and return immediately.
 *
 * The caller gets a job whose `status` is `running`; progress and the final
 * answer arrive on the event bus.
 */
export function dispatchAgentJob(options: DispatchOptions): AgentJob {
  const { conversationId, cwd } = options;

  const running = listJobs(conversationId).find((j) => j.status === "running");
  if (running) {
    throw new AgentJobError(
      `Ja existe um agente rodando nesta conversa (job ${running.id}). ` +
        "Espere ele terminar ou cancele antes de disparar outro.",
      409,
    );
  }

  const prompt = buildPrompt(options);
  const job: AgentJob = {
    id: uuidv4(),
    conversation_id: conversationId,
    prompt,
    cwd,
    status: "running",
    activity: "iniciando o agente",
    started_at: new Date().toISOString(),
  };

  jobs.set(job.id, job);
  pruneJobs();
  spawnPi(job, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  return job;
}

// ---------------------------------------------------------------------------
// Process handling
// ---------------------------------------------------------------------------

function buildPrompt({ prompt, context }: DispatchOptions): string {
  const question = prompt.trim().slice(0, MAX_PROMPT_CHARS);
  const preamble =
    "Voce esta respondendo a uma pergunta feita por voz. Investigue o repositorio " +
    "deste diretorio usando suas ferramentas de leitura e responda em portugues do " +
    "Brasil, em texto corrido, sem markdown, no maximo dois paragrafos curtos. " +
    "Cite caminhos de arquivo quando ajudar.";

  // The conversation block and the model's own context share the same cap: the
  // block arrives already bounded, but the model's `context` argument is its
  // own words and can be long.
  const contextText = context?.trim().slice(0, MAX_CONTEXT_CHARS);

  return contextText
    ? `${preamble}\n\nContexto: ${contextText}\n\nPergunta: ${question}`
    : `${preamble}\n\nPergunta: ${question}`;
}

function spawnPi(job: AgentJob, timeoutMs: number): void {
  const args = [
    "-p",
    "--mode",
    "json",
    "--no-session",
    "--no-approve", // never trust extensions/skills shipped inside a cloned repo
    "-t",
    READ_ONLY_TOOLS,
  ];

  if (process.env.PI_PROVIDER) args.push("--provider", process.env.PI_PROVIDER);
  if (process.env.PI_MODEL) args.push("--model", process.env.PI_MODEL);
  if (process.env.PI_THINKING) args.push("--thinking", process.env.PI_THINKING);

  args.push(job.prompt);

  let child: PiProcess;
  try {
    child = spawn(piBin(), args, {
      cwd: job.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    finish(job, {
      status: "error",
      error: `Nao foi possivel iniciar o pi: ${errText(err)}`,
    });
    return;
  }

  processes.set(job.id, child);

  const timer = setTimeout(() => {
    if (job.status !== "running") return;
    child.kill("SIGKILL");
    finish(job, {
      status: "error",
      error: `O agente passou de ${Math.round(timeoutMs / 1000)}s e foi interrompido.`,
    });
  }, timeoutMs);

  let stdoutBuffer = "";
  let stderrTail = "";
  let answer = "";
  let cost: number | undefined;

  child.stdout.setEncoding("utf-8");
  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split("\n");
    // The final element is a partial line until the next chunk arrives.
    stdoutBuffer = lines.pop() ?? "";

    for (const line of lines) {
      const event = parseLine(line);
      if (!event) continue;

      const activity = activityFor(event);
      if (activity && activity !== job.activity) {
        job.activity = activity;
        emit({ type: "activity", job_id: job.id, activity });
      }

      const text = finalAnswer(event);
      if (text) answer = text;

      const eventCost = totalCost(event);
      if (eventCost !== undefined) cost = eventCost;
    }
  });

  child.stderr.setEncoding("utf-8");
  child.stderr.on("data", (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-2000);
  });

  child.on("error", (err) => {
    clearTimeout(timer);
    const message =
      (err as NodeJS.ErrnoException).code === "ENOENT"
        ? "O CLI `pi` nao esta instalado ou nao esta no PATH (npm i -g @mariozechner/pi-coding-agent)."
        : errText(err);
    finish(job, { status: "error", error: message });
  });

  child.on("close", (code) => {
    clearTimeout(timer);
    processes.delete(job.id);
    if (job.status !== "running") return; // already timed out or cancelled

    if (answer.trim()) {
      finish(job, {
        status: "done",
        result: forSpeech(answer).slice(0, MAX_RESULT_CHARS),
        ...(cost !== undefined ? { cost_usd: cost } : {}),
      });
      return;
    }

    finish(job, {
      status: "error",
      error:
        code === 0
          ? "O agente terminou sem produzir uma resposta."
          : `O agente saiu com codigo ${code}. ${stderrTail.trim().slice(-400)}`,
    });
  });
}

function finish(
  job: AgentJob,
  outcome: { status: AgentJob["status"]; result?: string; error?: string; cost_usd?: number },
): void {
  job.status = outcome.status;
  job.finished_at = new Date().toISOString();
  if (outcome.result !== undefined) job.result = outcome.result;
  if (outcome.error !== undefined) job.error = outcome.error;
  if (outcome.cost_usd !== undefined) job.cost_usd = outcome.cost_usd;
  job.activity = outcome.status === "done" ? "concluido" : (outcome.error ?? job.activity);
  processes.delete(job.id);

  if (job.cost_usd !== undefined && job.cost_usd > 0) {
    void addCost(job.conversation_id, {
      source: "pi_agent",
      usd: job.cost_usd,
      detail: job.prompt.slice(-160),
    });
  }

  if (outcome.status === "done") {
    emit({
      type: "done",
      job_id: job.id,
      result: job.result ?? "",
      ...(job.cost_usd !== undefined ? { cost_usd: job.cost_usd } : {}),
    });
  } else {
    emit({ type: "error", job_id: job.id, error: job.error ?? "Falha desconhecida." });
  }
}

function emit(event: AgentJobEvent): void {
  bus.emit("event", event);
}

// ---------------------------------------------------------------------------
// pi JSONL parsing
// ---------------------------------------------------------------------------
//
// `pi --mode json` emits one JSON object per line. Only a few of them matter
// here, and the shape of the rest changes between versions — so everything is
// read defensively and an unknown event is simply ignored.

interface PiMessage {
  role?: string;
  content?: Array<{ type?: string; text?: string }>;
  usage?: { cost?: { total?: number } };
}

interface PiEvent {
  type?: string;
  message?: PiMessage;
  messages?: PiMessage[];
  assistantMessageEvent?: { type?: string; toolName?: string };
  toolResults?: unknown[];
}

function parseLine(line: string): PiEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return JSON.parse(trimmed) as PiEvent;
  } catch {
    return null;
  }
}

function activityFor(event: PiEvent): string | null {
  switch (event.type) {
    case "agent_start":
      return "lendo o repositorio";
    case "turn_start":
      return "analisando";
    case "turn_end":
      return "finalizando";
    case "agent_end":
      return "concluido";
    case "message_update": {
      const inner = event.assistantMessageEvent?.type ?? "";
      if (inner.startsWith("toolCall") || inner.startsWith("tool_call")) {
        const tool = event.assistantMessageEvent?.toolName;
        return tool ? `usando a ferramenta ${tool}` : "usando ferramentas";
      }
      if (inner.startsWith("thinking")) return "raciocinando";
      if (inner.startsWith("text")) return "escrevendo a resposta";
      return null;
    }
    default:
      return null;
  }
}

function finalAnswer(event: PiEvent): string | null {
  const messages =
    event.type === "agent_end"
      ? event.messages
      : event.type === "turn_end" && event.message
        ? [event.message]
        : undefined;
  if (!messages) return null;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "assistant") continue;
    const text = (message.content ?? [])
      .filter((part) => part.type === "text" && part.text)
      .map((part) => part.text as string)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return null;
}

function totalCost(event: PiEvent): number | undefined {
  // Depending on the event, usage hangs off the single message (`message_end`,
  // `turn_end`) or off the last assistant message in the batch (`agent_end`).
  const direct = event.message?.usage?.cost?.total;
  if (typeof direct === "number") return direct;

  for (let i = (event.messages?.length ?? 0) - 1; i >= 0; i--) {
    const cost = event.messages?.[i]?.usage?.cost?.total;
    if (typeof cost === "number") return cost;
  }
  return undefined;
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

/**
 * The answer is going to be re-narrated by a voice model. Backticks, asterisks
 * and heading marks survive the hand-off and get read out as noise, so they are
 * stripped here rather than hoped away in a prompt.
 */
function forSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[`*_#>]/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
