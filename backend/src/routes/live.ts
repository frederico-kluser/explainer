import { Router } from "express";

import {
  parseSince,
  publish,
  replaySince,
  subscribe,
  wireId,
  type BufferedEvent,
} from "../services/conversation-bus.js";
import {
  claimFloor,
  connectionClosed,
  connectionOpened,
  getFloor,
  getFloorRequest,
  normalizeClientId,
  normalizeName,
  releaseFloor,
  requestFloor,
} from "../services/floor.js";
import { isUUID } from "../middleware/sandbox.js";

// ---------------------------------------------------------------------------
// /api/conversations/:id/live — the shared conversation, as it happens
// ---------------------------------------------------------------------------
//
// Mounted on the same prefix as `conversations.ts`, for the same reason
// `memory.ts` is: what is being addressed is a conversation. `/:id` in that
// router never matches `/:id/live`, so mount order is free.
//
// **THE INVARIANT: this stream never feeds the model.** It is an outbound
// broadcast of things that were already written, and it holds no channel back
// into the realtime session — no `response.create`, no conversation item, no
// call to `openai.ts` or the tool executor, directly or through the bus. A
// spectator therefore cannot make the assistant speak, and reconnecting cannot
// make it narrate an old turn. That is a stronger guarantee than the `replay`
// flag `/api/agents/events` needs, and it is stronger because it is structural:
// there is nowhere for this code to talk to. `conversation-live-sse.test.ts`
// asserts it rather than trusting this comment.
//
// This is a *new* route rather than a reuse of `/api/agents/events`, which is
// per realtime session and is only opened from inside `connect()`: a spectator
// never connects a session, its client handler drops any frame without a
// `job_id`, and it emits no `id:` line at all — so `Last-Event-ID` could not
// work there. What is reused is the discipline: replay and subscribe inside one
// synchronous block, a keep-alive, and `X-Accel-Buffering: no`.
//
// Deep-think and pi jobs are deliberately absent here. Both clients already open
// `/api/agents/events`, which filters by conversation, and a second copy on this
// stream would be a second chance for the two to disagree.
//
// Every path in this file contains `:`, so no handler may be annotated
// `(req: Request, res: Response)` — Express 5 discards the route-string
// inference when it is, and `req.params.id` widens to `string | string[]`.

const router = Router();

/** Open `/live` streams per conversation, for `presence.changed`. */
const viewers = new Map<string, number>();

function viewerCount(conversationId: string): number {
  return viewers.get(conversationId) ?? 0;
}

function announcePresence(conversationId: string): void {
  publish(conversationId, {
    type: "presence.changed",
    viewers: viewerCount(conversationId),
    floor: getFloor(conversationId),
  });
}

function badRequest(message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = 400;
  return err;
}

function validateUUID(id: string): void {
  if (!isUUID(id)) throw badRequest(`Invalid conversation ID: ${id}`);
}

/** `client_id` from wherever this verb can carry it: body first, then query. */
function clientIdOf(req: {
  body?: unknown;
  query: Record<string, unknown>;
}): string | null {
  const body = (req.body ?? {}) as Record<string, unknown>;
  return normalizeClientId(body.client_id) ?? normalizeClientId(req.query.client_id);
}

