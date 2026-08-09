// === The conversation as a file you can pick up again ===
//
// One JSON file per conversation, under the same data root the conversations
// themselves live in. It holds a single ordered sequence — user turns, assistant
// turns, every tool call with its arguments and its output, the reflections
// deep-think produced, and the diagrams — because the user asked for all of it
// in one file, and three parallel lists would drift out of order with each other
// the first time one write failed.
//
// Two things it deliberately is not:
//
//   - It is not the conversation record. `storage.ts` owns that. This is the
//     durable trace a session is rebuilt from, written by whoever observes the
//     call rather than by the chat route.
//   - It is not what gets replayed into a resumed session. A whole transcript
//     pasted into the realtime instructions is re-billed on *every* response, so
//     resuming goes through `buildResume`, which compresses it once.
//
// What survives when the file fills up — the pruning policy, in order:
//
//   1. The most recent events, verbatim. The tail of the conversation is what a
//      resumed session has to continue from.
//   2. The most recent reflections, verbatim, *even when they are older than
//      that tail*. A reflection costs a deep-think run to reproduce and a few
//      hundred bytes to keep; an ordinary turn is the opposite on both counts,
//      so reflections displace turns rather than the other way round. They never
//      take more than half the file.
//   3. Everything else folds into one rolling `note`: counts per kind, the tools
//      used, the first and last turn — and the *text* of the reflections that
//      did not fit in (2), which get their own budget inside the note.
//
// Nothing arriving through `importMemory` is trusted. It is validated field by
// field (see the import policy there), and `RESERVED_META_KEYS` is why an
// imported event cannot claim to be the rolling note — which would otherwise let
// a file received from a third party write the resumed session's instructions.

import { readFile, writeFile, rename, unlink, readdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ensureDir, isUUID, validateMemoryPath } from "../middleware/sandbox.js";
import { validateMermaid } from "./mermaid.js";
import { completeText } from "./openai.js";
import type {
  MemoryEvent,
  MemoryEventKind,
  MemoryFile,
  MemoryResume,
  MermaidDiagram,
  MermaidDiagramKind,
} from "../types/deep-tools.js";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * How many events survive in the file. Beyond this the oldest are folded into
 * one rolling `note`, so the beginning of the conversation is summarised rather
 * than dropped. Override with `EXPLAINER_MEMORY_MAX_EVENTS`.
 */
export const MEMORY_MAX_EVENTS_DEFAULT = 500;

/**
 * Per-event ceilings, in characters. A `search_source` call returns whole files
 * and a thinker returns pages of prose, so one untruncated event can outweigh
 * every other event in the file put together.
 *
 *   text        16 000 — a turn, a reflection or a note. Generous on purpose:
 *                        reflections survive pruning as real events and
 *                        `buildResume` carries them forward verbatim, so this
 *                        is the ceiling on the file's most valuable content.
 *   arguments    2 000 — a tool's arguments are a small JSON object; anything
 *                        longer is a pasted document, not a parameter.
 *   output       8 000 — enough to preserve what a finding actually said, far
 *                        below what reading a source file returns.
 *
 * Truncation is marked in the stored value, in Portuguese, because the marker
 * can end up in a summary the user reads.
 */
export const MEMORY_MAX_TEXT_CHARS = 16_000;
export const MEMORY_MAX_ARGUMENTS_CHARS = 2_000;
export const MEMORY_MAX_OUTPUT_CHARS = 8_000;

/**
 * Ceilings on the fields that are *not* per-event, and were unbounded until a
 * 5 MB diagram source produced a 5 MB file that every later append had to
 * re-serialise and rewrite whole.
 *
 * A truncated mermaid source no longer renders. That is the intended trade: the
 * file is the record of what was drawn, and a record that makes every
 * subsequent write cost megabytes is worse than one diagram that has to be
 * regenerated.
 */
export const MEMORY_MAX_TITLE_CHARS = 200;
export const MEMORY_MAX_MATERIAL_CHARS = 200;
export const MEMORY_MAX_MATERIALS = 50;
export const MEMORY_MAX_DIAGRAM_SOURCE_CHARS = 20_000;
export const MEMORY_MAX_DIAGRAM_CAPTION_CHARS = 1_000;

/**
 * How many diagrams the file keeps. Override with `EXPLAINER_MEMORY_MAX_DIAGRAMS`.
 *
 * The ceiling above bounds one diagram; this one bounds their number, which is
 * the half that was missing. `diagrams` is the only unbounded list left in the
 * file, and the file is read-modify-written whole on *every* append — a spoken
 * turn, a tool exchange — so an oversized `diagrams` array is not a one-off
 * cost: it is a permanent tax on every later write of that conversation,
 * measured at 20× on a saturated file. Newest are kept, for the same reason
 * pruning keeps the newest events.
 *
 * The trade is the same one `truncateDiagramSource` makes, and it has the same
 * shape: an event whose `diagram_id` points at a dropped diagram keeps its
 * caption and loses its drawing. Fifty is generous for a spoken conversation —
 * `MEMORY_MAX_MATERIALS` is the same number for the same reason — and it holds
 * the diagram list under a megabyte even when every entry is at its own ceiling.
 */
export const MEMORY_MAX_DIAGRAMS_DEFAULT = 50;

/** Longest `tool` / `diagram_id` an imported event may carry; both are ids. */
const MEMORY_MAX_ID_CHARS = 200;

/** Serialised size an imported event's free-form `meta` may reach. */
const MEMORY_MAX_META_CHARS = 4_000;

/**
 * Ceiling for the rolling note. Once it saturates, the *oldest* part of the
 * prose is what survives — which is the point of having it, since the recent
 * past is still present as real events.
 *
 * The reflection block is budgeted separately and rendered last, so prose is
 * what yields when the note fills up rather than the reflections.
 */
const MEMORY_MAX_NOTE_CHARS = 4_000;
const MEMORY_NOTE_REFLECTION_CHARS = 400;
const MEMORY_NOTE_REFLECTIONS_CHARS = 2_400;
const MEMORY_NOTE_MAX_REFLECTIONS = 8;

