import { EventEmitter } from "node:events";
import { v4 as uuidv4 } from "uuid";

import { braveSearch } from "./brave.js";
import { addCost } from "./costs.js";
import { priceTextResponse, ratesFor } from "./pricing.js";
import { adapterFor } from "./providers/index.js";
import { providerKeyPresent } from "./providers/keys.js";
import type { ChatResponse, ToolCall, ToolSpec, Turn } from "./providers/types.js";
import { getRoster } from "./thinker-roster.js";
import type {
  ModelChoice,
  ThinkerProvider,
  ThinkerRoster,
  ThinkerSlot,
} from "../types/thinker-roster.js";
import {
  MAX_THINKERS,
  type BraveResult,
  type DeepThinkEvent,
  type DeepThinkJob,
  type SearchFn,
  type ThinkerResult,
  type ThinkerSpec,
} from "../types/deep-tools.js";

// ---------------------------------------------------------------------------
// Why this exists
// ---------------------------------------------------------------------------
//
// One model answering once is one point of view. This module fans a scenario out
// to up to ten thinkers, each reasoning under a *different* angle and each able
// to read the live web, and then hands every trace to a single synthesiser.
//
// Two findings shaped the design and are worth keeping when this is edited:
//
//   - The fan-out only pays for itself if the prompts differ. Multi-agent debate
//     beats single-model self-consistency because the agents argue divergent
//     positions (Du et al., "Improving Factuality and Reasoning in Language
//     Models with Multiagent Debate"); ten copies of one prompt just buy the
//     same answer ten times. That is what the planner stage is for.
//   - The synthesiser reads the *whole* reasoning trace, not a vote. Aggregating
//     by majority has a ceiling an LLM aggregator over full traces gets past —
//     "Beyond Consensus: Trace-Level Synthesis in Mixture of Agents"
//     (arXiv 2605.29116). So thinkers hand over their reasoning, not a verdict.
//
// Asynchronous for the same reason `agent-jobs.ts` is: a round takes tens of
// seconds to minutes, and a spoken conversation cannot hold that. `dispatch`
// returns a `running` job in milliseconds; everything else arrives on the bus.

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Read at call time, not at import, so a running server can be repointed. */
function envNumber(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function defaultThinkerCount(): number {
  return envNumber("DEEP_THINK_THINKERS", 4);
}

/**
 * Not a CPU limit. Brave's free plan accepts roughly one request per second, so
 * ten thinkers searching at once collect 429s instead of sources.
 */
function thinkerConcurrency(): number {
  return envNumber("DEEP_THINK_CONCURRENCY", 3);
}

/** Searches one thinker may spend. The loop enforces it, not the prompt. */
function searchBudget(): number {
  return envNumber("DEEP_THINK_MAX_SEARCHES", 3);
}

function roundTimeoutMs(): number {
  return envNumber("DEEP_THINK_TIMEOUT_MS", 180_000);
}

const MAX_SCENARIO_CHARS = 4_000;
const MAX_REFLECTION_CHARS = 4_000;
// The conversation block rides every stage of the round — planner, each thinker
// and the synthesiser — so each character is billed once per stage, not once.
// The caps above stay put for the same reason: a spoken scenario rarely reaches
// a thousand characters, so the headroom would be paid for on every call.
// 4 000 is a backstop for callers that pass a raw string; the block from
// research-context.ts is already capped below it, so its marker-based
// truncation always survives untouched.
const MAX_CONTEXT_CHARS = 4_000;
/** How much of one thinker's trace reaches the synthesiser's prompt. */
const MAX_TRACE_CHARS = 3_000;
const MAX_SYNTHESIS_CHARS = 12_000;
const MAX_JOBS_RETAINED = 50;
const SEARCH_RESULTS_PER_CALL = 5;
/** How much of a search failure fits in a status line meant to be spoken. */
const MAX_WEB_REASON_CHARS = 120;
/** Below these, a match against a thinker's prose is a coincidence, not a citation. */
const MIN_HOST_LABEL_CHARS = 4;
const MIN_TITLE_MATCH_CHARS = 8;
const PLANNER_TIMEOUT_MS = 45_000;
const THINKER_TIMEOUT_MS = 90_000;
const SYNTHESIS_TIMEOUT_MS = 90_000;

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const bus = new EventEmitter();
// Many SSE clients may follow the same round; the default cap of 10 is too low.
bus.setMaxListeners(0);

const jobs = new Map<string, DeepThinkJob>();

interface Round {
  controller: AbortController;
  timer: NodeJS.Timeout;
  /**
   * Money the API has already been paid, mirrored here as each call is answered.
   *
   * Not summed from what the thinkers return: a cancel or a timeout unwinds a
   * thinker through its exception path, and everything it had already paid for
   * would be discarded along with the stack. The provider charges for the calls
   * it completed, whether or not anyone was still listening for the answer.
   */
  spent: { usd: number };
  /**
   * Searches that never reached the web.
   *
   * `DeepThinkJob` is a frozen contract with no field for a degraded search and
   * this module cannot widen it, so the failure is kept here and surfaced
   * through the two channels the contract does have: the activity line the SSE
   * stream carries, and the server log.
   */
  web: { failures: number; reason: string };
}
const rounds = new Map<string, Round>();

export class DeepThinkError extends Error {
  public readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "DeepThinkError";
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getDeepThinkJob(id: string): DeepThinkJob | undefined {
  return jobs.get(id);
}

export function listDeepThinkJobs(conversationId: string): DeepThinkJob[] {
  return [...jobs.values()].filter((j) => j.conversation_id === conversationId);
}

export function subscribeDeepThink(
  listener: (event: DeepThinkEvent) => void,
): () => void {
  bus.on("event", listener);
  return () => bus.off("event", listener);
}

export function cancelDeepThink(id: string): boolean {
  const job = jobs.get(id);
  const round = rounds.get(id);
  if (!job || !round || job.status !== "running") return false;

  round.controller.abort();
  finish(job, { status: "cancelled", error: "Cancelado pelo usuario." });
  return true;
}

export interface DeepThinkOptions {
  conversationId: string;
  /** The question or scenario, as the voice model phrased it. */
  scenario: string;
  /** What the user has already concluded, so the thinkers argue with it. */
  reflection?: string;
  /**
   * The conversation block from `research-context.ts`, so the thinkers know
   * what was just said instead of reasoning from the scenario alone.
   */
  context?: string;
  /** Clamped into 1..MAX_THINKERS; omitted, DEEP_THINK_THINKERS decides. */
  thinkerCount?: number;
  /** Injected so a round can be exercised without the network. */
  searchFn?: SearchFn;
  timeoutMs?: number;
}

/**
 * Start a deep-think round and return immediately.
 *
 * The job comes back `running` with its thinkers already listed as `pending`, so
 * the UI can draw the fan-out before the planner has named the angles. Progress
 * and the synthesis arrive on the event bus.
 *
 * The roster is read on this path — not on the first model call — because both
 * the fan-out's ceiling and its pending cards depend on it. A machine with no
 * roster file gets `defaultRoster()`, which reproduces what this module did
 * before the roster existed, model for model.
 */
export async function dispatchDeepThink(options: DeepThinkOptions): Promise<DeepThinkJob> {
  const { conversationId } = options;
  const scenario = (options.scenario ?? "").trim();
  if (!scenario) {
    throw new DeepThinkError("Preciso de um cenario para pensar a respeito.", 400);
  }

  // Ten thinkers plus a synthesiser is real money. A second concurrent round in
  // the same conversation doubles the bill without anyone asking for it.
  const running = listDeepThinkJobs(conversationId).find((j) => j.status === "running");
  if (running) {
    throw new DeepThinkError(
      `Ja existe uma rodada de pensamento profundo nesta conversa (job ${running.id}). ` +
        "Espere ela terminar ou cancele antes de disparar outra.",
      409,
    );
  }

  const roster = await getRoster();
  const enabledSlots = roster.slots.filter((slot) => slot.enabled);
  if (enabledSlots.length === 0) {
    throw new DeepThinkError("Nenhum pensador habilitado no roster.", 400);
  }

  const requested = clampThinkerCount(options.thinkerCount ?? defaultThinkerCount());
  // The user's number is a ceiling, and so is the roster: a round cannot fan
  // out to a slot that is switched off.
  const count = Math.min(enabledSlots.length, requested);

  const job: DeepThinkJob = {
    id: uuidv4(),
    conversation_id: conversationId,
    scenario: scenario.slice(0, MAX_SCENARIO_CHARS),
    status: "running",
    activity: "planejando os angulos",
    // Seeded with the deterministic angles so the count is observable now; the
    // planner overwrites the labels in place once it answers.
    thinkers: fallbackSpecs(count).map(toPending),
    started_at: new Date().toISOString(),
  };

  jobs.set(job.id, job);
  pruneJobs();
  void runRound(job, options, count, roster, enabledSlots);

  return job;
}

/** Clamped rather than rejected: a voice model saying "uns vinte" is not an error. */
function clampThinkerCount(requested: number): number {
  if (!Number.isFinite(requested)) return 1;
  return Math.min(MAX_THINKERS, Math.max(1, Math.floor(requested)));
}

// ---------------------------------------------------------------------------
// The round
// ---------------------------------------------------------------------------

async function runRound(
  job: DeepThinkJob,
  options: DeepThinkOptions,
  count: number,
  roster: ThinkerRoster,
  enabledSlots: ThinkerSlot[],
): Promise<void> {
  const controller = new AbortController();
  const budget = options.timeoutMs ?? roundTimeoutMs();
  const timer = setTimeout(() => {
    if (job.status !== "running") return;
    controller.abort();
    // Finish with what already exists: a partial answer beats a dead round in a
    // conversation that is still waiting out loud.
    finishOnTimeout(job, budget);
  }, budget);
  const round: Round = {
    controller,
    timer,
    spent: { usd: 0 },
    web: { failures: 0, reason: "" },
  };
  rounds.set(job.id, round);

  // Checked before the first call rather than after the last: an unpriced model
  // still runs and still charges, so the warning has to precede the spending.
  // One warning per model the round will actually call — planner, master and
  // every enabled slot — not just for the default one.
  for (const model of roundModels(roster, enabledSlots)) warnIfUnpriced(model);
  warnUnkeyedProviders(roster, enabledSlots);

  const reflection = (options.reflection ?? "").trim().slice(0, MAX_REFLECTION_CHARS);
  const context = (options.context ?? "").trim().slice(0, MAX_CONTEXT_CHARS);
  const search = options.searchFn ?? braveSearch;
  const signal = controller.signal;

  try {
    const planned = await plan(roster.planner, job.scenario, reflection, count, signal, context);
    round.spent.usd += planned.usd;
    if (job.status !== "running") return;

    // A slot's fixed angle overrides the planner's label for that thinker
    // alone: the operator's escape hatch wins over the planner's naming.
    const overridden = planned.specs.map((spec, index) => {
      const angle = enabledSlots[index]?.angle;
      return angle ? { ...spec, angle } : spec;
    });

    // Ids stay put so an event already delivered still points at the same card.
    job.thinkers = overridden.map((spec, index) => ({
      id: job.thinkers[index]?.id ?? spec.id,
      angle: spec.angle,
      status: "pending" as const,
    }));
    const specs = overridden.map((spec, index) => ({
      ...spec,
      id: job.thinkers[index]?.id ?? spec.id,
    }));
    setActivity(job, `pensando em ${specs.length} frentes`);

    const thinkerContext: ThinkerContext = { job, round, reflection, context, search, signal };

    await mapWithConcurrency(specs, thinkerConcurrency(), async (spec, index) => {
      const slot = job.thinkers[index];
      if (!slot || job.status !== "running") return;

      slot.status = "running";
      setActivity(job, `pensando: ${spec.angle}`);

      let outcome: Awaited<ReturnType<typeof think>>;
      try {
        outcome = await think(spec, thinkerContext, enabledSlots[index]!.model);
      } catch {
        // Only an abort escapes `think`; the round is already finishing, and
        // whatever this thinker paid for is on `round.spent` regardless.
        return;
      }
      if (job.status !== "running") return;

      Object.assign(slot, outcome);
      setActivity(job, `${doneCount(job)} de ${specs.length} pensadores prontos`);
    });

    if (job.status !== "running") return;

    const usable = job.thinkers.filter((t) => t.status === "done" && t.thinking);
    if (usable.length === 0) {
      finish(job, {
        status: "error",
        error:
          "Nenhum pensador conseguiu concluir. " +
          (job.thinkers.find((t) => t.error)?.error ?? "Sem detalhes."),
      });
      return;
    }

    setActivity(job, "sintetizando as conclusoes");
    const synthesised = await synthesise(roster.master, job, reflection, context, signal);
    round.spent.usd += synthesised.usd;
    if (job.status !== "running") return;

    finish(job, { status: "done", synthesis: synthesised.text });
  } catch (err) {
    if (job.status !== "running") return; // cancelled or timed out mid-flight
    finish(job, { status: "error", error: errText(err) });
  } finally {
    clearTimeout(timer);
    rounds.delete(job.id);
  }
}

function finishOnTimeout(job: DeepThinkJob, budget: number): void {
  const seconds = Math.round(budget / 1000);
  for (const thinker of job.thinkers) {
    if (thinker.status === "done" || thinker.status === "error") continue;
    thinker.status = "error";
    thinker.error = `Interrompido pelo limite de ${seconds}s da rodada.`;
  }

  const usable = job.thinkers.filter((t) => t.thinking);
  if (usable.length === 0) {
    finish(job, {
      status: "error",
      error: `A rodada passou de ${seconds}s e foi interrompida sem nenhum pensamento pronto.`,
    });
    return;
  }

  // No synthesiser call here on purpose: the round is out of time, so the answer
  // is assembled locally instead of spending another minute on a model.
  finish(job, {
    status: "done",
    synthesis: forSpeech(
      `A rodada passou de ${seconds} segundos, entao vale o que ficou pronto. ` +
        localSynthesis(usable),
    ),
  });
}

function doneCount(job: DeepThinkJob): number {
  return job.thinkers.filter((t) => t.status === "done" || t.status === "error").length;
}

// ---------------------------------------------------------------------------
// Stage 1 — the planner
// ---------------------------------------------------------------------------

/** The deterministic angles. Ten of them, so any clamped count is covered. */
const FALLBACK_ANGLES: Array<{ angle: string; brief: string }> = [
  { angle: "fatos e evidencias", brief: "Levante o que se sabe de concreto, com numeros e fontes, e separe o verificado do presumido." },
  { angle: "riscos e modos de falha", brief: "Liste como isso da errado na pratica, o que quebra primeiro e o que seria irreversivel." },
  { angle: "custo e esforco", brief: "Estime o que custa em dinheiro, tempo e atencao, incluindo o custo de manter depois de pronto." },
  { angle: "alternativas descartadas", brief: "Enumere os caminhos que ninguem esta considerando e diga por que cada um foi (ou deveria ser) descartado." },
  { angle: "quem discorda e por que", brief: "Assuma a posicao de quem e contra e faca o argumento mais forte possivel contra a ideia." },
  { angle: "se a premissa principal estiver errada", brief: "Identifique a premissa que sustenta tudo e descreva o que muda se ela for falsa." },
  { angle: "efeitos de segunda ordem", brief: "Olhe o que acontece depois da primeira consequencia: incentivos criados, habitos, precedentes." },
  { angle: "restricoes praticas e prazo", brief: "Foque no que limita na vida real: prazo, gente disponivel, dependencias, regras externas." },
  { angle: "o que dizem as fontes recentes", brief: "Procure na web o que mudou recentemente sobre o assunto e o que ja esta desatualizado." },
  { angle: "como saber se deu certo", brief: "Defina o sinal que provaria sucesso ou fracasso, e em quanto tempo ele apareceria." },
];

function fallbackSpecs(count: number): ThinkerSpec[] {
  return FALLBACK_ANGLES.slice(0, count).map((entry) => ({
    id: uuidv4(),
    angle: entry.angle,
    prompt: entry.brief,
  }));
}

function toPending(spec: ThinkerSpec): ThinkerResult {
  return { id: spec.id, angle: spec.angle, status: "pending" };
}

async function plan(
  choice: ModelChoice,
  scenario: string,
  reflection: string,
  count: number,
  signal: AbortSignal,
  context: string,
): Promise<{ specs: ThinkerSpec[]; usd: number }> {
  const instructions =
    `Voce esta organizando uma rodada de pensamento profundo com ${count} pensadores independentes.\n` +
    "Cada pensador recebe o MESMO cenario, mas um ANGULO diferente de ataque. Angulos repetidos ou " +
    "parecidos desperdicam a rodada inteira, entao facam-nos deliberadamente distintos entre si: " +
    "evidencia, risco, custo, contraposicao, premissa, consequencia, prazo, medicao.\n\n" +
    `Cenario: ${scenario}\n` +
    (context ? `Contexto da conversa: ${context}\n` : "") +
    (reflection ? `Reflexao de quem perguntou: ${reflection}\n` : "") +
    `\nResponda APENAS com um array JSON de ${count} objetos, sem texto em volta e sem markdown. ` +
    'Cada objeto tem exatamente duas chaves: "angle" (rotulo curto em portugues, no maximo tres ' +
    'palavras, minusculas) e "prompt" (uma a tres frases dizendo ao pensador o que investigar sob ' +
    "esse angulo, em portugues do Brasil).";

  try {
    const response = await respond(
      choice,
      [{ role: "user", content: instructions }],
      { maxOutputTokens: 1_200, timeoutMs: PLANNER_TIMEOUT_MS, signal },
    );
    const usd = priceOf(response);
    const specs = parsePlan(response.text, count);
    return { specs: specs ?? fallbackSpecs(count), usd };
  } catch (err) {
    if (isAbort(err)) throw err;
    // A round with generic angles is worth far more than no round at all.
    console.warn("[deep-think] planner failed, using the default angles:", errText(err));
    return { specs: fallbackSpecs(count), usd: 0 };
  }
}

/**
 * Parsed defensively rather than through a structured-output schema: the answer
 * only has to survive long enough to become prompts, and the fallback already
 * covers the failure. A rejected `text.format` would cost the whole round.
 */
function parsePlan(text: string, count: number): ThinkerSpec[] | null {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const specs: ThinkerSpec[] = [];
  const seen = new Set<string>();
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const angle = typeof record.angle === "string" ? record.angle.trim() : "";
    const prompt = typeof record.prompt === "string" ? record.prompt.trim() : "";
    if (!angle || !prompt) continue;
    if (seen.has(angle.toLowerCase())) continue; // duplicate angle = wasted thinker
    seen.add(angle.toLowerCase());
    specs.push({ id: uuidv4(), angle: angle.slice(0, 60), prompt: prompt.slice(0, 800) });
    if (specs.length === count) break;
  }
  if (specs.length === 0) return null;

  // Short answers are padded rather than shrinking the fan-out the caller asked for.
  for (const spare of fallbackSpecs(count)) {
    if (specs.length >= count) break;
    if (seen.has(spare.angle.toLowerCase())) continue;
    seen.add(spare.angle.toLowerCase());
    specs.push(spare);
  }
  return specs;
}

// ---------------------------------------------------------------------------
// Stage 2 — the thinkers
// ---------------------------------------------------------------------------

/**
 * The only tool a thinker gets.
 *
 * The schema makes every property required, which is why the result count is
 * decided here instead of being another field the model can inflate. The
 * Responses API's `strict` flag would enforce that, but the adapter contract
 * (`ToolSpec` in `providers/types.ts`) does not model it, so the wire no
 * longer carries it and `argOf` has to keep parsing defensively.
 */
const SEARCH_TOOL = {
  type: "function",
  name: "brave_search",
  description:
    "Busca na web e devolve titulos, links e trechos. Use para checar fatos, numeros e datas " +
    "que voce nao tem certeza, e cite o que abrir.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "A consulta, em poucas palavras, no idioma em que a resposta provavelmente existe.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  strict: true,
} as const;

/** Everything a thinker needs from the round it belongs to. */
interface ThinkerContext {
  job: DeepThinkJob;
  round: Round;
  reflection: string;
  context: string;
  search: SearchFn;
  signal: AbortSignal;
}

/** Running totals kept outside the loop so a throw still reports them. */
interface ThinkerTally {
  /** Searches that reached the web and came back. The cost ledger's number. */
  searches: number;
  /**
   * Every search attempt, answered or not. This is what the budget caps: Brave's
   * rate limit counts requests, and a request that 429s was still a request.
   */
  attempts: number;
  usd: number;
}

/**
 * Charge one answered model call.
 *
 * Written to the round's ledger at the moment the call is priced, not carried in
 * a local until the thinker returns, because the abort path never gets to
 * return — and a call the API answered is money already spent.
 */
function bill(round: Round, tally: ThinkerTally, usd: number): void {
  tally.usd += usd;
  round.spent.usd += usd;
}

/**
 * One thinker.
 *
 * Never throws for its own failure — it reports it. A thinker that blows up must
 * not take the round with it: the synthesiser works with whoever survived, which
 * is the whole point of running several.
 */
async function think(
  spec: ThinkerSpec,
  context: ThinkerContext,
  choice: ModelChoice,
): Promise<Partial<ThinkerResult>> {
  const tally: ThinkerTally = { searches: 0, attempts: 0, usd: 0 };
  try {
    return await runThinker(spec, context, choice, tally);
  } catch (err) {
    if (isAbort(err)) throw err; // the round is ending; not this thinker's fault
    return { status: "error", error: errText(err), searches: tally.searches, usd: tally.usd };
  }
}

async function runThinker(
  spec: ThinkerSpec,
  context: ThinkerContext,
  choice: ModelChoice,
  tally: ThinkerTally,
): Promise<Partial<ThinkerResult>> {
  const { job, round, reflection, context: conversationContext, search, signal } = context;
  const scenario = job.scenario;
  const budget = searchBudget();
  // What the searches returned. Which of these the thinker actually leaned on is
  // decided at the end, against the text it wrote — see `citedFrom`.
  const seen: BraveResult[] = [];
  let webNote = "";

  const turns: Turn[] = [
    {
      role: "user",
      content:
        `Voce e um dos varios pensadores olhando o MESMO cenario, cada um por um angulo diferente. ` +
        `O seu angulo e: ${spec.angle}.\n\n` +
        `Cenario: ${scenario}\n` +
        (conversationContext ? `Contexto da conversa: ${conversationContext}\n` : "") +
        (reflection ? `Reflexao de quem perguntou: ${reflection}\n` : "") +
        `\nSua tarefa sob esse angulo: ${spec.prompt}\n\n` +
        `Voce pode usar a ferramenta brave_search no maximo ${budget} vezes; use quando um fato, ` +
        "numero ou data importar, e diga de onde tirou nomeando o site ou o titulo da fonte — so " +
        "conta como fonte da resposta aquilo que voce citar pelo nome. Nao repita o que outro angulo diria: fique " +
        "no seu. Escreva em portugues do Brasil, em texto corrido, no maximo tres paragrafos, e " +
        "termine com a sua conclusao e o quanto voce confia nela.",
    },
  ];

  // One turn per search plus a turn to answer, and one of slack for a model that
  // spends a turn thinking without calling anything.
  const maxTurns = budget + 2;

  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await respond(choice, turns, {
      // A model that does not accept tools is called without them: it answers
      // on its first turn, losing the web but keeping its angle. That is the
      // projected degradation — the thinker is not switched off, only
      // unassisted.
      tools: choice.supports_tools === false ? [] : [SEARCH_TOOL],
      maxOutputTokens: 1_400,
      timeoutMs: THINKER_TIMEOUT_MS,
      signal,
    });
    bill(round, tally, priceOf(response));

    const calls = searchCalls(response.toolCalls);
    if (calls.length === 0) {
      const thinking = response.text.trim();
      if (!thinking) {
        return {
          status: "error",
          error: "O pensador terminou sem escrever nada.",
          searches: tally.searches,
          usd: tally.usd,
        };
      }
      return {
        status: "done",
        thinking: webNote ? `${thinking}\n\n${webNote}` : thinking,
        citations: citedFrom(seen, thinking),
        searches: tally.searches,
        usd: tally.usd,
      };
    }

    // Everything the model emitted rides forward on `raw` — dropping the
    // reasoning or the call item itself is the documented way to break the
    // next request.
    turns.push({
      role: "assistant",
      content: response.text,
      toolCalls: response.toolCalls,
      raw: response.raw,
    });

    for (const call of calls) {
      let output: string;
      // The budget is spent by attempting, not by succeeding — otherwise a
      // thinker whose searches all fail keeps hammering Brave for every
      // remaining turn. Enforced here, not in the prompt: a prompt is a
      // request, this is a cap.
      if (tally.attempts >= budget) {
        output = `Orcamento de ${budget} buscas esgotado. Conclua com o que ja tem.`;
      } else {
        tally.attempts += 1;
        try {
          const found = await search(argOf(call, "query"), { count: SEARCH_RESULTS_PER_CALL });
          // Counted only now: `searches` feeds the cost ledger, and a search
          // that 429'd, timed out or never found a key bought nothing.
          tally.searches += 1;
          seen.push(...found.results);
          output = renderResults(found.query, found.results, found.summary);
        } catch (err) {
          if (isAbort(err)) throw err;
          // A search outage degrades this thinker; it does not stop it thinking.
          const reason = errText(err);
          recordWebFailure(job, round, reason);
          webNote = "Observacao: a busca na web falhou nesta rodada, entao isto vale sem fontes novas.";
          output = `A busca falhou (${reason}). Siga raciocinando sem a web e diga que ficou sem fonte.`;
        }
      }
      turns.push({ role: "tool", toolCallId: call.id, content: output });
    }
  }

  return {
    status: "error",
    error: "O pensador ficou preso chamando ferramentas e nao concluiu.",
    searches: tally.searches,
    usd: tally.usd,
  };
}

