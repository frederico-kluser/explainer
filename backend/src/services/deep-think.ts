import { EventEmitter } from "node:events";
import { v4 as uuidv4 } from "uuid";

import { braveSearch } from "./brave.js";
import { addCost } from "./costs.js";
import { OpenAIError, TEXT_MODEL } from "./openai.js";
import { priceTextResponse, ratesFor, type TextUsage } from "./pricing.js";
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

function deepThinkModel(): string {
  return (
    process.env.OPENAI_DEEPTHINK_MODEL || process.env.OPENAI_TEXT_MODEL || TEXT_MODEL
  );
}

function openAIBase(): string {
  return process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
}

const MAX_SCENARIO_CHARS = 4_000;
const MAX_REFLECTION_CHARS = 4_000;
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
 */
export function dispatchDeepThink(options: DeepThinkOptions): DeepThinkJob {
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

  const count = clampThinkerCount(options.thinkerCount ?? defaultThinkerCount());
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
  void runRound(job, options, count);

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
  warnIfUnpriced(deepThinkModel());

  const reflection = (options.reflection ?? "").trim().slice(0, MAX_REFLECTION_CHARS);
  const search = options.searchFn ?? braveSearch;
  const signal = controller.signal;

  try {
    const planned = await plan(job.scenario, reflection, count, signal);
    round.spent.usd += planned.usd;
    if (job.status !== "running") return;

    // Ids stay put so an event already delivered still points at the same card.
    job.thinkers = planned.specs.map((spec, index) => ({
      id: job.thinkers[index]?.id ?? spec.id,
      angle: spec.angle,
      status: "pending" as const,
    }));
    const specs = planned.specs.map((spec, index) => ({
      ...spec,
      id: job.thinkers[index]?.id ?? spec.id,
    }));
    setActivity(job, `pensando em ${specs.length} frentes`);

    const context: ThinkerContext = { job, round, reflection, search, signal };

    await mapWithConcurrency(specs, thinkerConcurrency(), async (spec, index) => {
      const slot = job.thinkers[index];
      if (!slot || job.status !== "running") return;

      slot.status = "running";
      setActivity(job, `pensando: ${spec.angle}`);

      let outcome: Awaited<ReturnType<typeof think>>;
      try {
        outcome = await think(spec, context);
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
    const synthesised = await synthesise(job, reflection, signal);
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
  scenario: string,
  reflection: string,
  count: number,
  signal: AbortSignal,
): Promise<{ specs: ThinkerSpec[]; usd: number }> {
  const instructions =
    `Voce esta organizando uma rodada de pensamento profundo com ${count} pensadores independentes.\n` +
    "Cada pensador recebe o MESMO cenario, mas um ANGULO diferente de ataque. Angulos repetidos ou " +
    "parecidos desperdicam a rodada inteira, entao facam-nos deliberadamente distintos entre si: " +
    "evidencia, risco, custo, contraposicao, premissa, consequencia, prazo, medicao.\n\n" +
    `Cenario: ${scenario}\n` +
    (reflection ? `Reflexao de quem perguntou: ${reflection}\n` : "") +
    `\nResponda APENAS com um array JSON de ${count} objetos, sem texto em volta e sem markdown. ` +
    'Cada objeto tem exatamente duas chaves: "angle" (rotulo curto em portugues, no maximo tres ' +
    'palavras, minusculas) e "prompt" (uma a tres frases dizendo ao pensador o que investigar sob ' +
    "esse angulo, em portugues do Brasil).";

  try {
    const payload = await respond(
      { model: deepThinkModel(), input: instructions, max_output_tokens: 1_200 },
      { timeoutMs: PLANNER_TIMEOUT_MS, signal },
    );
    const usd = priceOf(payload);
    const specs = parsePlan(messageText(payload), count);
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
 * `strict: true` demands every property be required, which is why the result
 * count is decided here instead of being another field the model can inflate.
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
): Promise<Partial<ThinkerResult>> {
  const tally: ThinkerTally = { searches: 0, attempts: 0, usd: 0 };
  try {
    return await runThinker(spec, context, tally);
  } catch (err) {
    if (isAbort(err)) throw err; // the round is ending; not this thinker's fault
    return { status: "error", error: errText(err), searches: tally.searches, usd: tally.usd };
  }
}

async function runThinker(
  spec: ThinkerSpec,
  context: ThinkerContext,
  tally: ThinkerTally,
): Promise<Partial<ThinkerResult>> {
  const { job, round, reflection, search, signal } = context;
  const scenario = job.scenario;
  const budget = searchBudget();
  // What the searches returned. Which of these the thinker actually leaned on is
  // decided at the end, against the text it wrote — see `citedFrom`.
  const seen: BraveResult[] = [];
  let webNote = "";

  const input: unknown[] = [
    {
      role: "user",
      content:
        `Voce e um dos varios pensadores olhando o MESMO cenario, cada um por um angulo diferente. ` +
        `O seu angulo e: ${spec.angle}.\n\n` +
        `Cenario: ${scenario}\n` +
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
    const payload = await respond(
      {
        model: deepThinkModel(),
        input,
        tools: [SEARCH_TOOL],
        tool_choice: "auto",
        max_output_tokens: 1_400,
      },
      { timeoutMs: THINKER_TIMEOUT_MS, signal },
    );
    bill(round, tally, priceOf(payload));

    const calls = functionCalls(payload);
    if (calls.length === 0) {
      const thinking = messageText(payload).trim();
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

    // Everything the model emitted is carried forward — dropping the reasoning
    // or the call item itself is the documented way to break the next request.
    input.push(...(payload.output ?? []));

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
      input.push({ type: "function_call_output", call_id: call.call_id ?? "", output });
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
  job: DeepThinkJob,
  reflection: string,
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
    const payload = await respond(
      { model: deepThinkModel(), input: instructions, max_output_tokens: 1_000 },
      { timeoutMs: SYNTHESIS_TIMEOUT_MS, signal },
    );
    const text = forSpeech(messageText(payload)).slice(0, MAX_SYNTHESIS_CHARS);
    if (!text) return { text: forSpeech(localSynthesis(usable)), usd: priceOf(payload) };
    return { text, usd: priceOf(payload) };
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

  // `text` because `CostSource` has no deep_think member yet — see the handoff.
  if (job.cost_usd !== undefined && job.cost_usd > 0) {
    void addCost(job.conversation_id, {
      source: "text",
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
// Responses API, with tools
// ---------------------------------------------------------------------------
//
// `openai.ts` has no tool-calling helper and is out of scope to edit, so the
// three-item protocol lives here: flat tool definitions, `function_call` items
// coming back, `function_call_output` items going in, matched by `call_id`.

interface ResponsesItem {
  type?: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: Array<{ type?: string; text?: string }>;
}

interface ResponsesPayload {
  model?: string;
  usage?: TextUsage;
  output?: ResponsesItem[];
  output_text?: string;
}

async function respond(
  body: Record<string, unknown>,
  { timeoutMs, signal }: { timeoutMs: number; signal: AbortSignal },
): Promise<ResponsesPayload> {
  if (signal.aborted) throw abortError();

  const controller = new AbortController();
  const relay = () => controller.abort();
  signal.addEventListener("abort", relay, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${openAIBase()}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await response.text();
    if (!response.ok) {
      let detail = text.slice(0, 500);
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string } };
        if (parsed.error?.message) detail = parsed.error.message;
      } catch {
        // keep the raw body
      }
      throw new OpenAIError(response.status, detail);
    }

    return JSON.parse(text) as ResponsesPayload;
  } catch (err) {
    if (err instanceof OpenAIError) throw err;
    if (signal.aborted) throw abortError();
    if (err instanceof Error && err.name === "AbortError") {
      throw new OpenAIError(504, `A chamada ao modelo passou de ${timeoutMs}ms.`);
    }
    throw new OpenAIError(502, errText(err));
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", relay);
  }
}

function apiKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new OpenAIError(500, "OPENAI_API_KEY is not set on the server");
  return key;
}

function messageText(payload: ResponsesPayload): string {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text;
  }
  const chunks: string[] = [];
  for (const item of payload.output ?? []) {
    if (item.type !== "message") continue;
    for (const part of item.content ?? []) {
      if (part.text) chunks.push(part.text);
    }
  }
  return chunks.join("\n").trim();
}

function functionCalls(payload: ResponsesPayload): ResponsesItem[] {
  return (payload.output ?? []).filter(
    (item) => item.type === "function_call" && item.name === SEARCH_TOOL.name,
  );
}

function argOf(call: ResponsesItem, key: string): string {
  try {
    const parsed = JSON.parse(call.arguments ?? "{}") as Record<string, unknown>;
    const value = parsed[key];
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

function priceOf(payload: ResponsesPayload): number {
  const model = payload.model ?? deepThinkModel();
  warnIfUnpriced(model);
  return priceTextResponse(model, payload.usage ?? {});
}

/** One warning per model id; a round makes dozens of calls with the same one. */
const unpricedModels = new Set<string>();

/**
 * Say out loud that a round will report zero.
 *
 * `priceTextResponse` answers 0 for a model it has no rates for, so an
 * `OPENAI_DEEPTHINK_MODEL` the rate card has never heard of leaves `cost_usd`
 * undefined, `addCost` uncalled and the panel showing nothing — while the
 * account is charged in full. That silent zero is a documented failure mode of
 * this codebase; this env var is a new door into it, on the most expensive
 * operation the app has. The round still runs: a missing price is a bookkeeping
 * problem, not a reason to refuse to think.
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

function abortError(): Error {
  const err = new Error("A rodada foi interrompida.");
  err.name = "AbortError";
  return err;
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