/** How much of the file `buildResume` folds into its compressed form. */
const RESUME_RECENT_TURNS = 12;
const RESUME_MAX_REFLECTIONS = 12;
const RESUME_MAX_TOOLS = 12;
const RESUME_EXCERPT_CHARS = 240;

/** Shown until something calls `setMemoryMeta` with the conversation's title. */
const DEFAULT_TITLE = "Conversa sem título";

function maxEvents(): number {
  // Read at call time so a test or an operator can change it without a restart.
  // Two is the floor: one rolling note plus one real event.
  const raw = Number(process.env.EXPLAINER_MEMORY_MAX_EVENTS);
  return Number.isFinite(raw) && raw >= 2
    ? Math.floor(raw)
    : MEMORY_MAX_EVENTS_DEFAULT;
}

function maxDiagrams(): number {
  // Read at call time, like `maxEvents`. One is the floor: a conversation that
  // draws must be able to keep the drawing it is talking about.
  const raw = Number(process.env.EXPLAINER_MEMORY_MAX_DIAGRAMS);
  return Number.isFinite(raw) && raw >= 1
    ? Math.floor(raw)
    : MEMORY_MAX_DIAGRAMS_DEFAULT;
}

// ---------------------------------------------------------------------------
// The closed vocabularies the file is allowed to contain
// ---------------------------------------------------------------------------

// Mirrors of the unions in `types/deep-tools.ts`. A union is erased at runtime,
// and an imported file is runtime data, so the check has to exist as a value.
const MEMORY_EVENT_KINDS: readonly MemoryEventKind[] = [
  "user",
  "assistant",
  "tool_call",
  "tool_result",
  "reflection",
  "diagram",
  "note",
];

const MERMAID_DIAGRAM_KINDS: readonly MermaidDiagramKind[] = [
  "flowchart",
  "sequenceDiagram",
  "classDiagram",
  "stateDiagram-v2",
  "erDiagram",
  "journey",
  "gantt",
  "pie",
  "mindmap",
  "timeline",
];

function isMemoryEventKind(value: unknown): value is MemoryEventKind {
  return (
    typeof value === "string" &&
    (MEMORY_EVENT_KINDS as readonly string[]).includes(value)
  );
}

function isMermaidDiagramKind(value: unknown): value is MermaidDiagramKind {
  return (
    typeof value === "string" &&
    (MERMAID_DIAGRAM_KINDS as readonly string[]).includes(value)
  );
}

/**
 * Keys in `meta` that only this module may set.
 *
 * `rolling` marks the note `deterministicSummary` puts at the *top* of the
 * resume, and that resume seeds the instructions of the resumed session. If a
 * file could arrive carrying `meta.rolling`, importing a file someone else sent
 * would let them write the voice model's system prompt. The marker is a fact
 * this module produces, so `normalizeEvent` — the single door every foreign and
 * local event goes through — strips it, and only `rollingNote()` mints it.
 *
 * Stripping rather than rejecting: a file exported from here legitimately
 * contains a rolling note, and re-importing your own export must not be an
 * error. The note's *text* survives as an ordinary note; only its authority
 * does not.
 */
const RESERVED_META_KEYS = new Set([
  "rolling",
  "archived_events",
  "archived_reflections",
]);

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * A memory file that cannot be trusted. Carries HTTP 400 for the error-handler
 * middleware; the message is in Portuguese because it is shown to the user who
 * chose the file to import.
 */
export class MemoryFormatError extends Error {
  public readonly status: number = 400;

  constructor(message: string) {
    super(message);
    this.name = "MemoryFormatError";
  }
}

/**
 * An import that would destroy a memory nobody asked to destroy. Carries HTTP
 * 409; the message is in Portuguese and names the way out.
 *
 * Importing *replaces* — the file being taken in is the conversation's whole
 * memory, and merging two independently-written sequences would interleave two
 * conversations that never happened together. So the danger is not in the
 * replacement, it is in doing it silently: what disappears includes the
 * reflections, which cost a deep-think round each to reproduce, and nothing in
 * this module keeps a copy (`clearMemory` unlinks; there is no backup). The
 * caller has to say the word.
 */
export class MemoryConflictError extends Error {
  public readonly status: number = 409;

  constructor(message: string) {
    super(message);
    this.name = "MemoryConflictError";
  }
}

/** Every event a producer may hand in; `id` and `at` are filled in if absent. */
export type MemoryEventInput = Omit<MemoryEvent, "id" | "at"> & {
  id?: string;
  at?: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isoNow(): string {
  return new Date().toISOString();
}

interface NodeError extends Error {
  code: string;
}

function isNodeError(err: unknown): err is NodeError {
  return err instanceof Error && "code" in err;
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const omitted = value.length - limit;
  return `${value.slice(0, limit)}\n… [truncado: ${omitted} caracteres omitidos]`;
}

/** Collapse to a single line and cut it short, for summaries and excerpts. */
function oneLine(value: string, limit = 300): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Quote a bad value when it is quotable, name its type when it is not. */
function describeValue(value: unknown): string {
  if (typeof value === "string") return `"${oneLine(value, 60)}"`;
  return describeType(value);
}

/** Name the type in Portuguese, so a rejection says what actually arrived. */
function describeType(value: unknown): string {
  if (value === null) return "nulo";
  if (Array.isArray(value)) return "lista";
  switch (typeof value) {
    case "string":
      return "texto";
    case "number":
      return "número";
    case "boolean":
      return "booleano";
    case "undefined":
      return "ausente";
    default:
      return "objeto";
  }
}

/**
 * Write atomically via temp-file + rename.
 *
 * Deliberately a copy of the helper in `storage.ts` rather than an import: that
 * one is module-private, and exporting it to share it here would promote an
 * internal detail of conversation persistence into public API that any later
 * caller could bind to. The pattern is a few lines; the coupling would outlive
 * them.
 */
async function atomicWrite(targetPath: string, data: string): Promise<void> {
  const tmpPath = `${targetPath}.tmp.${randomUUID()}`;
  try {
    await writeFile(tmpPath, data, "utf-8");
    await rename(tmpPath, targetPath);
  } catch (err) {
    // Best-effort cleanup: don't shadow the original error.
    try {
      await unlink(tmpPath);
    } catch {
      // ignore
    }
    throw err;
  }
}

// A memory file is read-modify-written whole, so two overlapping appends lose
// whichever finished first. Same shape as `withConversationLock` in
// `storage.ts`, replicated for the reason above, and keyed in its own map on
// purpose: an event appended during a live call must not queue behind a message
// write, nor hold one up.
//
// What the map holds is `link`, never `result`: `link` maps both settle paths to
// `undefined`, so it cannot reject, so a failed write cannot poison the queue
// and silently drop every later event for that conversation. That is the whole
// mechanism — the next operation chains on success alone because there is no
// other path left to chain on.
const writeQueues = new Map<string, Promise<unknown>>();

function withMemoryLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(id) ?? Promise.resolve();
  const result = previous.then(operation);

  // Keep the chain alive but never let a rejection escape into the next link.
  const link = result.then(
    () => undefined,
    () => undefined,
  );
  writeQueues.set(id, link);
  void link.then(() => {
    if (writeQueues.get(id) === link) writeQueues.delete(id);
  });

  return result;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function sanitizeMeta(
  meta: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (RESERVED_META_KEYS.has(key)) continue;
    clean[key] = value;
  }
  return Object.keys(clean).length > 0 ? clean : undefined;
}

