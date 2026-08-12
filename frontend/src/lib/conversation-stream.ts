import type {
  FloorRequest,
  FloorSnapshot,
  LiveEvent,
  LiveMessage,
  LivePresenceEvent,
  LiveToolFinished,
  Message,
  TranscriptEntry,
} from "@/types";

// ---------------------------------------------------------------------------
// The shared conversation, as the browser reads it
// ---------------------------------------------------------------------------
//
// `GET /api/conversations/:id/live` broadcasts everything one person causes to
// be written so the other screen shows it without a reload. This module is the
// parsing and the decisions; `hooks/useConversationStream.ts` is the socket.
//
// **THE INVARIANT: nothing here ever reaches the model.** No `send`, no
// `requestResponse`, no `userTextEvent` — not in this file and not in the hook
// above it. The stream is a broadcast of turns that already happened, so a
// `message.appended` folded back into the session as an injected turn would make
// the assistant narrate the sentence it just finished saying, on every screen,
// and bill for the audio. On the server the guarantee is structural: `live.ts`
// imports nothing that can talk to the model. Here it is a rule with two tests
// behind it — one reads this source for those identifiers, the other drives
// every event type through `liveStreamHandler` with the forbidden calls lent to
// it as spies and asserts they stay untouched.
//
// The other stream is not this one. `GET /api/agents/events` carries pi jobs and
// deliberation rounds, and it *does* feed the model — a non-replay
// `deep_think_done` becomes a conversation item plus a `response.create`. The
// two look alike and mean opposite things.
//
// Everything below is exported and pure because this suite has no jsdom: a React
// hook cannot be rendered here, so the alternative to a seam like this is not
// testing the decisions at all.

/**
 * How long a pending request to speak stays on screen.
 *
 * Mirrors `FLOOR_REQUEST_TTL_MS` in `backend/src/services/floor.ts`, which drops
 * the slot on read after the same window. Without a matching timer here the card
 * would outlive the request the server has already forgotten, and the holder
 * would be looking at a question nobody is still waiting on.
 */
export const FLOOR_REQUEST_TTL_MS = 30_000;

// ---------------------------------------------------------------------------
// Who this browser is
// ---------------------------------------------------------------------------

export const CLIENT_ID_KEY = "explainer.client_id";
export const CLIENT_NAME_KEY = "explainer.client_name";

/**
 * The id when there is nowhere to keep one. Per process, so it is at least
 * stable for the life of the page.
 */
let volatileClientId: string | null = null;

function randomClientId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  // Node without `randomUUID`, and any engine that withholds it outside a secure
  // context. Uniqueness across two browsers is all this identifier needs.
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function readStored(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    // Safari in private mode throws on access rather than answering null, and
    // this suite runs on plain Node where there is no `localStorage` at all.
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    /* see readStored — an unwritable store is not a reason to fail */
  }
}

/**
 * This browser's identity, minted once and kept.
 *
 * The floor is held by a *browser*, not by a session: the holder's `/live`
 * stream is its heartbeat and the server gives it a grace window to reconnect
 * within. A page that came back with a fresh id would be a different client to
 * the server, so it would find its own microphone taken — by itself — for the
 * length of that window.
 */
export function browserClientId(): string {
  const stored = readStored(CLIENT_ID_KEY);
  if (stored) return stored;

  const minted = volatileClientId ?? randomClientId();
  volatileClientId = minted;
  writeStored(CLIENT_ID_KEY, minted);
  return minted;
}

/** What the other screen calls this one. The server's own fallback, mirrored. */
export function browserClientName(): string {
  return readStored(CLIENT_NAME_KEY) ?? "Alguém";
}

export function setBrowserClientName(name: string): void {
  writeStored(CLIENT_NAME_KEY, name.trim().slice(0, 60));
}

// ---------------------------------------------------------------------------
// Reading the wire
// ---------------------------------------------------------------------------
//
// The stream is a network boundary: `@/types` describes what the server *means*
// to send and guarantees nothing about what arrives. Each frame is rebuilt field
// by field rather than cast, the way the job stream's thinkers are — a poisoned
// field folded into state throws inside a render, and React unmounts the tree
// that threw.

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

/** A holder, or null. Exported because the mint's 409 carries one in its body. */
export function parseFloorSnapshot(value: unknown): FloorSnapshot | null {
  const raw = asRecord(value);
  if (!raw) return null;

  const clientId = asText(raw.client_id);
  if (!clientId) return null;

  return {
    client_id: clientId,
    name: asText(raw.name) ?? "Alguém",
    since: asText(raw.since) ?? "",
  };
}

export function parseFloorRequest(value: unknown): FloorRequest | null {
  const raw = asRecord(value);
  if (!raw) return null;

  const clientId = asText(raw.client_id);
  if (!clientId) return null;
  return { client_id: clientId, name: asText(raw.name) ?? "Alguém" };
}

