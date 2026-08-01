import { getConversation, updateConversation } from "./storage.js";

// What the app spent, per conversation.
//
// The realtime usage only exists in the browser (it rides `response.done` on the
// data channel), the web-search usage only exists here, and the pi cost only
// exists in the agent's JSONL. This module is where the three meet, so the
// sidebar can show one honest number.

export type CostSource = "realtime" | "web_search" | "pi_agent" | "text";

export interface CostEntry {
  source: CostSource;
  usd: number;
  detail?: string;
  tokens?: { input?: number; output?: number; audio?: number; cached?: number };
  at: string;
}

export interface CostSummary {
  total_usd: number;
  by_source: Record<CostSource, number>;
  entries: CostEntry[];
  /** Everything this process has seen since it started, across conversations. */
  process_total_usd: number;
}

const MAX_ENTRIES = 300;

const ledgers = new Map<string, CostEntry[]>();
let processTotal = 0;

function emptyBySource(): Record<CostSource, number> {
  return { realtime: 0, web_search: 0, pi_agent: 0, text: 0 };
}

/**
 * Record a charge.
 *
 * Persisted into the conversation's metadata as a running total so the number
 * survives a restart; the itemised list stays in memory, where it is only ever
 * used to explain the total that is already on screen.
 */
export async function addCost(
  conversationId: string,
  entry: Omit<CostEntry, "at">,
): Promise<void> {
  if (!Number.isFinite(entry.usd) || entry.usd < 0) return;

  const list = ledgers.get(conversationId) ?? [];
  list.push({ ...entry, at: new Date().toISOString() });
  if (list.length > MAX_ENTRIES) list.splice(0, list.length - MAX_ENTRIES);
  ledgers.set(conversationId, list);
  processTotal += entry.usd;

  // Storage failures must never break a conversation over a bookkeeping detail.
  try {
    const conv = await getConversation(conversationId);
    if (!conv) return;
    const previous =
      typeof conv.metadata?.cost_usd === "number" ? conv.metadata.cost_usd : 0;
    await updateConversation(conversationId, {
      metadata: { ...(conv.metadata ?? {}), cost_usd: previous + entry.usd },
    });
  } catch (err) {
    console.warn(
      "[costs] Could not persist the running total:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

export async function getCosts(conversationId: string): Promise<CostSummary> {
  const entries = ledgers.get(conversationId) ?? [];
  const by_source = emptyBySource();
  for (const entry of entries) by_source[entry.source] += entry.usd;

  const inMemory = entries.reduce((sum, entry) => sum + entry.usd, 0);

  // The persisted total covers earlier runs too; take whichever is larger so a
  // restart never makes the number appear to go backwards.
  let persisted = 0;
  try {
    const conv = await getConversation(conversationId);
    if (typeof conv?.metadata?.cost_usd === "number") {
      persisted = conv.metadata.cost_usd;
    }
  } catch {
    // fall back to what is in memory
  }

  return {
    total_usd: Math.max(inMemory, persisted),
    by_source,
    entries: entries.slice(-40),
    process_total_usd: processTotal,
  };
}

export function forgetCosts(conversationId: string): void {
  ledgers.delete(conversationId);
}
