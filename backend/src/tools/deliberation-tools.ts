// The bodies behind the three deliberation tools the voice model can call.
//
// `services/tool-executor.ts` is a switch and nothing else, so everything a
// deliberation tool has to decide lives here: what the model is allowed to send,
// what comes back as `function_call_output`, and what only the browser sees.
//
// One rule shapes all three, and it comes from `prompts.ts`: whatever lands in
// `output` is read out loud, exactly as written. So `output` is always a
// Portuguese sentence a person can hear — never mermaid source, never a stack
// trace, never an English validation message. Anything structured goes in
// `meta`, which `routes/realtime.ts` hands to the browser and never to the model.
//
// That rule held only as long as every string handed up from below happened to
// obey it, and neither engine did: the generator interpolated bracket counts and
// sixty characters of refused source into its message, and a deep-think round
// stores whatever an `OpenAIError` said, in English. So `spoken` below is the
// enforcement, not the intention — anything arriving from another module goes
// through it before it becomes `output`.
//
// For the same reason none of these functions throws. A throw becomes
// "A ferramenta falhou: <mensagem>" in the middle of a spoken turn; a sentence
// the model can say lets it tell the user what happened and carry on.

import {
  DeepThinkError,
  dispatchDeepThink,
  getDeepThinkJob,
  listDeepThinkJobs,
} from "../services/deep-think.js";
import { MERMAID_KINDS, MermaidError, generateMermaid } from "../services/mermaid.js";
import { recordDiagram } from "../services/memory.js";
import { MAX_THINKERS } from "../types/deep-tools.js";
import type {
  DeepThinkJob,
  MermaidDiagramKind,
  MermaidRequest,
} from "../types/deep-tools.js";
import type { ToolOutcome } from "../services/tool-executor.js";

// ---------------------------------------------------------------------------
// Argument reading
// ---------------------------------------------------------------------------
//
// The executor hands over whatever JSON the model produced. These read it the
// way the rest of the codebase does — normalise what can be normalised, and
// answer a malformed call as tool output instead of throwing.

function textArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * A count the model said out loud, clamped instead of refused.
 *
 * `dispatchDeepThink` clamps too; this one exists so the number is already sane
 * at the boundary and `MAX_THINKERS` stays the only place the ceiling is
 * written. Unreadable input is dropped rather than rejected — a voice model
 * answering "uns vinte" should get twenty thinkers clamped to ten, not an error.
 */
function countArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  const raw =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isFinite(raw)) return undefined;
  return Math.min(MAX_THINKERS, Math.max(1, Math.trunc(raw)));
}

function kindArg(args: Record<string, unknown>): MermaidDiagramKind | undefined {
  const value = textArg(args, "kind");
  // A kind outside the closed list is dropped, not refused: it is a nudge, and
  // the generator picks the kind from the wording perfectly well without it.
  return MERMAID_KINDS.find((candidate) => candidate === value);
}

/**
 * Everything a spoken status line needs to know about a round.
 *
 * This is also where a failure's technical detail lands. `output` is generalised
 * before it is spoken, and the browser is the one consumer that can show the
 * real message without reading it out loud.
 */