function normalizeEvent(input: MemoryEventInput): MemoryEvent {
  const event: MemoryEvent = {
    id: input.id ?? randomUUID(),
    kind: input.kind,
    at: input.at ?? isoNow(),
  };

  if (input.text !== undefined) {
    event.text = truncate(input.text, MEMORY_MAX_TEXT_CHARS);
  }
  if (input.tool !== undefined) event.tool = input.tool;
  if (input.arguments !== undefined) {
    event.arguments = truncate(input.arguments, MEMORY_MAX_ARGUMENTS_CHARS);
  }
  if (input.output !== undefined) {
    event.output = truncate(input.output, MEMORY_MAX_OUTPUT_CHARS);
  }
  if (input.diagram_id !== undefined) event.diagram_id = input.diagram_id;
  if (input.meta !== undefined) {
    // Every event — local or imported — loses the reserved markers here. See
    // RESERVED_META_KEYS.
    const meta = sanitizeMeta(input.meta);
    if (meta) event.meta = meta;
  }

  return event;
}

function isRollingNote(event: MemoryEvent): boolean {
  return event.kind === "note" && event.meta?.rolling === true;
}

function isReflection(event: MemoryEvent): boolean {
  return event.kind === "reflection" && !!event.text?.trim();
}

const REFLECTIONS_HEADING = "Reflexões arquivadas (na íntegra):";

/**
 * Render the reflection block exactly the same way every time, so the next fold
 * can strip it back off the previous note's text and rebuild it.
 */
function renderReflections(reflections: string[]): string {
  if (reflections.length === 0) return "";
  return `${REFLECTIONS_HEADING}\n${reflections.map((text) => `- ${text}`).join("\n")}`;
}

/**
 * Cut a reflection to its per-entry budget.
 *
 * Not `truncate`: this runs again on every fold, and re-truncating a value that
 * already carries the "[truncado: N]" marker appends a second one with a wrong
 * count. A bare ellipsis is idempotent — clipping an already-clipped entry
 * returns it unchanged.
 */
function clipReflection(text: string): string {
  return text.length <= MEMORY_NOTE_REFLECTION_CHARS
    ? text
    : `${text.slice(0, MEMORY_NOTE_REFLECTION_CHARS)}…`;
}

function readCarriedReflections(note: MemoryEvent | undefined): string[] {
  const raw = note?.meta?.archived_reflections;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry): entry is string => typeof entry === "string")
    .map(clipReflection);
}

/** Oldest first while the budget lasts: what is still a live event is not lost. */
function fitReflections(reflections: string[]): string[] {
  const kept: string[] = [];
  let used = 0;
  for (const text of reflections) {
    if (kept.length >= MEMORY_NOTE_MAX_REFLECTIONS) break;
    if (used + text.length > MEMORY_NOTE_REFLECTIONS_CHARS) break;
    kept.push(text);
    used += text.length;
  }
  return kept;
}

/**
 * Fold the events being dropped into one note.
 *
 * Deterministic and synchronous by design: pruning happens inside the write
 * lock during a live call, and putting a model call there would add a network
 * round-trip — and a way to fail — to appending a single event. The prose
 * summary that does use a model is built later, by `buildResume`.
 *
 * Reflection text is carried in `meta.archived_reflections` and re-rendered at
 * the end of the note on every fold. Keeping it in meta rather than parsing it
 * back out of the prose is what makes the block survive the merge: the prose is
 * truncated to whatever the block leaves over, so the reflections never fall off
 * the end of a saturated note.
 */
