import { publish, type FloorSnapshot } from "./conversation-bus.js";

// ---------------------------------------------------------------------------
// One microphone per conversation
// ---------------------------------------------------------------------------
//
// Two people watching the same conversation is fine; two people *speaking* into
// it is not. The Realtime API refuses a second response on a conversation that
// already has one running ("Conversation already has an active response in
// progress"), and the two sessions would in any case be writing turns into the
// same file from two different microphones.
//
// So the right to talk is a token — the floor — and exactly one client holds it.
// The enforcement point is `POST /api/realtime/session`: it is the only step of
// the WebRTC handshake that goes through this server, so refusing to mint there
// is the only refusal a browser cannot route around. Everything else in this
// module is bookkeeping to make that one gate answer correctly.
//
// There is deliberately no forced take-over. The holder is mid-sentence; a
// second person cutting their session off remotely is a worse failure than
// waiting. A viewer asks (`floor.requested`) and the holder decides.

/**
 * How long the floor survives without a `/live` connection behind it.
 *
 * The holder's SSE stream *is* the heartbeat — a browser that is closed, locked
 * or driven into a tunnel stops it within seconds, and nothing else the client
 * does is as reliable a sign of being gone. The window is generous enough to
 * cover an `EventSource` reconnect (which retries after ~3 s, see the `retry:`
 * line in `routes/live.ts`) and short enough that a closed laptop does not hold
 * the microphone hostage.
 */
export const FLOOR_GRACE_MS = 15_000;

/** How long a pending request to speak stays interesting. */
export const FLOOR_REQUEST_TTL_MS = 30_000;

/**
 * Both windows are read at call time so a test does not have to wait fifteen
 * real seconds to watch an abandoned floor release itself — the same reason
 * `PI_TIMEOUT_MS` and `EXPLAINER_MEMORY_SUMMARY_TIMEOUT_MS` are read where they
 * are used rather than frozen at import.
 */
function envMs(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

function graceMs(): number {
  return envMs("EXPLAINER_FLOOR_GRACE_MS", FLOOR_GRACE_MS);
}

function requestTtlMs(): number {
  return envMs("EXPLAINER_FLOOR_REQUEST_TTL_MS", FLOOR_REQUEST_TTL_MS);
}

const MAX_NAME_CHARS = 60;
const MAX_CLIENT_ID_CHARS = 100;

interface Holder {
  clientId: string;
  name: string;
  since: string;
  /** Open `/live` streams belonging to this client. Zero starts the clock. */
  connections: number;
  /** Last moment a stream of this client's was open, in ms. */
  lastSeen: number;
  graceTimer: NodeJS.Timeout | null;
}

interface PendingRequest {
  clientId: string;
  name: string;
  at: number;
}

const holders = new Map<string, Holder>();
const requests = new Map<string, PendingRequest>();

function snapshot(holder: Holder): FloorSnapshot {
  return { client_id: holder.clientId, name: holder.name, since: holder.since };
}

function announce(conversationId: string, holder: Holder | null): void {
  publish(conversationId, {
    type: "floor.changed",
    holder: holder?.clientId ?? null,
    name: holder?.name ?? null,
  });
}

function disarm(holder: Holder): void {
  if (!holder.graceTimer) return;
  clearTimeout(holder.graceTimer);
  holder.graceTimer = null;
}

/**
 * Start the countdown to an automatic release.
 *
 * Armed both when the holder's last stream closes and when the floor is claimed
 * by a client that has not opened one yet: a claim that never gets a heartbeat
 * behind it is indistinguishable from a client that vanished right after making
 * it, and neither should keep the microphone.
 */
function arm(conversationId: string, holder: Holder): void {
  disarm(holder);
  const timer = setTimeout(() => {
    holder.graceTimer = null;
    if (holders.get(conversationId) !== holder) return;
    if (holder.connections > 0) return;
    holders.delete(conversationId);
    announce(conversationId, null);
  }, graceMs());
  timer.unref();
  holder.graceTimer = timer;
}

/**
 * Release a holder whose grace window has already elapsed.
 *
 * The timer above normally does this, but a read must not be able to see a
 * holder the clock has already expired — an event loop blocked past the deadline
 * would otherwise hand out a 409 on behalf of somebody who is gone.
 */
function expireIfStale(conversationId: string): void {
  const holder = holders.get(conversationId);
  if (!holder || holder.connections > 0) return;
  if (Date.now() - holder.lastSeen < graceMs()) return;
  disarm(holder);
  holders.delete(conversationId);
  announce(conversationId, null);
}

export function normalizeName(raw: unknown, fallback = "Alguém"): string {
  if (typeof raw !== "string") return fallback;
  const clean = raw.replace(/\s+/g, " ").trim().slice(0, MAX_NAME_CHARS);
  return clean.length > 0 ? clean : fallback;
}

export function normalizeClientId(raw: unknown): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return null;
  const clean = value.trim().slice(0, MAX_CLIENT_ID_CHARS);
  return clean.length > 0 ? clean : null;
}