function deepThinkMeta(job: DeepThinkJob): Record<string, unknown> {
  return {
    job_id: job.id,
    status: job.status,
    activity: job.activity,
    angles: job.thinkers.map((thinker) => thinker.angle),
    ...(job.error ? { error: job.error } : {}),
  };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// The spoken boundary
// ---------------------------------------------------------------------------

/**
 * Shapes that are never Brazilian-Portuguese prose.
 *
 * The header rule — `output` is a sentence a person can hear — is not something
 * a type can hold, and both engines behind these handlers produce strings that
 * are correct for a log and unspeakable in a conversation. `MermaidError` used
 * to carry the validator's own vocabulary (`Faltou fechar 2 simbolo(s): [ {`,
 * and sixty verbatim characters of the refused source), and a deep-think round
 * stores whatever `errText` made of an `OpenAIError` — English, sometimes a
 * whole JSON body. Neither is recognisable by asking "is this an Error?": both
 * arrive as ordinary sentences with syntax or English inside one of them.
 *
 * So the check is the caption rule from `mermaid.ts` plus what a thrown error
 * drags along that a caption never does. Shapes, not spellings, for the reason
 * the mermaid validator gives at length: an enumeration is one new provider
 * message away from being wrong.
 */
const NOT_SPEAKABLE: readonly RegExp[] = [
  // Markup, JSON bodies, SNAKE_CASE identifiers, assignments.
  /[[\]{}|<>`_=]/,
  // Directives, namespaces, arrows, URLs.
  /%%|::|--?>|https?:\/\//,
  // A call: `roubaTudo()`, `simbolo(s)`.
  /[A-Za-z0-9_]\(/,
  // SCREAMING identifiers: OPENAI, KEY, HTTP, JSON.
  /\b[A-Z]{3,}\b/,
  // A quoted token with no space in it is a name being shown, not a word being
  // said: `Troque "graph" por "flowchart"` is advice for whoever writes the
  // mermaid, and the user is not that person.
  /"[^"\s]{1,60}"/,
  // An id. `refusedRound` moved one out of the 409 sentence and `runDeepThink`
  // moved one out of the dispatch sentence; a third arriving inside a message
  // some other module wrote is the same bug with a longer path, and it is spoken
  // digit by digit either way.
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  // English function words, none of which is also a Portuguese word.
  /\b(?:the|is|are|was|not|failed|error|invalid|request|server|unexpected|undefined|null)\b/i,
];

/**
 * A sentence the model can read out, or a generic one that says the same thing.
 *
 * The original is never dropped, only moved: it goes to the log, where a
 * diagnosis belongs, instead of to text-to-speech, where it is noise the user
 * cannot act on.
 */
function spoken(candidate: string, fallback: string, where: string): string {
  const text = candidate.trim();
  if (text.length > 0 && !NOT_SPEAKABLE.some((shape) => shape.test(text))) return text;
  console.warn(`[${where}] refused to speak a diagnosis, saying the generic line:`, candidate);
  return fallback;
}

// ---------------------------------------------------------------------------
// deep_think
// ---------------------------------------------------------------------------

/**
 * Start a round of deep thinking and answer immediately.
 *
 * Same shape as `dispatch_pi_agent`, for the same reason: a round takes tens of
 * seconds to minutes and a spoken conversation cannot hold that open. The model
 * answers in milliseconds, says out loud that it fired the thinkers, and keeps
 * talking; the synthesis arrives later on its own stream. The id goes to the
 * browser through `meta`, never into the sentence.
 */
export async function runDeepThink(
  args: Record<string, unknown>,
  conversationId: string,
): Promise<ToolOutcome> {
  const scenario = textArg(args, "scenario");
  if (!scenario) {
    return {
      output:
        "Preciso saber sobre o que pensar. Pergunte ao usuario qual e o cenario " +
        "ou a decisao e chame a ferramenta de novo com isso.",
    };
  }

  const reflection = textArg(args, "reflection");
  const thinkerCount = countArg(args, "thinker_count");

  try {
    const job = dispatchDeepThink({
      conversationId,
      scenario,
      ...(reflection ? { reflection } : {}),
      ...(thinkerCount !== undefined ? { thinkerCount } : {}),
    });

    // No id in here. It is the same uuid the 409 branch below moves into `meta`,
    // and this is the path that runs every time: spoken, the model reads it out
    // digit by digit. `meta.job_id` is where the browser gets it.
    return {
      output:
        `Pensamento profundo disparado com ${job.thinkers.length} pensadores, cada ` +
        "um por um angulo diferente. Eles estao pensando agora. Avise o usuario em " +
        "voz alta que voce disparou os pensadores e continue a conversa; a conclusao " +
        "vai chegar sozinha em breve.",
      meta: deepThinkMeta(job),
    };
  } catch (err) {
    if (err instanceof DeepThinkError) return refusedRound(err, conversationId);
    console.error("[deep_think] dispatch failed:", errText(err));
    return {
      output:
        "Nao consegui disparar os pensadores agora. Diga isso ao usuario e siga " +
        "respondendo com o que voce ja sabe.",
    };
  }
}

/**
 * Turn a refusal into something the model can say.
 *
 * The engine answers 409 with a sentence naming a UUID, which is correct for a
 * log and unspeakable in a conversation — the model would read the id out digit
 * by digit. The id belongs in `meta`, where the browser can use it.
 */
function refusedRound(err: DeepThinkError, conversationId: string): ToolOutcome {
  if (err.status !== 409) {
    return {
      output: spoken(
        err.message,
        "Nao consegui disparar os pensadores agora. Diga isso ao usuario e siga " +
          "respondendo com o que voce ja sabe.",
        "deep_think",
      ),
    };
  }

  const running = listDeepThinkJobs(conversationId).find((job) => job.status === "running");
  return {
    output:
      "Ja tem uma rodada de pensamento profundo rodando nesta conversa. Diga ao " +
      "usuario que os pensadores ainda estao trabalhando e continue a conversa; " +
      "da para disparar outra so depois que esta terminar.",
    ...(running ? { meta: deepThinkMeta(running) } : {}),
  };
}

/**
 * Report on a round, whether or not it has finished.
 *
 * `job_id` is optional on purpose. Only one round runs per conversation, so the
 * model asking "e o pensamento profundo?" without having kept the id is the
 * common case, not a malformed call.
 */
export async function checkDeepThink(
  args: Record<string, unknown>,
  conversationId: string,
): Promise<ToolOutcome> {
  const requested = textArg(args, "job_id");
  const job = requested ? ownedJob(requested, conversationId) : latestJob(conversationId);

  if (!job) {
    return {
      output:
        "Nao encontrei nenhuma rodada de pensamento profundo nesta conversa. " +
        "Se o usuario quiser, dispare uma nova.",
    };
  }

  if (job.status === "running") {
    return {
      output:
        `Os pensadores ainda estao trabalhando (${job.activity}). Continue a ` +
        "conversa; a conclusao chega sozinha.",
      meta: deepThinkMeta(job),
    };
  }

  const meta = deepThinkMeta(job);
  return {
    output: job.synthesis ?? endedWithout(job),
    meta: job.cost_usd !== undefined ? { ...meta, cost_usd: job.cost_usd } : meta,
  };
}

/**
 * What a round that produced no synthesis sounds like.
 *
 * `job.error` is whatever the round had at hand when it died, and its own
 * failure path stores `errText(err)` — so `Nenhum pensador conseguiu concluir.
 * OPENAI_API_KEY is not set on the server`, or a raw `OpenAI 429: {"error":…}`
 * body, arrives here as an ordinary string and gets read out in English in the
 * middle of a Portuguese turn. The sentences the round wrote for a person pass
 * through untouched; the rest is logged and generalised.
 */
function endedWithout(job: DeepThinkJob): string {
  if (!job.error) {
    return "A rodada terminou sem conclusao nenhuma. Se fizer falta, dispare outra.";
  }
  return spoken(
    job.error,
    "A rodada de pensamento profundo parou por uma falha aqui do lado. Diga isso " +
      "ao usuario e ofereca disparar outra.",
    "check_deep_think",
  );
}

/**
 * A job by id, but only if it belongs to this conversation.
 *
 * The registry is process-wide and the id came from a language model, so an id
 * from another conversation is answered as "not found" rather than read out.
 */
function ownedJob(id: string, conversationId: string): DeepThinkJob | undefined {
  const job = getDeepThinkJob(id);
  return job && job.conversation_id === conversationId ? job : undefined;
}

/** The round the model is most likely asking about: a running one, else the newest. */
function latestJob(conversationId: string): DeepThinkJob | undefined {
  const jobs = listDeepThinkJobs(conversationId);
  return (
    jobs.find((job) => job.status === "running") ??
    [...jobs].sort((a, b) => b.started_at.localeCompare(a.started_at))[0]
  );
}

// ---------------------------------------------------------------------------
// generate_diagram
// ---------------------------------------------------------------------------

/**
 * How long a spoken turn can wait for a drawing.
 *
 * This one is synchronous, unlike the other two, because "vou desenhar" then a
 * few seconds then "pronto" is a better conversation than a diagram that lands
 * three turns later. That trade only holds while the wait is short: the browser
 * puts no timeout on a tool call, so without a ceiling here the model sits on an
 * unanswered `function_call_output` for as long as the generator wants.
 */
const DIAGRAM_BUDGET_MS = 25_000;

/**
 * Attempts inside that budget.
 *
 * The generator's default of three is one correction too many to fit: each call
 * can take most of the budget on its own, and a third attempt would only ever be
 * cut off by the ceiling above.
 */
const DIAGRAM_ATTEMPTS = 2;

/**
 * Draw something and put it on screen.
 *
 * The mermaid source never reaches `output`. `prompts.ts` tells the model to
 * read its tool results out loud exactly as written, so a diagram in `output` is
 * a model spelling `graph TD A-->B` to a listener. The spoken half is the
 * caption; the drawing goes to the browser through `meta`.
 */
export async function runGenerateDiagram(
  args: Record<string, unknown>,
  conversationId: string,
): Promise<ToolOutcome> {
  const instructions = textArg(args, "instructions");
  if (!instructions) {
    return {
      output:
        "Preciso saber o que desenhar. Pergunte ao usuario o que ele quer ver no " +
        "diagrama e chame a ferramenta de novo.",
    };
  }

  const kind = kindArg(args);
  const title = textArg(args, "title");
  const request: MermaidRequest = {
    instructions,
    ...(kind ? { kind } : {}),
    ...(title ? { title } : {}),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DIAGRAM_BUDGET_MS);

  try {
    const diagram = await generateMermaid(request, conversationId, {
      attempts: DIAGRAM_ATTEMPTS,
      signal: controller.signal,
    });

    // Bookkeeping must not cost the conversation the drawing it already paid
    // for: the diagram is on screen either way, and a memory file that missed
    // one entry is a smaller loss than a tool that failed after succeeding.
    try {
      await recordDiagram(conversationId, diagram);
    } catch (err) {
      console.warn("[generate_diagram] could not record the diagram:", errText(err));
    }

    return {
      output:
        diagram.caption.trim().length > 0
          ? diagram.caption
          : "Coloquei o diagrama na tela.",
      meta: { diagram },
    };
  } catch (err) {
    if (controller.signal.aborted) {
      return {
        output:
          "Nao consegui desenhar a tempo. Diga isso ao usuario e pergunte se ele " +
          "quer que voce explique em palavras.",
      };
    }
    // Most of the generator's failures are written to be spoken; the one that
    // reports why every attempt was refused was not, and said `Faltou fechar 2
    // simbolo(s): [ {` out loud. `spoken` is what tells the two apart, and the
    // refused source stays in the log where `mermaid.ts` already puts it.
    if (err instanceof MermaidError) {
      return {
        output: spoken(
          err.message,
          "Nao consegui montar esse diagrama. Diga isso ao usuario e pergunte se ele " +
            "quer que voce explique em palavras.",
          "generate_diagram",
        ),
      };
    }

    console.error("[generate_diagram] failed:", errText(err));
    return {
      output:
        "O desenho falhou por um problema aqui do lado. Diga isso ao usuario e " +
        "ofereca explicar em palavras.",
    };
  } finally {
    clearTimeout(timer);
  }
}