/**
 * Record that a search never reached the web.
 *
 * Before this, the only trace of an unreachable Brave was a sentence inside the
 * thinker's own prose: the round still finished `done`, still charged, and
 * neither the UI nor the log could tell that the answer was written blind. The
 * round is the place it has to live, because a thinker that fails to search
 * still succeeds at thinking and its `error` field stays empty.
 */
function recordWebFailure(job: DeepThinkJob, round: Round, reason: string): void {
  round.web.failures += 1;
  if (round.web.reason) return;

  round.web.reason = reason.slice(0, MAX_WEB_REASON_CHARS);
  console.warn("[deep-think] web search unreachable, the round is running blind:", reason);
  setActivity(job, `a busca na web falhou (${round.web.reason}); seguindo sem fontes`);
}

/**
 * The sources the thinker actually leaned on, out of everything its searches
 * returned.
 *
 * The contract promises "every source the thinker actually opened". Handing it
 * the raw result list instead made a thinker that ignored the web arrive with
 * five citations, and three searches produced fifteen "sources" the UI then
 * showed the user as the sources behind the answer. Nothing in the Responses
 * protocol reports which result the model read, so the finished text is matched
 * against each result — by URL, by host, by the host's name or by title. A
 * source the thinker never named is dropped; one it named without opening is
 * indistinguishable from one it opened, and counting that one in is the honest
 * direction to err.
 */