function parseLiveMessages(value: unknown): LiveMessage[] {
  if (!Array.isArray(value)) return [];

  const messages: LiveMessage[] = [];
  for (const candidate of value) {
    const raw = asRecord(candidate);
    if (!raw) continue;
    const id = asText(raw.id);
    const role = asText(raw.role);
    if (!id || !role) continue;
    messages.push({
      id,
      role,
      content: asText(raw.content),
      timestamp: asText(raw.timestamp) ?? "",
    });
  }
  return messages;
}

/**
 * One SSE frame as an event, or null when it is not one we know.
 *
 * Null rather than a throw, and null rather than a partial event: an unknown
 * frame is a deploy skew, and the right answer to one is to draw nothing.
 */
export function parseLiveEvent(raw: string): LiveEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const event = asRecord(parsed);
  if (!event) return null;

  switch (event.type) {
    case "message.appended": {
      const messages = parseLiveMessages(event.messages);
      return messages.length > 0 ? { type: "message.appended", messages } : null;
    }
    case "tool.finished": {
      const name = asText(event.name);
      if (!name) return null;
      return {
        type: "tool.finished",
        call_id: asText(event.call_id),
        name,
        output: asText(event.output) ?? "",
        meta: asRecord(event.meta),
      };
    }
    case "memory.changed":
      return { type: "memory.changed", event_count: asCount(event.event_count) };
    case "presence.changed":
      return {
        type: "presence.changed",
        viewers: asCount(event.viewers),
        floor: parseFloorSnapshot(event.floor),
      };
    case "floor.changed":
      return {
        type: "floor.changed",
        holder: asText(event.holder),
        name: asText(event.name),
      };
    case "floor.requested": {
      const request = parseFloorRequest(event);
      return request
        ? { type: "floor.requested", client_id: request.client_id, name: request.name }
        : null;
    }
    case "document.changed":
      // An empty document is a real state — the user cleared it, or the model
      // deleted it — so `content` is only rejected when it is not a string at
      // all. `asText` answers null on an empty string, which would turn a clear
      // into a frame the panel silently ignores.
      if (typeof event.content !== "string") return null;
      return {
        type: "document.changed",
        content: event.content,
        source: event.source === "assistant" ? "assistant" : "user",
      };
    case "history.reset":
      return { type: "history.reset", since: asCount(event.since) };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Presence and the floor
// ---------------------------------------------------------------------------

export interface LivePresence {
  /** How many streams are open on this conversation, this browser included. */
  viewers: number;
  floor: FloorSnapshot | null;
  /** The last viewer who asked the holder for the microphone. */
  request: FloorRequest | null;
}

export const NO_PRESENCE: LivePresence = { viewers: 0, floor: null, request: null };

/**
 * Fold one presence frame into what the screen believes.
 *
 * `floor.changed` names a holder but carries no `since` — the server sends the
 * change, not the whole snapshot. Keeping the previous `since` when the holder
 * is unchanged is what stops a re-claim (which a reconnect makes) from resetting
 * the clock the UI counts from.
 *
 * A release clears the pending request as well, because the server does: the
 * question "can I have the microphone?" is answered by the microphone being free.
 */
export function applyPresenceEvent(
  presence: LivePresence,
  event: LivePresenceEvent,
  at: string,
): LivePresence {
  switch (event.type) {
    case "presence.changed":
      return { ...presence, viewers: event.viewers, floor: event.floor };

    case "floor.changed": {
      if (!event.holder) return { ...presence, floor: null, request: null };
      const same = presence.floor?.client_id === event.holder;
      return {
        ...presence,
        floor: {
          client_id: event.holder,
          name: event.name ?? presence.floor?.name ?? "Alguém",
          since: same ? (presence.floor?.since ?? at) : at,
        },
        request: null,
      };
    }

    case "floor.requested":
      return {
        ...presence,
        request: { client_id: event.client_id, name: event.name },
      };
  }
}

// ---------------------------------------------------------------------------
// Turns and tool results, as transcript lines
// ---------------------------------------------------------------------------

/** Tool output is for the model, not the sidebar — show just enough to trust it. */
export function summarizeToolOutput(output: string): string {
  const firstLine = output.split("\n").find((line) => line.trim().length > 0) ?? "";
  return firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine;
}

const WIRE_ROLES: ReadonlySet<string> = new Set(["user", "assistant", "tool"]);

/**
 * A persisted turn as a line on screen, or null when the role is not one of ours.
 *
 * An unrecognised role is dropped rather than defaulted: every default would
 * draw the line as somebody, and drawing an unknown speaker as the assistant is
 * how a transcript starts attributing words the model never said.
 */
export function entryFromMessage(
  message: LiveMessage | Message,
  at: string,
): TranscriptEntry | null {
  if (!WIRE_ROLES.has(message.role)) return null;

  const text = message.content ?? "";
  if (!text.trim()) return null;

  return {
    id: message.id,
    role: message.role as TranscriptEntry["role"],
    text,
    // It reached disk, so it is over. Nothing streams into a line that arrived
    // through this route.
    final: true,
    timestamp: message.timestamp || at,
  };
}

export function entriesFromMessages(
  messages: ReadonlyArray<LiveMessage | Message>,
  at: string,
): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const message of messages) {
    const entry = entryFromMessage(message, at);
    if (entry) entries.push(entry);
  }
  return entries;
}

