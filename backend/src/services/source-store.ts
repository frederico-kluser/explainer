import { getConversation, updateConversation } from "./storage.js";
import type { ResolvedSource } from "../types/index.js";

/**
 * The materials a conversation is pointed at.
 *
 * A conversation holds a *list*: a repository plus the spec that describes it,
 * or the machine docs plus the README of the thing you are trying to install.
 * Held in memory because every tool call needs it, and mirrored into the
 * conversation's metadata so a restart — or reopening a conversation from last
 * week — does not lose what was selected.
 */
const cache = new Map<string, ResolvedSource[]>();

/** How many materials one conversation may hold, before the prompt gets silly. */
export const MAX_MATERIALS = 6;

export class MaterialLimitError extends Error {
  public readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = "MaterialLimitError";
  }
}

export async function listSources(
  conversationId: string,
): Promise<ResolvedSource[]> {
  const cached = cache.get(conversationId);
  if (cached) return cached;

  const conv = await getConversation(conversationId);
  const sources = readStored(conv?.metadata);
  cache.set(conversationId, sources);
  return sources;
}

/** The material a tool call means when it does not name one. */
export async function primarySource(
  conversationId: string,
): Promise<ResolvedSource | null> {
  const sources = await listSources(conversationId);
  return sources[0] ?? null;
}

export async function addSource(
  conversationId: string,
  source: ResolvedSource,
): Promise<ResolvedSource[]> {
  const current = await listSources(conversationId);

  // The same repository added twice is a mistake, not a feature: replace it so
  // a re-add behaves like a refresh.
  const deduped = current.filter(
    (existing) => !sameMaterial(existing, source),
  );

  if (deduped.length >= MAX_MATERIALS) {
    throw new MaterialLimitError(
      `Uma conversa comporta no máximo ${MAX_MATERIALS} materiais. Remova um antes de adicionar outro.`,
    );
  }

  return persist(conversationId, [...deduped, source]);
}

export async function removeSource(
  conversationId: string,
  sourceId: string,
): Promise<ResolvedSource[]> {
  const current = await listSources(conversationId);
  return persist(
    conversationId,
    current.filter((source) => source.id !== sourceId),
  );
}

export function forgetSources(conversationId: string): void {
  cache.delete(conversationId);
}

/**
 * Find the material a tool call is talking about.
 *
 * The model refers to materials however it feels like — by id, by label, by
 * origin, or by position ("o segundo") — so all of those resolve, and anything
 * unmatched falls back to the first material rather than failing the call.
 */
export function pickSource(
  sources: ResolvedSource[],
  reference: string | undefined,
): ResolvedSource | null {
  if (sources.length === 0) return null;
  if (!reference) return sources[0]!;

  const needle = reference.trim().toLowerCase();
  if (!needle) return sources[0]!;

  const byId = sources.find((source) => source.id.toLowerCase() === needle);
  if (byId) return byId;

  const index = Number(needle);
  if (Number.isInteger(index) && index >= 1 && index <= sources.length) {
    return sources[index - 1]!;
  }

  const exact = sources.find(
    (source) => source.label.toLowerCase() === needle,
  );
  if (exact) return exact;

  const partial = sources.find(
    (source) =>
      source.label.toLowerCase().includes(needle) ||
      (source.origin ?? "").toLowerCase().includes(needle) ||
      source.kind === needle,
  );
  return partial ?? sources[0]!;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

async function persist(
  conversationId: string,
  sources: ResolvedSource[],
): Promise<ResolvedSource[]> {
  cache.set(conversationId, sources);

  const conv = await getConversation(conversationId);
  const metadata = { ...(conv?.metadata ?? {}), sources };
  // The single-source key is what old conversations were written with; drop it
  // once the list exists so nothing reads a stale value later.
  delete (metadata as Record<string, unknown>).source;

  await updateConversation(conversationId, { metadata });
  return sources;
}

/**
 * Read the list off metadata, accepting the shape conversations were saved with
 * before materials could be plural.
 */
function readStored(metadata: Record<string, unknown> | undefined): ResolvedSource[] {
  if (!metadata) return [];

  const list = metadata.sources;
  if (Array.isArray(list)) {
    return list.filter(isResolvedSource).map(withId);
  }

  const single = metadata.source;
  return isResolvedSource(single) ? [withId(single)] : [];
}

/** Older records predate ids; derive a stable one instead of dropping them. */
function withId(source: ResolvedSource): ResolvedSource {
  if (source.id) return source;
  const seed = `${source.kind}:${source.origin ?? source.label}`;
  return { ...source, id: seed.replace(/[^\w.:/-]/g, "_").slice(0, 64) };
}

function sameMaterial(a: ResolvedSource, b: ResolvedSource): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "machine") return true;
  if (a.origin && b.origin) return a.origin === b.origin;
  return a.label === b.label;
}

/** Metadata comes off disk as `unknown`; only trust it if it still looks right. */
function isResolvedSource(value: unknown): value is ResolvedSource {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<ResolvedSource>;
  return (
    (candidate.kind === "repo" ||
      candidate.kind === "markdown" ||
      candidate.kind === "machine") &&
    typeof candidate.label === "string"
  );
}