function citedFrom(seen: BraveResult[], thinking: string): BraveResult[] {
  if (seen.length === 0) return [];

  const text = fold(thinking);
  const cited: BraveResult[] = [];
  for (const result of seen) {
    if (cited.some((already) => already.url === result.url)) continue;
    if (mentions(text, result)) cited.push(result);
  }
  return cited;
}

/** Case- and accent-insensitive, because a citation is prose, not an id. */
function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

function mentions(foldedText: string, result: BraveResult): boolean {
  if (result.url && foldedText.includes(fold(result.url))) return true;

  const host = hostOf(result.url);
  if (host && foldedText.includes(fold(host))) return true;

  // "segundo o G1", where the URL was g1.globo.com. Short labels are skipped:
  // a two-letter one matches by accident somewhere in three paragraphs.
  const label = host.split(".")[0] ?? "";
  if (label.length >= MIN_HOST_LABEL_CHARS && foldedText.includes(fold(label))) return true;

  const title = result.title.trim();
  return title.length >= MIN_TITLE_MATCH_CHARS && foldedText.includes(fold(title));
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function renderResults(query: string, results: BraveResult[], summary?: string): string {
  if (results.length === 0) {
    return `Busca "${query}": nenhum resultado.${summary ? `\nResumo: ${summary}` : ""}`;
  }
  const lines = results.map(
    (r, i) => `${i + 1}. ${r.title} — ${r.url}${r.age ? ` (${r.age})` : ""}\n   ${r.snippet}`,
  );
  return (
    `Busca "${query}":\n${lines.join("\n")}` + (summary ? `\nResumo da Brave: ${summary}` : "")
  );
}

// ---------------------------------------------------------------------------
// Stage 3 — the synthesiser
// ---------------------------------------------------------------------------

async function synthesise(
  choice: ModelChoice,
  job: DeepThinkJob,
  reflection: string,
  context: string,
  signal: AbortSignal,
): Promise<{ text: string; usd: number }> {
  const usable = job.thinkers.filter((t) => t.status === "done" && t.thinking);
  const traces = usable
    .map((t, i) => `Pensador ${i + 1} — angulo "${t.angle}":\n${t.thinking?.slice(0, MAX_TRACE_CHARS)}`)
    .join("\n\n---\n\n");
  const missing = job.thinkers.filter((t) => t.status === "error");

  const instructions =
    "Voce recebeu o raciocinio completo de varios pensadores que olharam o mesmo cenario por " +
    "angulos diferentes. Produza UMA resposta consolidada.\n\n" +
    `Cenario: ${job.scenario}\n` +
    (context ? `Contexto da conversa: ${context}\n` : "") +
    (reflection ? `Reflexao de quem perguntou: ${reflection}\n` : "") +
    (missing.length
      ? `\nAviso: ${missing.length} de ${job.thinkers.length} pensadores falharam; trabalhe com os que sobraram.\n`
      : "") +
    `\n${traces}\n\n` +
    "Regras da resposta:\n" +
    "- Diga onde os pensadores CONCORDARAM, onde DIVERGIRAM e qual e a CONCLUSAO.\n" +
    "- Quando houver divergencia real, diga qual lado tem o argumento mais forte e por que.\n" +
    "- ISTO SERA LIDO EM VOZ ALTA: texto corrido, sem markdown, sem listas com marcadores, sem " +
    "crases, sem titulos, sem numeracao. Nada de URL falada por extenso; cite a fonte pelo nome.\n" +
    "- Portugues do Brasil, no maximo seis frases.";

  try {
    const response = await respond(
      choice,
      [{ role: "user", content: instructions }],
      { maxOutputTokens: 1_000, timeoutMs: SYNTHESIS_TIMEOUT_MS, signal },
    );
    const text = forSpeech(response.text).slice(0, MAX_SYNTHESIS_CHARS);
    if (!text) return { text: forSpeech(localSynthesis(usable)), usd: priceOf(response) };
    return { text, usd: priceOf(response) };
  } catch (err) {
    if (isAbort(err)) throw err;
    // The thinking is already paid for; losing it to a failed last call would be
    // the most expensive way possible to return nothing.
    console.warn("[deep-think] synthesiser failed, assembling locally:", errText(err));
    return { text: forSpeech(localSynthesis(usable)), usd: 0 };
  }
}

/** Deterministic stand-in used when the synthesiser cannot run. */
function localSynthesis(thinkers: ThinkerResult[]): string {
  const parts = thinkers.map((t) => {
    const trace = (t.thinking ?? "").trim();
    const lastSentence = trace.split(/(?<=[.!?])\s+/).slice(-2).join(" ").trim();
    return `Pelo angulo ${t.angle}: ${lastSentence || trace.slice(0, 300)}`;
  });
  return (
    `Nao deu para consolidar com um sintetizador, entao segue o que cada frente concluiu. ` +
    parts.join(" ")
  );
}

// ---------------------------------------------------------------------------
// Completion and the bus
// ---------------------------------------------------------------------------

function finish(
  job: DeepThinkJob,
  outcome: {
    status: DeepThinkJob["status"];
    synthesis?: string;
    error?: string;
    cost_usd?: number;
  },
): void {
  if (job.status !== "running") return; // already cancelled, timed out or done

  const round = rounds.get(job.id);
  const usd = outcome.cost_usd ?? round?.spent.usd ?? 0;

  job.status = outcome.status;
  job.finished_at = new Date().toISOString();
  if (outcome.synthesis !== undefined) job.synthesis = outcome.synthesis;
  if (outcome.error !== undefined) job.error = outcome.error;
  if (usd > 0) job.cost_usd = usd;
  job.activity =
    outcome.status === "done" ? doneActivity(round) : (outcome.error ?? job.activity);

  if (round) {
    clearTimeout(round.timer);
    rounds.delete(job.id);
  }

  // Its own source, not `text`: a round is the most expensive thing the app can
  // do, and folded into the shared text bucket nobody could see it happen.
  if (job.cost_usd !== undefined && job.cost_usd > 0) {
    void addCost(job.conversation_id, {
      source: "deep_think",
      usd: job.cost_usd,
      detail: `deep_think: ${job.scenario.slice(0, 140)}`,
    });
  }

  if (outcome.status === "done") {
    emit({
      type: "deep_think_done",
      job_id: job.id,
      synthesis: job.synthesis ?? "",
      thinkers: snapshot(job.thinkers),
      ...(job.cost_usd !== undefined ? { cost_usd: job.cost_usd } : {}),
    });
    return;
  }

  emit({
    type: "deep_think_error",
    job_id: job.id,
    error: job.error ?? "Falha desconhecida na rodada.",
  });
}

/**
 * The closing status line, which doubles as the round's admission that it ran
 * without the web. A round that searched and got nothing is still a `done` round
 * with a `done` thinker, so "concluido" on its own would hide the degradation.
 */
function doneActivity(round?: Round): string {
  if (!round || round.web.failures === 0) return "concluido";
  const { failures, reason } = round.web;
  return `concluido sem web: ${failures} busca(s) falharam (${reason})`;
}

function setActivity(job: DeepThinkJob, activity: string): void {
  if (job.status !== "running") return;
  job.activity = activity;
  emit({
    type: "deep_think_activity",
    job_id: job.id,
    activity,
    thinkers: snapshot(job.thinkers),
  });
}

/** Copied, because an SSE client serialises the event after the next mutation. */
function snapshot(thinkers: ThinkerResult[]): ThinkerResult[] {
  return thinkers.map((t) => ({ ...t, ...(t.citations ? { citations: [...t.citations] } : {}) }));
}

function emit(event: DeepThinkEvent): void {
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

// ---------------------------------------------------------------------------
// Model calls, through the choice's adapter
// ---------------------------------------------------------------------------
//
// The wire protocol — flat tools on the Responses wire, `tool_calls` nested
// under `function` on the Chat wire, items or messages replayed verbatim — lives
// in `providers/openai-responses.ts` and `providers/openai-chat.ts`, which also
// resolve the key at call time and own the timeout and abort plumbing. What
// stays here is the carry-forward rule those protocols enforce: everything the
// model emitted must be replayed on the next request of the same exchange, so
// the round hands the adapter back its own items, untouched, on `Turn.raw`.
//
// Which adapter answers is the CHOICE's decision, never a constant: the choice
// carries both the provider and the model, and a model id alone does not say
// where it lives. Routing an OpenRouter model through the OpenAI adapter would
// send it to api.openai.com with an OpenAI key — a 401 the operator would read
// as a revoked key.

async function respond(
  choice: ModelChoice,
  turns: Turn[],
  options: {
    tools?: ToolSpec[];
    maxOutputTokens: number;
    timeoutMs: number;
    signal: AbortSignal;
  },
): Promise<ChatResponse> {
  const adapter = adapterFor(choice.provider);
  return adapter.chat({
    model: choice.model,
    turns,
    ...(options.tools?.length ? { tools: options.tools } : {}),
    // Absent means "send nothing", which is not the same as sending a default:
    // a non-reasoning model rejects the field outright.
    ...(choice.effort ? { effort: choice.effort } : {}),
    maxOutputTokens: options.maxOutputTokens,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

function searchCalls(calls: ToolCall[]): ToolCall[] {
  return calls.filter((call) => call.name === SEARCH_TOOL.name);
}

function argOf(call: ToolCall, key: string): string {
  try {
    const parsed = JSON.parse(call.arguments) as Record<string, unknown>;
    const value = parsed[key];
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

function priceOf(response: ChatResponse): number {
  const model = response.model;
  warnIfUnpriced(model);
  return priceTextResponse(model, response.usage);
}

/**
 * The models a round will actually call, deduplicated.
 *
 * Planner, master and every enabled slot — the fan-out is exactly those calls,
 * and each distinct model deserves its own warning. `warnIfUnpriced` dedupes
 * too, but only after the first call has already logged; this set keeps the
 * round-start loop honest about what is about to be spent.
 */
function roundModels(roster: ThinkerRoster, enabledSlots: ThinkerSlot[]): string[] {
  const models = new Set<string>([roster.planner.model, roster.master.model]);
  for (const slot of enabledSlots) models.add(slot.model.model);
  return [...models];
}

/**
 * Say, before the first call, that part of the round is doomed.
 *
 * A roster can point at a provider whose key was never configured. The calls
 * then fail where they are made — the planner falls back to the deterministic
 * angles, a thinker reports an error, the synthesis assembles locally — so the
 * round survives, but only by being wrong about which models it thought it was
 * using. Same policy as `warnIfUnpriced`: the warning has to precede the
 * spending, because by the time the first 401 lands the round has already
 * decided its shape.
 */
function warnUnkeyedProviders(roster: ThinkerRoster, enabledSlots: ThinkerSlot[]): void {
  const providers = new Set<ThinkerProvider>([roster.planner.provider, roster.master.provider]);
  for (const slot of enabledSlots) providers.add(slot.model.provider);

  for (const provider of providers) {
    if (providerKeyPresent(provider)) continue;
    console.warn(
      `[deep-think] provider "${provider}" has no key configured; every model routed to it ` +
        "will fail at call time. The round degrades per role: the planner falls back to the " +
        "default angles, a thinker reports error, the synthesis assembles locally.",
    );
  }
}

/** One warning per model id; a round makes dozens of calls with the same one. */
const unpricedModels = new Set<string>();

/**
 * Say out loud that a round will report zero.
 *
 * `priceTextResponse` answers 0 for a model it has no rates for, so a roster
 * model the rate card has never heard of leaves `cost_usd` undefined, `addCost`
 * uncalled and the panel showing nothing — while the account is charged in
 * full. That silent zero is a documented failure mode of this codebase, and the
 * roster is a new door into it, on the most expensive operation the app has.
 * The round still runs: a missing price is a bookkeeping problem, not a reason
 * to refuse to think.
 */
function warnIfUnpriced(model: string): void {
  if (ratesFor(model) || unpricedModels.has(model)) return;
  unpricedModels.add(model);
  console.warn(
    `[deep-think] model "${model}" is not in the rate card (services/pricing.ts), so this ` +
      "round will be charged by the provider and reported as costing nothing. Point " +
      "OPENAI_DEEPTHINK_MODEL at a priced model, or add its rates.",
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      await worker(items[index]!, index);
    }
  });
  await Promise.all(lanes);
}

/**
 * The synthesis is handed to a voice model that reads it out verbatim, so every
 * markdown mark left in it becomes a spoken artefact. `agent-jobs.ts` keeps its
 * own copy of this and is out of scope to edit; this one also flattens lists,
 * because the synthesiser reaches for them far more often than pi does.
 */
function forSpeech(text: string): string {
  return (
    text
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      // Whole tags first. The character class further down deletes `>` but not
      // `<`, so stripping markdown before markup turns "<b>" into a spoken "b".
      .replace(/<\/?[a-zA-Z][^<>]*>/g, "")
      // A horizontal rule, a setext underline or a table's separator row is
      // punctuation drawn with characters, and drawn characters get read out.
      .replace(/^[ \t]*(?=[-=_|: \t]*[-=_|])[-=_|: \t]{3,}$/gm, "")
      .replace(/^\s*[-*+•]\s+/gm, "")
      .replace(/^\s*\d+[.)]\s+/gm, "")
      // A bare link is read scheme, slashes and query string included. The host
      // is the part a listener can act on, and it keeps the attribution.
      .replace(/\bhttps?:\/\/(?:www\.)?([^\s/?#<>()"']+)(?:[^\s<>()"']*[^\s<>()"'.,;:!?])?/gi, "$1")
      .replace(/[`*_#<>|~]/g, "")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
