// === What feeds the conversation file ===
//
// `memory.ts` owns the file: its format, its ceilings, its pruning policy. This
// module owns the other half — deciding what gets written and when — so a route
// records a turn in one line and never grows a second copy of that decision.
//
// Two properties everything here holds to:
//
//   - Nothing thrown from here reaches the caller. The archive matters less than
//     the conversation it archives, so a failed write is a warning in the log and
//     nothing else. A route that awaits one of these functions cannot be broken
//     by the disk. This is a property of *every exported function's whole body*,
//     not only of the write at the end of it: the deep-think listener discards
//     the promise with `void`, and Node's default `--unhandled-rejections=throw`
//     turns one discarded rejection into a dead backend process. So a field that
//     arrives with an unexpected type is bad data — logged and dropped — and the
//     try/catch around the body is the second layer under that.
//   - Nothing is clipped here. The per-field ceilings live in `memory.ts`
//     (16 000 text / 2 000 arguments / 8 000 output) and `buildResume` reads what
//     survives them; cutting a value shorter on the way in would silently lower
//     those ceilings for every consumer.

import { appendMemoryEvents, type MemoryEventInput } from "./memory.js";
import { getDeepThinkJob, subscribeDeepThink } from "./deep-think.js";
import type { DeepThinkEvent, ThinkerResult } from "../types/deep-tools.js";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * How much of one thinker's reasoning goes into the round's digest note.
 *
 * This is an excerpt by intent, not a truncation: the digest exists to say which
 * angles were taken and roughly where each landed. The reasoning that mattered
 * is already consolidated in the synthesis, which is stored whole.
 */
const THINKER_EXCERPT_CHARS = 600;

/**
 * Job ids whose reflection is already on disk, so a second `deep_think_done` for
 * the same round cannot write it twice. Bounded because the process outlives any
 * single conversation; the oldest id is the one least likely to be re-emitted.
 */
const RECORDED_JOBS_MAX = 200;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Collapse to a single line and cut it short. For digests only. */
function oneLine(value: string, limit: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}

/**
 * The single door to disk: one write, and no way for it to reach the caller.
 *
 * Every public function in this module goes through here, which is what makes
 * "best effort" a property of the module rather than a habit each function has
 * to remember.
 *
 * Returns whether the events are on disk. Only a caller that would otherwise
 * *lose* them needs to look — the deep-think dedupe, which must not mark a round
 * as recorded when the write is what failed.
 */
async function write(
  conversationId: string,
  events: MemoryEventInput[],
  what: string,
): Promise<boolean> {
  // Nothing to lose, so nothing failed.
  if (events.length === 0) return true;
  if (!conversationId) return false;

  try {
    await appendMemoryEvents(conversationId, events);
    return true;
  } catch (err) {
    console.warn(
      `[memory-recorder] ${conversationId}: could not record ${what}:`,
      message(err),
    );
    return false;
  }
}

/**
 * Read a field the contract types as a string but the wire may not honour.
 *
 * `DeepThinkEvent` is a compile-time contract and its producer is on the far
 * side of an EventEmitter — nothing checks the shape at runtime. A field of the
 * wrong type is bad data: worth a line in the log, never worth a rejection, for
 * the reason at the top of this file.
 */
function textField(value: unknown, field: string): string {
  if (typeof value === "string") return value.trim();
  if (value === undefined || value === null) return "";

  console.warn(
    `[memory-recorder] ignoring ${field}: expected a string, got ${typeof value}`,
  );
  return "";
}

/** Same rule as `textField`, for the one field typed as a list. */
function listField(value: unknown, field: string): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];

  console.warn(
    `[memory-recorder] ignoring ${field}: expected a list, got ${typeof value}`,
  );
  return [];
}

/**
 * `collectToolFindings` keys the resume on this name, so an empty one would
 * merge every anonymous result into a single entry. Naming it is more honest.
 */
function toolName(tool: string): string {
  return tool.trim() || "ferramenta desconhecida";
}

/**
 * The correlation id, when there is one, rides in `meta`.
 *
 * `MemoryEvent` has no field for it and its contract is frozen, but `meta` is an
 * open `Record<string, unknown>` that `sanitizeMeta` passes through untouched
 * (`call_id` is not one of the reserved markers). So this needs no change on the
 * `deep-tools.ts` side.
 */
function correlated(event: MemoryEventInput, callId?: string): MemoryEventInput {
  const id = callId?.trim();
  if (id) event.meta = { call_id: id };
  return event;
}

function callEvent(tool: string, args: string, callId?: string): MemoryEventInput {
  const event: MemoryEventInput = { kind: "tool_call", tool: toolName(tool) };
  if (args) event.arguments = args;
  return correlated(event, callId);
}

function resultEvent(tool: string, output: string, callId?: string): MemoryEventInput {
  const event: MemoryEventInput = { kind: "tool_result", tool: toolName(tool) };
  if (output) event.output = output;
  return correlated(event, callId);
}

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