/** Who holds the microphone right now, or null. */
export function getFloor(conversationId: string): FloorSnapshot | null {
  expireIfStale(conversationId);
  const holder = holders.get(conversationId);
  return holder ? snapshot(holder) : null;
}

/** Whether this client may open a realtime session on this conversation. */
export function holdsFloor(conversationId: string, clientId: string | null): boolean {
  if (!clientId) return false;
  return getFloor(conversationId)?.client_id === clientId;
}

export type ClaimResult =
  | { ok: true; floor: FloorSnapshot; alreadyMine: boolean }
  | { ok: false; floor: FloorSnapshot };

/**
 * Take the microphone, or be told who has it.
 *
 * Claiming what you already hold succeeds and emits nothing: a client that
 * reconnects and re-claims should not make every other screen redraw.
 */
export function claimFloor(
  conversationId: string,
  clientId: string,
  name: string,
): ClaimResult {
  expireIfStale(conversationId);
  const current = holders.get(conversationId);

  if (current && current.clientId !== clientId) {
    return { ok: false, floor: snapshot(current) };
  }

  if (current) {
    current.name = name;
    current.lastSeen = Date.now();
    return { ok: true, floor: snapshot(current), alreadyMine: true };
  }

  const holder: Holder = {
    clientId,
    name,
    since: new Date().toISOString(),
    connections: connectionCount(conversationId, clientId),
    lastSeen: Date.now(),
    graceTimer: null,
  };
  holders.set(conversationId, holder);
  if (holder.connections === 0) arm(conversationId, holder);

  // The request slot is about *this* microphone; whoever was waiting for it is
  // answered by the change of holder, not by a stale request card.
  requests.delete(conversationId);

  announce(conversationId, holder);
  return { ok: true, floor: snapshot(holder), alreadyMine: false };
}

/** Give the microphone back. Only the holder can. */
export function releaseFloor(conversationId: string, clientId: string): boolean {
  const holder = holders.get(conversationId);
  if (!holder || holder.clientId !== clientId) return false;
  disarm(holder);
  holders.delete(conversationId);
  requests.delete(conversationId);
  announce(conversationId, null);
  return true;
}

// ---------------------------------------------------------------------------
// The heartbeat: open `/live` streams
// ---------------------------------------------------------------------------
//
// Counted rather than flagged, because one person legitimately has the same
// conversation open in two tabs and the floor must survive closing one of them.

const connections = new Map<string, Map<string, number>>();

function connectionCount(conversationId: string, clientId: string): number {
  return connections.get(conversationId)?.get(clientId) ?? 0;
}

export function connectionOpened(conversationId: string, clientId: string | null): void {
  if (!clientId) return;
  const byClient = connections.get(conversationId) ?? new Map<string, number>();
  byClient.set(clientId, (byClient.get(clientId) ?? 0) + 1);
  connections.set(conversationId, byClient);

  const holder = holders.get(conversationId);
  if (holder?.clientId !== clientId) return;
  holder.connections = byClient.get(clientId) ?? 1;
  holder.lastSeen = Date.now();
  disarm(holder);
}

export function connectionClosed(conversationId: string, clientId: string | null): void {
  if (!clientId) return;
  const byClient = connections.get(conversationId);
  const left = (byClient?.get(clientId) ?? 0) - 1;
  if (byClient) {
    if (left > 0) byClient.set(clientId, left);
    else byClient.delete(clientId);
    if (byClient.size === 0) connections.delete(conversationId);
  }

  const holder = holders.get(conversationId);
  if (holder?.clientId !== clientId) return;
  holder.connections = Math.max(0, left);
  holder.lastSeen = Date.now();
  if (holder.connections === 0) arm(conversationId, holder);
}

// ---------------------------------------------------------------------------
// Asking for the microphone
// ---------------------------------------------------------------------------

export interface FloorRequest {
  client_id: string;
  name: string;
}

/**
 * Ask the holder to hand the microphone over.
 *
 * One slot per conversation: two people asking at once is a conversation
 * problem, not a queueing problem, and a queue would only let the holder grant
 * the floor to someone who has since stopped caring. The last asker wins, and
 * the slot goes stale after {@link FLOOR_REQUEST_TTL_MS}.
 */
export function requestFloor(
  conversationId: string,
  clientId: string,
  name: string,
): FloorRequest {
  requests.set(conversationId, { clientId, name, at: Date.now() });
  publish(conversationId, { type: "floor.requested", client_id: clientId, name });
  return { client_id: clientId, name };
}

export function getFloorRequest(conversationId: string): FloorRequest | null {
  const pending = requests.get(conversationId);
  if (!pending) return null;
  if (Date.now() - pending.at > requestTtlMs()) {
    requests.delete(conversationId);
    return null;
  }
  return { client_id: pending.clientId, name: pending.name };
}

/** Drop everything held for one conversation. Used when it is deleted. */
export function forgetFloor(conversationId: string): void {
  const holder = holders.get(conversationId);
  if (holder) disarm(holder);
  holders.delete(conversationId);
  requests.delete(conversationId);
  connections.delete(conversationId);
}