// GET /api/conversations/:id/live
router.get("/:id/live", (req, res, next) => {
  try {
    validateUUID(req.params.id!);
  } catch (err) {
    next(err);
    return;
  }

  const conversationId = req.params.id!;
  const clientId = normalizeClientId(req.query.client_id);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  // Nginx and friends buffer SSE into uselessness without this.
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const writeFrame = (id: string | null, data: object): void => {
    if (res.writableEnded || res.destroyed) return;
    const head = id === null ? "" : `id: ${id}\n`;
    res.write(`${head}data: ${JSON.stringify(data)}\n\n`);
  };
  const send = (buffered: BufferedEvent): void => {
    writeFrame(wireId(buffered), buffered.event);
  };

  // Reconnect faster than the floor's grace window, so a holder who crosses a
  // dead spot is back before the microphone is taken away from them.
  res.write("retry: 3000\n\n");

  // Everything from here to `subscribe()` is one synchronous block on purpose:
  // an `await` between the replay and the subscription drops whatever is
  // published in the gap, which is exactly the turn a reconnecting client came
  // back for.
  const since = parseSince(req.headers["last-event-id"] ?? req.query.since);
  const slice = replaySince(conversationId, since.seq);

  if (since.foreignEpoch || slice.reset) {
    // The gap is not reconstructible from the ring buffer. Saying so is the
    // point: the client refetches the conversation instead of carrying on with a
    // transcript that is quietly missing turns. No `id:` — this frame is
    // addressed to one client and must not move anyone's cursor.
    writeFrame(null, { type: "history.reset", since: since.seq });
  } else {
    for (const buffered of slice.events) send(buffered);
  }

  const unsubscribe = subscribe(conversationId, send);

  // Proxies drop idle connections; a comment line every 25s keeps this one warm.
  const keepAlive = setInterval(() => {
    if (!res.writableEnded) res.write(": keep-alive\n\n");
  }, 25_000);

  viewers.set(conversationId, viewerCount(conversationId) + 1);
  // The holder's stream is its heartbeat, so this is what stops the floor from
  // being released out from under a client that is plainly still here.
  connectionOpened(conversationId, clientId);
  // Published rather than written straight to this socket: everyone watching
  // needs the new count, and the new client needs a sequence number to
  // reconnect from — without one, a stream that never carried an event would
  // reconnect with no `Last-Event-ID` and silently skip whatever it missed.
  announcePresence(conversationId);

  req.on("close", () => {
    clearInterval(keepAlive);
    unsubscribe();
    const left = viewerCount(conversationId) - 1;
    if (left > 0) viewers.set(conversationId, left);
    else viewers.delete(conversationId);
    connectionClosed(conversationId, clientId);
    announcePresence(conversationId);
    if (!res.writableEnded) res.end();
  });
});

// GET /api/conversations/:id/floor — who has the microphone, and who asked for it
//
// `presence.changed` already carries the holder to everyone on the stream, but
// not the pending request: a client that joins after somebody asked would
// otherwise have no way to learn there is a question waiting, and the 30 s TTL
// on that slot would be a rule nothing ever reads.
router.get("/:id/floor", (req, res, next) => {
  try {
    validateUUID(req.params.id!);
    res.json({
      floor: getFloor(req.params.id!),
      request: getFloorRequest(req.params.id!),
      viewers: viewerCount(req.params.id!),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/conversations/:id/floor — take the microphone
//
// 409 names the holder rather than answering a bare "busy": the caller is a
// person who needs to know whether to wait or to ask.
router.post("/:id/floor", (req, res, next) => {
  try {
    validateUUID(req.params.id!);

    const clientId = clientIdOf(req);
    if (!clientId) throw badRequest('Body must carry a non-empty "client_id"');

    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = claimFloor(req.params.id!, clientId, normalizeName(body.name));

    if (!result.ok) {
      res.status(409).json({
        error: `${result.floor.name} está com o microfone nesta conversa.`,
        floor: result.floor,
      });
      return;
    }

    res.json({ floor: result.floor, already_mine: result.alreadyMine });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/conversations/:id/floor — hand it back
router.delete("/:id/floor", (req, res, next) => {
  try {
    validateUUID(req.params.id!);

    const clientId = clientIdOf(req);
    if (!clientId) throw badRequest('Request must carry a non-empty "client_id"');

    // Releasing a floor you do not hold is not an error worth a status code: the
    // end state the caller asked for — "I am not holding the microphone" — is
    // true either way, and a client that reconnects and tidies up should not
    // have to reason about which of its attempts got there first.
    const released = releaseFloor(req.params.id!, clientId);
    res.json({ released, floor: getFloor(req.params.id!) });
  } catch (err) {
    next(err);
  }
});

// POST /api/conversations/:id/floor/request — ask the holder for it
//
// There is no forced take-over. This posts a card on the holder's screen and
// stops there; cutting off somebody who is mid-sentence is a worse outcome than
// waiting for them to finish.
router.post("/:id/floor/request", (req, res, next) => {
  try {
    validateUUID(req.params.id!);

    const clientId = clientIdOf(req);
    if (!clientId) throw badRequest('Body must carry a non-empty "client_id"');

    const holder = getFloor(req.params.id!);
    if (!holder) {
      // Nobody to ask. Saying so beats a pending request nobody will ever grant.
      res.status(409).json({
        error: "Ninguém está com o microfone — é só pegar.",
        floor: null,
      });
      return;
    }
    if (holder.client_id === clientId) {
      res.json({ requested: null, floor: holder });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const pending = requestFloor(req.params.id!, clientId, normalizeName(body.name));
    res.status(202).json({ requested: pending, floor: holder });
  } catch (err) {
    next(err);
  }
});

export default router;