/**
 * Record one side of the conversation.
 *
 * Blank text is dropped rather than stored: the realtime transcript arrives
 * empty often enough (a cough, a barge-in cut short) and an empty turn costs a
 * whole-file rewrite while saying nothing a resumed session could use.
 */
export async function recordTurn(
  conversationId: string,
  role: "user" | "assistant",
  text: string,
): Promise<void> {
  const trimmed = text?.trim() ?? "";
  if (!trimmed) return;

  await write(conversationId, [{ kind: role, text: trimmed }], `${role} turn`);
}

/**
 * Record a reflection — the conversation's most protected content.
 *
 * Pruning rescues reflections ahead of ordinary turns and `buildResume` carries
 * them forward verbatim, so this is the right kind for a conclusion worth
 * paying for again, and the wrong one for routine chatter.
 */
export async function recordReflection(
  conversationId: string,
  text: string,
  meta?: Record<string, unknown>,
): Promise<void> {
  const trimmed = text?.trim() ?? "";
  if (!trimmed) return;

  const event: MemoryEventInput = { kind: "reflection", text: trimmed };
  if (meta) event.meta = meta;

  await write(conversationId, [event], "reflection");
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/**
 * Record that a tool was called, before its result is known.
 *
 * Only safe with `callId`. The browser fires a turn's tool calls through
 * `Promise.all` (`useRealtimeSession.ts`), so the same tool can be in flight
 * twice at once and the file then reads `call(A) call(B) result(B) result(A)` —
 * anyone pairing adjacent entries attributes B's answer to A, and nothing in the
 * file lets them notice. `callId` is written to `meta.call_id` on both halves,
 * which is what makes the pair recoverable. Prefer `recordToolExchange`, which
 * cannot come apart in the first place.
 */
export async function recordToolCall(
  conversationId: string,
  tool: string,
  args: string,
  callId?: string,
): Promise<void> {
  await write(conversationId, [callEvent(tool, args, callId)], `call to ${tool}`);
}

/**
 * Record a tool's output on its own, when the call was recorded earlier.
 *
 * `callId` must be the same one given to `recordToolCall`; see there for why the
 * split form needs it.
 */
export async function recordToolResult(
  conversationId: string,
  tool: string,
  output: string,
  callId?: string,
): Promise<void> {
  await write(
    conversationId,
    [resultEvent(tool, output, callId)],
    `result of ${tool}`,
  );
}

/**
 * Record a call and its result together — the preferred form.
 *
 * One `appendMemoryEvents` means one read-modify-write of the file and, more
 * importantly, means the pair cannot be separated: a second write would let a
 * turn from a concurrent path land between the call and its own result, and the
 * file is read back as a single ordered sequence.
 */
export async function recordToolExchange(
  conversationId: string,
  tool: string,
  args: string,
  output: string,
): Promise<void> {
  await write(
    conversationId,
    [callEvent(tool, args), resultEvent(tool, output)],
    `exchange with ${tool}`,
  );
}

// ---------------------------------------------------------------------------
// Deep think
// ---------------------------------------------------------------------------

const recordedJobs = new Set<string>();

function remember(jobId: string): void {
  recordedJobs.add(jobId);
  if (recordedJobs.size <= RECORDED_JOBS_MAX) return;
  // Insertion order: the first entry is the oldest.
  const oldest = recordedJobs.values().next().value;
  if (oldest !== undefined) recordedJobs.delete(oldest);
}

/**
 * One line per thinker: the angle, and where it landed.
 *
 * Stored as a `note`, deliberately not as ten more reflections. The binding
 * constraint is the resume, not pruning: `buildResume` carries the last *twelve*
 * reflections into the session instructions, where they are re-billed on every
 * response, so one round of ten thinkers plus its synthesis would leave room for
 * exactly one earlier conclusion — and would spend those eleven slots on the raw
 * material the synthesis was already distilled from. Pruning is the milder half
 * of the story: at the 500-event cap it reserves 249 slots for reflections, so
 * eleven more evict nothing there. The consolidated answer is what survives into
 * a resumed session; the angles stay as a trace.
 *
 * Two things that trace does *not* buy, both accepted:
 *
 *   - The note never reaches a resumed session. `deterministicSummary` reads the
 *     rolling note and the last twelve turns, `collectToolFindings` reads only
 *     `tool_call`/`tool_result`, and nothing reads a plain `note`. The angles are
 *     in the file — visible to a read and to an export — and invisible to the
 *     model that resumes the conversation.
 *   - The full reasoning is gone for good. Only the first
 *     THINKER_EXCERPT_CHARS of each thinker land here, and `deep-think.ts` keeps
 *     the whole text nowhere but its in-memory `jobs` map, which `pruneJobs`
 *     empties. Once the process restarts, the excerpt is all there ever was.
 */
function thinkerDigest(thinkers: unknown[]): string {
  const lines: string[] = [];

  for (const entry of thinkers) {
    // Entries come off the same unchecked wire as the fields; a non-object one
    // is bad data, and reading `.angle` off it would throw. See `textField`.
    if (typeof entry !== "object" || entry === null) continue;
    const thinker = entry as Partial<ThinkerResult>;

    const angle =
      textField(thinker.angle, "thinker.angle") ||
      textField(thinker.id, "thinker.id") ||
      "ângulo sem nome";

    const error = textField(thinker.error, "thinker.error");
    if (error) {
      lines.push(`- ${angle}: falhou — ${oneLine(error, 200)}`);
      continue;
    }

    const thinking = textField(thinker.thinking, "thinker.thinking");
    if (!thinking) continue;
    lines.push(`- ${angle}: ${oneLine(thinking, THINKER_EXCERPT_CHARS)}`);
  }

  if (lines.length === 0) return "";
  return `Ângulos da rodada de pensamento profundo:\n${lines.join("\n")}`;
}

/**
 * Turn a finished round into memory.
 *
 * Exported for the tests and for any caller holding the event already; the boot
 * path should use `attachDeepThinkToMemory` instead of wiring this by hand.
 *
 * Nothing is awaited before the write is queued, so two events emitted back to
 * back reach the file in the order they were emitted — `appendMemoryEvents`
 * serialises per conversation from the moment it is called.
 *
 * Cannot reject, for either caller: the whole body is guarded, not just the
 * write. See the top of this file for why that is the difference between a
 * dropped reflection and a dead process.
 */
export async function recordDeepThinkEvent(event: DeepThinkEvent): Promise<void> {
  // Held outside the try so the catch never has to touch `event` again: `event`
  // is the thing that may be malformed, and a throw from inside the handler
  // would escape the very guard the handler exists to be.
  let jobId = "?";

  try {
    // An activity line is progress, not a conclusion, and an errored round has
    // no conclusion to keep. Only `done` carries a synthesis.
    if (event.type !== "deep_think_done") return;

    // A replay is the same round re-sent to a browser that reconnected. It was
    // already recorded when it first finished; writing it again would put the
    // same reflection in the file twice and double its weight in the resume.
    if (event.replay) return;

    jobId = String(event.job_id);
    if (recordedJobs.has(jobId)) return;

    // The event carries `job_id`, not the conversation — the job registry is the
    // only place the two are tied together. Read synchronously, while the round
    // that emitted this is still registered.
    const job = getDeepThinkJob(jobId);
    if (!job) {
      console.warn(
        `[memory-recorder] deep-think job ${jobId} is gone; its reflection has no conversation to belong to`,
      );
      return;
    }

    const events: MemoryEventInput[] = [];
    const meta = { source: "deep_think", job_id: jobId };

    const synthesis = textField(event.synthesis, "synthesis");
    if (synthesis) events.push({ kind: "reflection", text: synthesis, meta });

    const digest = thinkerDigest(listField(event.thinkers, "thinkers"));
    if (digest) events.push({ kind: "note", text: digest, meta });

    // Claimed *before* the write and released after a failed one, rather than
    // simply marked after a successful one. Two copies of the same event emitted
    // back to back both run this whole body before either write resolves, so
    // marking only on success would let the second one through and write the
    // round twice; marking unconditionally would burn the id on a failed write
    // and lose the reflection for good, since nothing retries it.
    remember(jobId);
    const recorded = await write(
      job.conversation_id,
      events,
      `deep-think round ${jobId}`,
    );
    if (!recorded) recordedJobs.delete(jobId);
  } catch (err) {
    console.warn(
      `[memory-recorder] could not record deep-think round ${jobId}:`,
      message(err),
    );
  }
}

/** The live subscription, so a second `attach` is a no-op instead of a duplicate. */
let detach: (() => void) | null = null;

/**
 * Wire deep-think's reflections into the conversation file. Call once, at boot.
 *
 * Returns the unsubscribe function. Calling it twice returns the same one rather
 * than adding a second listener — two listeners would write every synthesis
 * twice, and the second write is indistinguishable from a genuine second round
 * once it is on disk.
 */
export function attachDeepThinkToMemory(): () => void {
  if (detach) return detach;

  const unsubscribe = subscribeDeepThink((event) => {
    // Fire and forget: the emitter is inside deep-think's own `finish`, and a
    // disk write is not something a finishing round should wait on.
    //
    // `void` is only safe because `recordDeepThinkEvent` guards its entire body.
    // A rejection here would be unhandled, and Node's default
    // `--unhandled-rejections=throw` would take the backend down over a
    // malformed field in an event the conversation does not depend on.
    void recordDeepThinkEvent(event);
  });

  const stop = (): void => {
    // Idempotent, and inert once a later `attach` has replaced it.
    if (detach !== stop) return;
    detach = null;
    unsubscribe();
  };

  detach = stop;
  return stop;
}