function rollingNote(dropped: MemoryEvent[]): MemoryEvent {
  const previous = dropped.find(isRollingNote);
  const carried = previous ? Number(previous.meta?.archived_events ?? 0) : 0;
  const fresh = dropped.filter((event) => !isRollingNote(event));
  const archived = carried + fresh.length;

  const carriedReflections = readCarriedReflections(previous);
  const previousBlock = renderReflections(carriedReflections);
  const previousProse =
    previous?.text && previousBlock && previous.text.endsWith(previousBlock)
      ? previous.text.slice(0, previous.text.length - previousBlock.length).trimEnd()
      : (previous?.text ?? "");

  const freshReflections = fresh
    .filter(isReflection)
    .map((event) => clipReflection(event.text!.trim()));
  const allReflections = [...carriedReflections, ...freshReflections];
  const keptReflections = fitReflections(allReflections);
  const lostReflections = allReflections.length - keptReflections.length;

  const counts = new Map<string, number>();
  for (const event of fresh) {
    counts.set(event.kind, (counts.get(event.kind) ?? 0) + 1);
  }

  const tools = [
    ...new Set(fresh.map((event) => event.tool).filter((tool): tool is string => !!tool)),
  ];
  const turns = fresh.filter(
    (event) => event.kind === "user" || event.kind === "assistant",
  );

  const lines = [`Resumo do trecho arquivado da conversa (${archived} eventos).`];

  const breakdown = [...counts]
    .map(([kind, count]) => `${kind}: ${count}`)
    .join(", ");
  if (breakdown) lines.push(`Eventos por tipo — ${breakdown}.`);
  if (tools.length > 0) lines.push(`Ferramentas usadas: ${tools.join(", ")}.`);

  const first = turns[0];
  const last = turns[turns.length - 1];
  if (first?.text) lines.push(`Começou com — ${first.kind}: ${oneLine(first.text)}`);
  if (last && last !== first && last.text) {
    lines.push(`Terminou com — ${last.kind}: ${oneLine(last.text)}`);
  }
  if (lostReflections > 0) {
    lines.push(
      `Reflexões arquivadas sem espaço nesta nota: ${lostReflections}.`,
    );
  }

  const fell = lines.join("\n");
  const merged = previousProse ? `${previousProse}\n\n${fell}` : fell;

  const block = renderReflections(keptReflections);
  const proseBudget = Math.max(0, MEMORY_MAX_NOTE_CHARS - block.length);
  const text = block
    ? `${truncate(merged, proseBudget)}\n\n${block}`
    : truncate(merged, MEMORY_MAX_NOTE_CHARS);

  const meta: Record<string, unknown> = {
    rolling: true,
    archived_events: archived,
  };
  if (keptReflections.length > 0) meta.archived_reflections = keptReflections;

  return {
    id: randomUUID(),
    kind: "note",
    at: isoNow(),
    text,
    meta,
  };
}

/**
 * Cap the file, turning whatever fell off the front into the rolling note.
 *
 * Reflections older than the recent tail are rescued into their own slots
 * instead of being folded away — see the pruning policy at the top of the file.
 */
function pruneEvents(events: MemoryEvent[]): MemoryEvent[] {
  const max = maxEvents();
  if (events.length <= max) return events;

  // The note occupies one slot, so the file never exceeds `max` entries.
  const budget = max - 1;
  // Reflections never take more than half the file, and never the last slot: a
  // resume made of reflections with no recent turn is not a resume.
  const slots = Math.max(0, Math.min(Math.floor(budget / 2), budget - 1));

  // `slice(-0)` returns the whole array, so no-slots has to be its own branch:
  // getting that wrong keeps every reflection and lets the file exceed `max`.
  const rescueFrom = (tail: MemoryEvent[]): MemoryEvent[] =>
    slots === 0
      ? []
      : events
          .slice(0, events.length - tail.length)
          .filter(isReflection)
          .slice(-slots);

  let tail = events.slice(-(budget - slots));
  let rescued = rescueFrom(tail);

  // Slots the rescue did not need go back to the recent tail, so a file without
  // reflections prunes exactly as it did before.
  const spare = slots - rescued.length;
  if (spare > 0) {
    tail = events.slice(-(budget - slots + spare));
    rescued = rescueFrom(tail);
  }

  const kept = new Set<MemoryEvent>([...rescued, ...tail]);
  const dropped = events.filter((event) => !kept.has(event));
  // Filtering the original array keeps the survivors in chronological order:
  // every rescued reflection is older than every event in the tail.
  return [rollingNote(dropped), ...events.filter((event) => kept.has(event))];
}

// ---------------------------------------------------------------------------
// Diagrams
// ---------------------------------------------------------------------------

/** A truncated source stays readable as mermaid text; `%%` is its comment. */
function truncateDiagramSource(value: string): string {
  if (value.length <= MEMORY_MAX_DIAGRAM_SOURCE_CHARS) return value;
  const omitted = value.length - MEMORY_MAX_DIAGRAM_SOURCE_CHARS;
  return `${value.slice(0, MEMORY_MAX_DIAGRAM_SOURCE_CHARS)}\n%% [truncado: ${omitted} caracteres omitidos]`;
}

function normalizeDiagram(diagram: MermaidDiagram): MermaidDiagram {
  const normalized: MermaidDiagram = {
    id: diagram.id,
    kind: diagram.kind,
    source: truncateDiagramSource(diagram.source),
    caption: truncate(diagram.caption, MEMORY_MAX_DIAGRAM_CAPTION_CHARS),
    created_at: diagram.created_at,
  };
  if (diagram.title !== undefined) {
    normalized.title = oneLine(diagram.title, MEMORY_MAX_TITLE_CHARS);
  }
  return normalized;
}

/**
 * Drop anything in a `diagrams` array that is not a diagram.
 *
 * The file is handed to the user and taken back, so it can come back with a
 * `null` in here. One `null` used to be permanent: `recordDiagram` does
 * `diagrams.filter((d) => d.id !== …)`, which threw on it and left the poisoned
 * file on disk, so that conversation could never record a diagram again.
 */
function sanitizeDiagrams(value: unknown): MermaidDiagram[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is MermaidDiagram => {
    if (!isPlainObject(entry)) return false;
    return (
      typeof entry.id === "string" &&
      typeof entry.source === "string" &&
      typeof entry.caption === "string" &&
      isMermaidDiagramKind(entry.kind)
    );
  });
}

/** Keep the newest `maxDiagrams()` entries. See MEMORY_MAX_DIAGRAMS_DEFAULT. */
function capDiagrams(diagrams: MermaidDiagram[]): MermaidDiagram[] {
  const max = maxDiagrams();
  return diagrams.length <= max ? diagrams : diagrams.slice(-max);
}

