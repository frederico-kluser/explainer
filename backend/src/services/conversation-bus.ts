import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// The shared-conversation bus
// ---------------------------------------------------------------------------
//
// Two people can have the same conversation open. Everything one of them causes
// to be written — a spoken turn, a tool result, a diagram, a change of who holds
// the microphone — has to show up on the other screen without a reload. This
// module is the fan-out that makes that true, and `routes/live.ts` is its only
// wire.
//
// It is deliberately a *broadcast of things that already happened*, never an
// input. Nothing published here is fed back into the realtime model: the bus has
// no channel to the model and no caller that could give it one, which is why the
// spectator cannot make the assistant speak. See the invariant comment in
// `routes/live.ts`.
//
// Why a ring buffer and not just an emitter: a phone that locks its screen drops
// the SSE connection, and `EventSource` reconnects with `Last-Event-ID` set to
// the last `id:` it saw. Replaying `seq > since` from the buffer is what turns a
// tunnel, a lock screen or a wifi handover into a gap of nothing rather than a
// silently divergent transcript.

/** Events per conversation kept for replay. ~500 covers a long call. */
const RING_CAPACITY = 500;

/** How long changes to the memory file are pooled before one event is sent. */
const MEMORY_COALESCE_MS = 2_000;

/**
 * Identifies this process in every `id:` line.
 *
 * `seq` is a counter in memory, so a restart hands out numbers that were already
 * used. Without the epoch a client reconnecting with `Last-Event-ID: 3` would be
 * replayed the *new* events 4 and 5 as if they continued the old ones. With it,
 * a mismatched epoch is a reset — the client refetches the conversation instead
 * of stitching two different histories together.
 */
const EPOCH = randomBytes(4).toString("hex");

export interface LiveMessage {
  id: string;
  role: string;
  content: string | null;
  timestamp: string;
}

/** The holder of the microphone, as the wire carries it. */
export interface FloorSnapshot {
  client_id: string;
  name: string;
  since: string;
}

export type LiveEvent =
  /** A turn reached disk. Emitted after `appendMessages` resolves, never before. */
  | { type: "message.appended"; messages: LiveMessage[] }
  /**
   * A tool the model called finished. A generated diagram rides in
   * `meta.diagram` rather than getting an event of its own — it is produced by a
   * tool call and nothing else, so a second event would only be a second way for
   * the two to disagree.
   */
  | {
      type: "tool.finished";
      call_id: string | null;
      name: string;
      output: string;
      meta: Record<string, unknown> | null;
    }
  /** The memory file grew or was replaced. Coalesced; see `noteMemoryChanged`. */
  | { type: "memory.changed"; event_count: number }
  /** Someone opened or closed the conversation. */
  | { type: "presence.changed"; viewers: number; floor: FloorSnapshot | null }
  /** The microphone changed hands, was taken or was let go. */
  | { type: "floor.changed"; holder: string | null; name: string | null }
  /** A viewer asked the holder for the microphone. */
  | { type: "floor.requested"; client_id: string; name: string }
  /** The collaborative document was written, by either the user or the model. */
  | { type: "document.changed"; content: string; source: "user" | "assistant" };

/** A published event, with the sequence number its `id:` line carries. */
export interface BufferedEvent {
  seq: number;
  event: LiveEvent;
}

const bus = new EventEmitter();
// One listener per open `/live` connection, and two phones plus a laptop on the
// same conversation already beat the default cap of 10.
bus.setMaxListeners(0);

const buffers = new Map<string, BufferedEvent[]>();

/**
 * Process-wide and never reset, so a number is never reused across
 * conversations. A stale `Last-Event-ID` from another conversation therefore
 * cannot silently address a real event in this one.
 */
let seq = 0;

export function publish(conversationId: string, event: LiveEvent): BufferedEvent {
  seq += 1;
  const buffered: BufferedEvent = { seq, event };

  const buffer = buffers.get(conversationId) ?? [];
  buffer.push(buffered);
  if (buffer.length > RING_CAPACITY) buffer.splice(0, buffer.length - RING_CAPACITY);
  buffers.set(conversationId, buffer);

  bus.emit("event", conversationId, buffered);
  return buffered;
}

export function subscribe(
  conversationId: string,
  listener: (buffered: BufferedEvent) => void,
): () => void {
  const wrapped = (id: string, buffered: BufferedEvent): void => {
    if (id !== conversationId) return;
    listener(buffered);
  };
  bus.on("event", wrapped);
  return () => bus.off("event", wrapped);
}

