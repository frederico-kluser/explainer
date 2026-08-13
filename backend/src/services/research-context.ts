// A cheap conversation-context block for the research tools — the `web_search`
// synthesis model, the pi agent and the deep-think fan-out. "Cheap" means no
// LLM call: the materials and the raw last turns are assembled here, and the
// memory pipeline (`buildResume`) is deliberately not used — it exists to
// compress a transcript once for the session instructions, and paying a model
// to summarise the conversation on every research call would cost more than
// the context saves. What the researcher needs is the last thing the user said,
// verbatim, not a paraphrase.
//
// The block is billed once per research call, but deep_think pastes whatever
// lands in its prompts into the planner, every thinker and the synthesiser —
// so the total is kept small on purpose, see MAX_CONTEXT_CHARS.

import { listSources } from "./source-store.js";
import { getConversation } from "./storage.js";
import type { Message, ResolvedSource } from "../types/index.js";

/**
 * How much of the conversation one research call may carry, in characters.
 *
 * Small on purpose: deep_think re-pastes the block into every stage of the
 * round, so each character is billed once per stage — and the turns of a
 * spoken conversation are short, so 3 000 characters already holds a dozen or
 * more of the latest exchanges. Raising it raises the price of every deep-think
 * round by that many characters times (planner + thinkers + synthesiser).
 */
export const MAX_CONTEXT_CHARS = 3_000;

/** One turn's share of the transcript, so a single long message cannot eat the budget. */
const MAX_MESSAGE_CHARS = 500;

/** Where the cut happened; counts against the budget, like every other char. */
const TRUNCATION_MARKER = "[...conversa anterior truncada...]";

const ROLE_LABELS: Record<Message["role"], string> = {
  user: "usuario",
  assistant: "assistente",
  tool: "ferramenta",
};

/** One line per material, mirroring `describeMaterials` in tool-executor.ts. */
function materialLine(source: ResolvedSource, index: number): string {
  const capability = source.root
    ? "posso ler, procurar e mandar agente"
    : "posso ler o documento";
  const where = source.origin ? ` — ${source.origin}` : "";
  return `${index + 1}. ${source.label} (${source.kind}${where}) — ${capability}`;
}

/**
 * The transcript, newest turn first, clipped to `budget` characters.
 *
 * Iterated backwards so the newest turn always survives: a researcher reads the
 * last thing the user said before anything older. The cut, when it happens, is
 * reported by the caller so the marker can sit exactly where it happened.
 */
function transcript(
  messages: Message[],
  budget: number,
): { lines: string[]; truncated: boolean } {
  const lines: string[] = [];
  let used = 0;
  let truncated = false;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    const content = (message.content ?? "").trim();
    if (!content) continue;

    const clipped =
      content.length > MAX_MESSAGE_CHARS
        ? `${content.slice(0, MAX_MESSAGE_CHARS - 1)}…`
        : content;
    const line = `${ROLE_LABELS[message.role] ?? message.role}: ${clipped}`;

    // Every line also pays for its separator on `lines.join("\n")` — charging
    // it here is what keeps the joined transcript inside the budget by
    // construction instead of by measurement.
    if (used + line.length + 1 <= budget) {
      lines.push(line);
      used += line.length + 1;
      continue;
    }

    truncated = true;
    // The newest turn still deserves to be seen in some form; anything older is
    // dropped whole. 40 characters is the smallest clip worth showing, plus
    // the separator it will pay on the join.
    const remaining = budget - used;
    if (remaining >= 41) {
      lines.push(`${line.slice(0, remaining - 2)}…`);
    }
    break;
  }

  return { lines, truncated };
}

/**
 * Build the block, most recent turns first.
 *
 * `sources` is optional: the caller already resolved the conversation's
 * materials (tool-executor does), and passing them avoids a second read.
 */
export async function buildResearchContext(
  conversationId: string,
  sources?: ResolvedSource[],
): Promise<string> {
  const materials = sources ?? (await listSources(conversationId));
  const conversation = await getConversation(conversationId);

  const sections: string[] = ["# Contexto da conversa"];
  if (materials.length > 0) {
    sections.push(`## Materiais\n${materials.map(materialLine).join("\n")}`);
  }
  sections.push("## Ultimos momentos da conversa (mais recentes primeiro)");

  // The transcript gets what the fixed sections left, minus the separator that
  // precedes it and the marker line (and its separator) reserved for when the
  // cut happens — the whole block shares the cap, headers included. The marker
  // is added after the loop, so it has to be held out of the loop's budget.
  const transcriptBudget = Math.max(
    0,
    MAX_CONTEXT_CHARS - sections.join("\n\n").length - 2 - TRUNCATION_MARKER.length,
  );

  const { lines, truncated } = transcript(conversation?.messages ?? [], transcriptBudget);
  if (lines.length === 0) {
    sections.push("A conversa ainda nao tem historico registrado.");
  } else {
    if (truncated) lines.push(TRUNCATION_MARKER);
    sections.push(lines.join("\n"));
  }

  return sections.join("\n\n").trim();
}