function normalizeMaterials(materials: string[]): string[] {
  return materials
    .slice(0, MEMORY_MAX_MATERIALS)
    .map((label) => oneLine(label, MEMORY_MAX_MATERIAL_CHARS));
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

function emptyFile(conversationId: string): MemoryFile {
  const now = isoNow();
  return {
    version: 1,
    conversation_id: conversationId,
    title: DEFAULT_TITLE,
    created_at: now,
    updated_at: now,
    materials: [],
    events: [],
  };
}

function isStoredEvent(value: unknown): value is MemoryEvent {
  if (!isPlainObject(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.at === "string" &&
    isMemoryEventKind(value.kind)
  );
}

/**
 * Make sense of whatever was on disk, or say it is unreadable.
 *
 * Returns null only when nothing can be salvaged — not an object, a version
 * this build cannot read, or no event list at all. Individual junk entries are
 * dropped instead, because losing one hand-edited event is better than losing
 * the conversation.
 */
function coerceFile(value: unknown, conversationId: string): MemoryFile | null {
  if (!isPlainObject(value)) return null;
  if (value.version !== 1) return null;
  if (!Array.isArray(value.events)) return null;

  const file: MemoryFile = {
    version: 1,
    // The path is what says which conversation this is; a mismatched field in
    // the file does not get to rename it.
    conversation_id: conversationId,
    title: typeof value.title === "string" ? value.title : DEFAULT_TITLE,
    created_at: typeof value.created_at === "string" ? value.created_at : isoNow(),
    updated_at: typeof value.updated_at === "string" ? value.updated_at : isoNow(),
    materials: Array.isArray(value.materials)
      ? value.materials.filter((label): label is string => typeof label === "string")
      : [],
    events: value.events.filter(isStoredEvent),
  };

  if (value.diagrams !== undefined) {
    const diagrams = sanitizeDiagrams(value.diagrams);
    if (diagrams.length > 0) file.diagrams = diagrams;
  }

  return file;
}

/**
 * Move an unreadable file aside instead of failing forever.
 *
 * `readMemory` is on the path of every append, so throwing here would make one
 * bad byte on disk break the conversation permanently — and this file is
 * explicitly exported to the user and edited by hand, so that is an expected
 * state, not an exceptional one. Renaming keeps the bytes for the user to
 * inspect while letting the conversation start a fresh memory. `clearMemory`
 * sweeps the leftovers.
 *
 * Best effort on purpose: it happens outside the write lock on the read path,
 * so a concurrent writer can win the race. Losing the rename costs a warning,
 * not the read.
 */
async function quarantine(
  path: string,
  conversationId: string,
  reason: string,
): Promise<void> {
  const target = `${path}.corrupted.${Date.now()}`;
  try {
    await rename(path, target);
    console.warn(
      `[memory] ${conversationId}: unreadable memory file (${reason}); moved to ${target}`,
    );
  } catch (err) {
    console.warn(
      `[memory] ${conversationId}: unreadable memory file (${reason}) and could not be moved aside:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function readFileOrNull(conversationId: string): Promise<MemoryFile | null> {
  const path = validateMemoryPath(conversationId);

  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === "ENOENT") return null;
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await quarantine(path, conversationId, "JSON inválido");
    return null;
  }

  const file = coerceFile(parsed, conversationId);
  if (!file) {
    await quarantine(path, conversationId, "estrutura irreconhecível");
    return null;
  }

  return file;
}

/** Read-modify-write under the conversation's lock, creating the file if new. */
async function mutate(
  conversationId: string,
  change: (file: MemoryFile) => void,
): Promise<MemoryFile> {
  return withMemoryLock(conversationId, async () => {
    const file = (await readFileOrNull(conversationId)) ?? emptyFile(conversationId);

    change(file);
    file.events = pruneEvents(file.events);
    file.updated_at = isoNow();

    await ensureDir(validateMemoryPath());
    await atomicWrite(
      validateMemoryPath(conversationId),
      JSON.stringify(file, null, 2),
    );

    return file;
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Append one event. The file is created on the first call. */
export async function appendMemoryEvent(
  conversationId: string,
  event: MemoryEventInput,
): Promise<void> {
  await appendMemoryEvents(conversationId, [event]);
}

/**
 * Append several events as one write.
 *
 * A tool call and its result belong together; sending them in one batch keeps
 * them adjacent in the file and costs one write instead of two.
 */
export async function appendMemoryEvents(
  conversationId: string,
  events: MemoryEventInput[],
): Promise<void> {
  if (events.length === 0) return;
  const normalized = events.map(normalizeEvent);
  await mutate(conversationId, (file) => {
    file.events.push(...normalized);
  });
}

/** The whole file, or null when the conversation has no memory yet. */
export async function readMemory(
  conversationId: string,
): Promise<MemoryFile | null> {
  return readFileOrNull(conversationId);
}

/** Set the title and the material labels the conversation ran against. */
export async function setMemoryMeta(
  conversationId: string,
  meta: { title?: string; materials?: string[] },
): Promise<MemoryFile> {
  return mutate(conversationId, (file) => {
    if (meta.title !== undefined) {
      file.title = oneLine(meta.title, MEMORY_MAX_TITLE_CHARS);
    }
    if (meta.materials !== undefined) {
      file.materials = normalizeMaterials(meta.materials);
    }
  });
}

/**
 * Keep a diagram whole, and record in the sequence that it was drawn.
 *
 * The event carries the caption rather than the mermaid source: the ordered log
 * is what gets summarised, and a page of diagram syntax in it would crowd out
 * the conversation. The source stays in `diagrams`, addressed by id.
 */
export async function recordDiagram(
  conversationId: string,
  diagram: MermaidDiagram,
): Promise<void> {
  const stored = normalizeDiagram(diagram);
  const event = normalizeEvent({
    kind: "diagram",
    diagram_id: stored.id,
    text: stored.title ? `${stored.title} — ${stored.caption}` : stored.caption,
    meta: { kind: stored.kind },
  });

  await mutate(conversationId, (file) => {
    // Sanitised again here rather than trusted from the read: this is the call
    // site that used to throw on a poisoned entry, and it is worth one pass to
    // guarantee it cannot.
    const diagrams = sanitizeDiagrams(file.diagrams);
    // Re-recording the same id replaces it: a regenerated diagram is a
    // correction, not a second drawing.
    file.diagrams = capDiagrams([
      ...diagrams.filter((d) => d.id !== stored.id),
      stored,
    ]);
    file.events.push(event);
  });
}

/** Hand the file to the user. Same bytes as `readMemory`, named for intent. */
export async function exportMemory(
  conversationId: string,
): Promise<MemoryFile | null> {
  return readMemory(conversationId);
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

function importError(message: string): MemoryFormatError {
  return new MemoryFormatError(`Arquivo de memória inválido: ${message}`);
}

function requireString(
  value: unknown,
  field: string,
  where: string,
): string {
  if (typeof value !== "string") {
    throw importError(
      `${where}, o campo "${field}" precisa ser texto (recebido: ${describeType(value)}).`,
    );
  }
  return value;
}

function requireShortId(value: unknown, field: string, where: string): string {
  const text = requireString(value, field, where);
  if (text.length > MEMORY_MAX_ID_CHARS) {
    throw importError(
      `${where}, o campo "${field}" precisa ter no máximo ${MEMORY_MAX_ID_CHARS} caracteres.`,
    );
  }
  return text;
}

/**
 * Check one event from a file that came from outside the process.
 *
 * The policy, applied here and to diagrams below:
 *
 *   1. Anything that decides how the file is read — version, conversation_id,
 *      events and diagrams being lists — is rejected when wrong. There is no
 *      sensible default for it.
 *   2. Content with the wrong type is rejected, not dropped. Silently discarding
 *      text the user believes they just imported is worse than telling them the
 *      file is broken.
 *   3. Bookkeeping this module can regenerate losslessly — `id`, `at` — is
 *      discarded and regenerated when it is unusable, because nothing is lost.
 *   4. Trust markers are always stripped: see RESERVED_META_KEYS.
 *   5. Oversized values are truncated to exactly the ceilings a locally written
 *      file gets, in `normalizeEvent`.
 *   6. A value that the browser executes rather than displays — a mermaid
 *      `source` — has to clear the same gate a locally drawn one cleared. Type
 *      alone is not a check for it; see `validateImportedDiagram`.
 */
function validateImportedEvent(value: unknown, index: number): MemoryEventInput {
  const where = `no evento ${index + 1}`;

  if (!isPlainObject(value)) {
    throw importError(
      `o evento ${index + 1} não é um objeto (recebido: ${describeType(value)}).`,
    );
  }

  if (!isMemoryEventKind(value.kind)) {
    throw importError(
      `o evento ${index + 1} tem kind ${describeValue(value.kind)}, ` +
        `que não existe. Use um destes: ${MEMORY_EVENT_KINDS.join(", ")}.`,
    );
  }

  const event: MemoryEventInput = { kind: value.kind };

  if (value.id !== undefined) {
    // Rule 3: a foreign id is kept when it is a UUID, so an exported file
    // round-trips unchanged, and re-minted when it is not.
    const id = requireShortId(value.id, "id", where);
    if (isUUID(id)) event.id = id;
  }
  if (value.at !== undefined) {
    const at = requireString(value.at, "at", where);
    if (!Number.isNaN(Date.parse(at))) event.at = at;
  }
  if (value.text !== undefined) event.text = requireString(value.text, "text", where);
  if (value.tool !== undefined) event.tool = requireShortId(value.tool, "tool", where);
  if (value.arguments !== undefined) {
    event.arguments = requireString(value.arguments, "arguments", where);
  }
  if (value.output !== undefined) {
    event.output = requireString(value.output, "output", where);
  }
  if (value.diagram_id !== undefined) {
    event.diagram_id = requireShortId(value.diagram_id, "diagram_id", where);
  }
  if (value.meta !== undefined) {
    if (!isPlainObject(value.meta)) {
      throw importError(
        `${where}, o campo "meta" precisa ser um objeto (recebido: ${describeType(value.meta)}).`,
      );
    }
    if (JSON.stringify(value.meta).length > MEMORY_MAX_META_CHARS) {
      throw importError(
        `${where}, o campo "meta" passa de ${MEMORY_MAX_META_CHARS} caracteres.`,
      );
    }
    event.meta = value.meta;
  }

  return event;
}

function validateImportedDiagram(value: unknown, index: number): MermaidDiagram {
  const where = `no diagrama ${index + 1}`;

  if (!isPlainObject(value)) {
    throw importError(
      `o diagrama ${index + 1} não é um objeto (recebido: ${describeType(value)}).`,
    );
  }
  if (!isMermaidDiagramKind(value.kind)) {
    throw importError(
      `o diagrama ${index + 1} tem kind ${describeValue(value.kind)}, ` +
        `que não é um tipo mermaid conhecido. Use um destes: ${MERMAID_DIAGRAM_KINDS.join(", ")}.`,
    );
  }

  const source = requireString(value.source, "source", where);

  // A mermaid source is an executable document in the browser that opens the
  // memory, and until this call the import checked only that `source` was a
  // string — so a file received from a third party could put `themeCSS`,
  // `%%{init: securityLevel}%%` or a smuggled tag on the user's disk, and from
  // there onto their screen. `validateMermaid` is the same gate a locally drawn
  // diagram passes in `generateMermaid`, which is what makes re-importing an
  // export a no-op: everything this module ever wrote was validated on the way
  // out. Running it on the raw string rather than on the truncated one is not a
  // gap — `MAX_DIAGRAM_CHARS` is well under `MEMORY_MAX_DIAGRAM_SOURCE_CHARS`,
  // so anything long enough to be truncated is rejected for its length first.
  //
  // Rejecting the whole file rather than dropping the diagram, which is rule 2
  // of the policy above and worth restating because the opposite is tempting
  // here: pruning discards junk when the alternative is losing a conversation
  // that is already on disk, and on import there is no such cost — nothing has
  // been written yet, the user still holds the file, and `mutate` is never
  // reached. Dropping would also mean the one case that matters most, a file
  // crafted to attack the person importing it, is the case they are never told
  // about; and every event pointing at the diagram through `diagram_id` would
  // survive as a dangling reference. The message names the index so a large
  // file with one bad diagram stays fixable.
  const validation = validateMermaid(source);
  if (!validation.ok) {
    throw importError(
      `o diagrama ${index + 1} tem um "source" que o validador de mermaid recusa, ` +
        `então ele não vai ser gravado: ${validation.problems.join(" ")}`,
    );
  }

  // The id stays verbatim: events point at it through `diagram_id`, so minting a
  // new one here would break the link the file exists to preserve.
  const diagram: MermaidDiagram = {
    id: requireShortId(value.id, "id", where),
    kind: value.kind,
    source,
    caption: requireString(value.caption, "caption", where),
    created_at:
      typeof value.created_at === "string" && !Number.isNaN(Date.parse(value.created_at))
        ? value.created_at
        : isoNow(),
  };
  if (value.title !== undefined) {
    diagram.title = requireString(value.title, "title", where);
  }

  return normalizeDiagram(diagram);
}

export interface ImportMemoryOptions {
  /**
   * Allow the import to replace a memory that already holds events.
   *
   * Off by default, and checked inside the write lock: see
   * `MemoryConflictError` for why replacing is right and doing it silently is
   * not. `DELETE /api/conversations/:id/memory` is the other way to say it.
   */
  overwrite?: boolean;
}

/**
 * Take a file back in and make it this conversation's memory.
 *
 * The argument is typed, but it arrives as parsed JSON from outside the
 * process, so every field is checked at runtime rather than trusted — see
 * `validateImportedEvent` for the policy. Events are re-normalised on the way
 * in: an imported file gets the same ids, timestamps, truncation, cap and
 * stripped trust markers as one written here.
 *
 * The result is the imported file and nothing else. A conversation that already
 * had a memory keeps none of it, which is why `overwrite` exists.
 *
 * @throws {MemoryFormatError} 400, with a message in Portuguese.
 * @throws {MemoryConflictError} 409, when the target already holds events and
 *   `overwrite` was not asked for.
 */
export async function importMemory(
  file: MemoryFile,
  { overwrite = false }: ImportMemoryOptions = {},
): Promise<MemoryFile> {
  const candidate: unknown = file;
  if (!isPlainObject(candidate)) {
    throw importError("o conteúdo não é um objeto.");
  }

  if (candidate.version !== 1) {
    throw importError(
      `versão não suportada (esperado 1, recebido ${String(candidate.version)}).`,
    );
  }
  if (typeof candidate.conversation_id !== "string" || !isUUID(candidate.conversation_id)) {
    throw importError("conversation_id precisa ser um UUID.");
  }
  if (!Array.isArray(candidate.events)) {
    throw importError("events precisa ser uma lista.");
  }
  if (candidate.diagrams !== undefined && !Array.isArray(candidate.diagrams)) {
    throw importError("diagrams precisa ser uma lista.");
  }
  if (candidate.materials !== undefined && !Array.isArray(candidate.materials)) {
    throw importError("materials precisa ser uma lista de textos.");
  }

  const conversationId = candidate.conversation_id;
  const events = candidate.events.map((event, index) =>
    normalizeEvent(validateImportedEvent(event, index)),
  );
  const diagrams = Array.isArray(candidate.diagrams)
    ? candidate.diagrams.map(validateImportedDiagram)
    : undefined;
  const materials = Array.isArray(candidate.materials)
    ? normalizeMaterials(
        candidate.materials.map((label, index) =>
          requireString(label, "materials", `no material ${index + 1}`),
        ),
      )
    : [];

  let title = DEFAULT_TITLE;
  if (candidate.title !== undefined) {
    title = oneLine(
      requireString(candidate.title, "title", "no arquivo"),
      MEMORY_MAX_TITLE_CHARS,
    );
  }

  const createdAt =
    typeof candidate.created_at === "string" ? candidate.created_at : isoNow();

  return mutate(conversationId, (current) => {
    // Inside the lock, against what is on disk right now: a check in the route
    // would be a read the writer of the next event can win.
    if (!overwrite && current.events.length > 0) {
      const events = current.events.length;
      const reflections = current.events.filter(isReflection).length;
      throw new MemoryConflictError(
        `Esta conversa já tem memória gravada (${events} ${events === 1 ? "evento" : "eventos"}, ` +
          `${reflections} ${reflections === 1 ? "reflexão" : "reflexões"}). Importar por cima ` +
          "apaga tudo isso e não há como desfazer. Repita com ?overwrite=true, ou apague " +
          "a memória atual antes (DELETE /api/conversations/:id/memory).",
      );
    }

    current.title = title;
    current.materials = materials;
    current.created_at = createdAt;
    current.events = events;
    // Assigned in both directions. `if (diagrams)` left the previous memory's
    // diagrams in a file whose events had all been replaced — drawings no
    // surviving event referred to, carried by every later write.
    if (diagrams && diagrams.length > 0) current.diagrams = capDiagrams(diagrams);
    else delete current.diagrams;
  });
}

/**
 * Forget the conversation. Absent memory is not an error.
 *
 * Sweeps the siblings too — `<id>.json.tmp.<uuid>` left by a write that died
 * between `writeFile` and `rename`, and `<id>.json.corrupted.<ts>` left by a
 * quarantine. Forgetting has to mean the whole conversation, and nothing else
 * ever collects those.
 */
export async function clearMemory(conversationId: string): Promise<void> {
  await withMemoryLock(conversationId, async () => {
    try {
      await unlink(validateMemoryPath(conversationId));
    } catch (err: unknown) {
      if (!isNodeError(err) || err.code !== "ENOENT") throw err;
    }
    await sweepLeftovers(conversationId);
  });
}

async function sweepLeftovers(conversationId: string): Promise<void> {
  const dir = validateMemoryPath();
  const prefix = `${conversationId}.json.`;

  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }

  await Promise.all(
    names
      .filter((name) => name.startsWith(prefix))
      .map((name) =>
        unlink(join(dir, name)).catch(() => {
          // Another sweep or a live rename got there first.
        }),
      ),
  );
}

// ---------------------------------------------------------------------------
// Resuming
// ---------------------------------------------------------------------------

function collectReflections(events: MemoryEvent[]): string[] {
  return events
    .filter((event) => event.kind === "reflection" && !!event.text?.trim())
    .slice(-RESUME_MAX_REFLECTIONS)
    .map((event) => event.text!.trim());
}

function collectToolFindings(events: MemoryEvent[]): string[] {
  const latest = new Map<string, string>();

  for (const event of events) {
    if (event.kind !== "tool_call" && event.kind !== "tool_result") continue;
    if (!event.tool) continue;

    const finding = event.output ?? event.text;
    if (!finding) continue;

    // Re-inserting moves the tool to the end, so the map reads oldest-use to
    // most-recent-use and the slice below keeps the tools still in play.
    latest.delete(event.tool);
    latest.set(event.tool, oneLine(finding, RESUME_EXCERPT_CHARS));
  }

  return [...latest]
    .slice(-RESUME_MAX_TOOLS)
    .map(([tool, finding]) => `${tool}: ${finding}`);
}

/**
 * The summary that needs no network: the rolling note, then the last turns.
 *
 * This is not a fallback bolted on for tests — it is what makes the file
 * resumable at all when the key is missing or OpenAI is down.
 *
 * The rolling note leads the summary, which is exactly why only this module may
 * mark an event as one: see RESERVED_META_KEYS.
 */
function deterministicSummary(file: MemoryFile): string {
  const parts: string[] = [];

  const rolling = file.events.find(isRollingNote);
  if (rolling?.text) parts.push(rolling.text);

  const turns = file.events.filter(
    (event) => event.kind === "user" || event.kind === "assistant",
  );
  const recent = turns.slice(-RESUME_RECENT_TURNS);

  if (recent.length > 0) {
    const lines = recent.map(
      (event) =>
        `${event.kind === "user" ? "Usuário" : "Assistente"}: ${oneLine(event.text ?? "")}`,
    );
    parts.push(`Últimos turnos da conversa:\n${lines.join("\n")}`);
  }

  if (parts.length === 0) {
    return "Conversa sem turnos registrados até agora.";
  }
  return parts.join("\n\n");
}

/**
 * Resolve with `null` when the budget runs out first.
 *
 * The losing call is *not* abandoned: its rejection handler is already attached
 * when the timer fires, so a late failure settles a promise nobody reads
 * instead of becoming an unhandled rejection — which, under Node's default
 * `--unhandled-rejections=throw`, would take the backend down.
 */
function withinBudget<T>(work: Promise<T>, budgetMs: number): Promise<T | null> {
  return new Promise<T | null>((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), budgetMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Null when no model should be asked; throws only if the call itself fails. */
async function summariseWithModel(
  file: MemoryFile,
  budgetMs?: number,
): Promise<string | null> {
  if (process.env.EXPLAINER_MEMORY_LLM_SUMMARY === "0") return null;
  if (!process.env.OPENAI_API_KEY) return null;

  const transcript = file.events
    .slice(-80)
    .map((event) => {
      if (event.kind === "tool_call" || event.kind === "tool_result") {
        return `[${event.kind}] ${event.tool ?? "?"}: ${oneLine(event.output ?? event.arguments ?? "")}`;
      }
      return `[${event.kind}] ${oneLine(event.text ?? "")}`;
    })
    .join("\n");

  const call = completeText(
    "Resuma a conversa abaixo em portugues do Brasil, em no maximo dez frases, " +
      "para que outro assistente possa retomá-la. Diga o que foi discutido, o que " +
      "ficou decidido e o que ficou pendente. Não invente nada que não esteja no " +
      `registro.\n\n${transcript}`,
    {
      maxTokens: 500,
      // Resuming a long conversation is a real charge on it. Without the id the
      // tokens are spent and the ledger books nothing — the silent zero
      // `tracking-costs-and-credits` documents.
      conversationId: file.conversation_id,
      // Bound the request itself as well as the wait: `completeText` defaults to
      // 30 s and aborts the fetch on its own timeout, which is what stops the
      // caller's budget from leaving a request running for another 26 seconds.
      ...(budgetMs ? { timeoutMs: budgetMs } : {}),
    },
  );

  const answer = budgetMs ? await withinBudget(call, budgetMs) : await call;
  if (answer === null) {
    console.warn(
      `[memory] ${file.conversation_id}: the summariser did not answer within ${budgetMs}ms; using the deterministic resume`,
    );
    return null;
  }

  const summary = answer.text.trim();
  return summary === "" ? null : summary;
}

export interface BuildResumeOptions {
  /**
   * The file, when the caller has already read it.
   *
   * The session mint reads it to decide whether there is anything to resume at
   * all; without this it would be read, parsed and thrown away a second time,
   * and this file is the one that grows.
   */
  file?: MemoryFile | null;

  /**
   * How long the model summary may take before the free one wins, in ms.
   *
   * Unset means `completeText`'s own 30 s, which is right for a background
   * caller and wrong for anything a person is waiting on. There is nothing to
   * lose by cutting it short: the deterministic summary is already built by the
   * time the call starts.
   */
  summaryBudgetMs?: number;
}

/**
 * The compressed form a resumed session is seeded with.
 *
 * Never throws for want of a summary. A failed model call — or one that runs
 * past `summaryBudgetMs` — degrades to `deterministicSummary`; losing the
 * resume because the summariser was slow or unavailable would defeat the file's
 * whole purpose.
 */
export async function buildResume(
  conversationId: string,
  { file: preloaded, summaryBudgetMs }: BuildResumeOptions = {},
): Promise<MemoryResume | null> {
  const file = preloaded ?? (await readMemory(conversationId));
  if (!file) return null;

  let summary = deterministicSummary(file);
  try {
    const written = await summariseWithModel(file, summaryBudgetMs);
    if (written) summary = written;
  } catch (err) {
    console.warn(
      `[memory] Falling back to the deterministic summary for ${conversationId}:`,
      err instanceof Error ? err.message : String(err),
    );
  }

  return {
    conversation_id: file.conversation_id,
    summary,
    reflections: collectReflections(file.events),
    tool_findings: collectToolFindings(file.events),
    materials: file.materials,
    event_count: file.events.length,
  };
}