/** The `id:` line for an event: epoch and sequence, so a restart is detectable. */
export function wireId(buffered: BufferedEvent): string {
  return `${EPOCH}.${buffered.seq}`;
}

/**
 * What a reconnecting client claims to have already seen.
 *
 * Accepts both the `<epoch>.<seq>` form this server writes and a bare number, so
 * `?since=` stays usable from curl and from a client that is not an
 * `EventSource`. A bare number is trusted to belong to this epoch — it can only
 * come from a caller that chose to type it.
 */
export function parseSince(raw: unknown): { seq: number; foreignEpoch: boolean } {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || value.length === 0) {
    return { seq: 0, foreignEpoch: false };
  }

  const dot = value.indexOf(".");
  if (dot === -1) {
    const bare = Number(value);
    return {
      seq: Number.isFinite(bare) && bare > 0 ? Math.floor(bare) : 0,
      foreignEpoch: false,
    };
  }

  const epoch = value.slice(0, dot);
  const parsed = Number(value.slice(dot + 1));
  if (epoch !== EPOCH) return { seq: 0, foreignEpoch: true };
  return {
    seq: Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0,
    foreignEpoch: false,
  };
}

export interface ReplaySlice {
  /**
   * True when the gap cannot be filled from the buffer, so the client has to
   * refetch the conversation. Silence would be worse: the client would carry on
   * believing its transcript is complete.
   */
  reset: boolean;
  events: BufferedEvent[];
}

/**
 * Everything published to a conversation after `since`.
 *
 * `since <= 0` is a first connection, not a gap: the client has just fetched the
 * conversation over REST and replaying the buffer on top would duplicate every
 * message in it. It gets the live stream from here on, and the `presence.changed`
 * the route publishes on open gives it a sequence number to reconnect from.
 */
export function replaySince(conversationId: string, since: number): ReplaySlice {
  if (since <= 0) return { reset: false, events: [] };

  const buffer = buffers.get(conversationId) ?? [];
  const floor = buffer[0]?.seq;

  // No buffer at all, yet the client holds a sequence number from one: the
  // process restarted, or this conversation was pruned. Either way its history
  // is not reconstructible from here.
  if (floor === undefined) return { reset: true, events: [] };

  // The oldest event still held is newer than the last one the client saw, so
  // whatever fell out of the ring in between is lost.
  if (floor > since + 1) return { reset: true, events: [] };

  return { reset: false, events: buffer.filter((item) => item.seq > since) };
}

// ---------------------------------------------------------------------------
// memory.changed, pooled
// ---------------------------------------------------------------------------
//
// One spoken turn writes to the memory file two to four times (the turn itself,
// then a tool call and its result). A `memory.changed` per write would be three
// events saying the same thing, each costing a disk read to count. The pool
// collapses a burst into one event carrying the count as it ended up.

const memoryTimers = new Map<string, NodeJS.Timeout>();

export function noteMemoryChanged(conversationId: string): void {
  if (memoryTimers.has(conversationId)) return;

  const timer = setTimeout(() => {
    memoryTimers.delete(conversationId);
    void flushMemoryChanged(conversationId);
  }, MEMORY_COALESCE_MS);

  // A pending notification must never be the reason a process stays alive — not
  // the server on shutdown, and not the test runner between files.
  timer.unref();
  memoryTimers.set(conversationId, timer);
}

/**
 * Broadcast a document change immediately — never pooled, because writes are
 * already debounced client-side and are rare from the model.
 */
export function noteDocumentChanged(
  conversationId: string,
  content: string,
  source: "user" | "assistant",
): void {
  publish(conversationId, { type: "document.changed", content, source });
}

async function flushMemoryChanged(conversationId: string): Promise<void> {
  try {
    // Imported here rather than at the top of the file so that opening a `/live`
    // stream does not pull the memory module — and, through it, the summariser
    // and its API-key reads — into the connect path. This is the only line in
    // this module that touches the disk, and it only ever reads.
    const { readMemory } = await import("./memory.js");
    const file = await readMemory(conversationId);
    publish(conversationId, {
      type: "memory.changed",
      event_count: file?.events.length ?? 0,
    });
  } catch {
    // A conversation whose memory cannot be read is not a reason to break the
    // stream for everyone watching it.
  }
}

/** Drop everything held for one conversation. Used when it is deleted. */
export function forgetConversation(conversationId: string): void {
  buffers.delete(conversationId);
  const timer = memoryTimers.get(conversationId);
  if (timer) {
    clearTimeout(timer);
    memoryTimers.delete(conversationId);
  }
}