/**
 * A finished tool call as the line the other screen shows.
 *
 * Keyed `tool-<call_id>`, which is exactly the key the browser that *made* the
 * call already drew — so the echo of one's own tool call merges into the line
 * that is already there instead of appearing beneath it.
 *
 * Null when the frame carries no `call_id`: there is then nothing to key on, and
 * a synthetic key would let the same result land twice the moment anything
 * re-delivered the frame.
 */
export function entryFromToolFinished(
  event: LiveToolFinished,
  at: string,
): TranscriptEntry | null {
  if (!event.call_id) return null;
  return {
    id: `tool-${event.call_id}`,
    role: "tool",
    text: `${event.name} — ${summarizeToolOutput(event.output)}`,
    final: true,
    timestamp: at,
  };
}

/**
 * Add what the server broadcast, and only what this screen does not already have.
 *
 * Insert-if-missing rather than upsert, and that is the decision. The browser
 * driving the call already drew every one of these lines from its own data
 * channel, under the same ids — `persistTurn` sends them, which is the whole
 * reason it sends an id at all. Rewriting them from the echo would replace the
 * text the user is looking at with the archived form of it: an agent's answer
 * would sprout the `[agente pi]` prefix the archive carries, mid-conversation,
 * for no reason a viewer could understand.
 *
 * Returns the same array when there is nothing to add, so a `presence.changed`
 * storm cannot re-render the transcript.
 *
 * The result is ordered by timestamp. Live lines are stamped in the order they
 * happen, so they are already sorted; a batch fetched over REST after a
 * `history.reset` is not, and appending it blindly would drop last week's turns
 * underneath today's. An unparseable stamp inherits the last good one rather
 * than sorting to the front, which is where `NaN` would otherwise put it.
 */
export function mergeRemoteEntries(
  transcript: readonly TranscriptEntry[],
  incoming: readonly TranscriptEntry[],
): TranscriptEntry[] {
  const known = new Set(transcript.map((entry) => entry.id));
  const fresh = incoming.filter((entry) => !known.has(entry.id));
  if (fresh.length === 0) return transcript as TranscriptEntry[];

  const merged = [...transcript, ...fresh];
  let last = 0;
  const keys = merged.map((entry) => {
    const parsed = Date.parse(entry.timestamp);
    if (Number.isFinite(parsed)) last = parsed;
    return last;
  });

  return merged
    .map((entry, index) => ({ entry, key: keys[index]!, index }))
    .sort((a, b) => a.key - b.key || a.index - b.index)
    .map((item) => item.entry);
}

// ---------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------

/**
 * Everything the live stream is allowed to do.
 *
 * The absence is the point: there is no `send` and no `requestResponse` in this
 * interface, so no handler below can reach the model even by accident. Compare
 * `SessionStreamDeps` in `useRealtimeSession`, which has both — because the job
 * stream really does have to make the model speak.
 */
export interface LiveStreamDeps {
  /** Turns that reached disk, from any screen. Rendered, never spoken. */
  onMessages: (messages: LiveMessage[]) => void;
  onToolFinished: (event: LiveToolFinished) => void;
  onMemoryChanged: (eventCount: number) => void;
  /**
   * The document changed somewhere. Carries who wrote it so the panel can leave
   * the user's own keystrokes alone: the echo of a save this browser just made
   * arrives here too.
   */
  onDocumentChanged: (content: string, source: "user" | "assistant") => void;
  onPresence: (event: LivePresenceEvent) => void;
  /**
   * The gap is not reconstructible and the transcript on screen may be missing
   * turns. The only fix is to fetch the conversation again.
   */
  onReset: (since: number) => void;
}

export function liveStreamHandler(deps: LiveStreamDeps): (raw: string) => void {
  return (raw: string) => {
    const event = parseLiveEvent(raw);
    if (!event) return;

    switch (event.type) {
      case "message.appended":
        deps.onMessages(event.messages);
        return;
      case "tool.finished":
        deps.onToolFinished(event);
        return;
      case "memory.changed":
        deps.onMemoryChanged(event.event_count);
        return;
      case "document.changed":
        deps.onDocumentChanged(event.content, event.source);
        return;
      case "presence.changed":
      case "floor.changed":
      case "floor.requested":
        deps.onPresence(event);
        return;
      case "history.reset":
        deps.onReset(event.since);
        return;
    }
  };
}
