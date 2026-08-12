import { useCallback, useEffect, useRef, useState } from "react";

import * as api from "@/lib/api";
import {
  FLOOR_REQUEST_TTL_MS,
  NO_PRESENCE,
  applyPresenceEvent,
  liveStreamHandler,
  type LivePresence,
} from "@/lib/conversation-stream";
import type {
  FloorRequest,
  FloorSnapshot,
  LiveMessage,
  LiveToolFinished,
} from "@/types";

// ---------------------------------------------------------------------------
// One `/live` stream per open conversation
// ---------------------------------------------------------------------------
//
// Opened whenever a conversation is on screen, and *not* only when a session is
// connected: the second person in a shared conversation never connects one — no
// microphone, no token, no cost — and they are exactly who this feature exists
// for. Tying the stream to `connect()` would leave the spectator watching a page
// that never changes.
//
// **This hook cannot talk to the model, and that is deliberate.** It holds no
// data channel and takes no `send`; the handler it installs comes from
// `lib/conversation-stream.ts`, whose deps interface has no way to reach one.
// See the invariant comment there for what goes wrong when a broadcast is fed
// back in as a turn.

/**
 * What the caller does with the halves of the stream it owns.
 *
 * Held in a ref and re-read on every frame, so a caller that rebuilds these
 * closures each render — every caller — does not tear the connection down and
 * open a new one, losing its place in the process.
 */
export interface ConversationStreamHandlers {
  onMessages: (messages: LiveMessage[]) => void;
  onToolFinished: (event: LiveToolFinished) => void;
  onMemoryChanged: (eventCount: number) => void;
  /** The conversation's markdown was written, here or on another screen. */
  onDocumentChanged: (content: string, source: "user" | "assistant") => void;
  /** The transcript on screen may be missing turns. Fetch the conversation again. */
  onReset: () => void;
}

export interface ConversationStreamState {
  /** Open streams on this conversation, this browser included. */
  viewers: number;
  floor: FloorSnapshot | null;
  floorRequest: FloorRequest | null;
  /**
   * Record a holder learned somewhere other than the stream.
   *
   * The mint's 409 names one, and it names it *before* any frame could: a client
   * refused the microphone finds out from the refusal itself.
   */
  noteFloor: (floor: FloorSnapshot | null) => void;
}

export function useConversationStream(
  conversationId: string | null,
  clientId: string,
  handlers: ConversationStreamHandlers,
): ConversationStreamState {
  const [presence, setPresence] = useState<LivePresence>(NO_PRESENCE);

  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  // Cleared when the request the server is holding goes stale. Kept in a ref so
  // a second request replaces the first one's timer instead of racing it.
  const requestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const forgetRequestLater = useCallback(() => {
    if (requestTimerRef.current) clearTimeout(requestTimerRef.current);
    requestTimerRef.current = setTimeout(() => {
      requestTimerRef.current = null;
      setPresence((current) =>
        current.request ? { ...current, request: null } : current,
      );
    }, FLOOR_REQUEST_TTL_MS);
  }, []);

  const noteFloor = useCallback((floor: FloorSnapshot | null) => {
    setPresence((current) => ({ ...current, floor }));
  }, []);

  useEffect(() => {
    setPresence(NO_PRESENCE);
    if (!conversationId) return;

    const source = new EventSource(api.conversationStreamUrl(conversationId, clientId));

    const handle = liveStreamHandler({
      onMessages: (messages) => handlersRef.current.onMessages(messages),
      onToolFinished: (event) => handlersRef.current.onToolFinished(event),
      onMemoryChanged: (count) => handlersRef.current.onMemoryChanged(count),
      onDocumentChanged: (content, source) =>
        handlersRef.current.onDocumentChanged(content, source),
      onPresence: (event) => {
        const at = new Date().toISOString();
        setPresence((current) => applyPresenceEvent(current, event, at));
        if (event.type === "floor.requested") forgetRequestLater();
      },
      onReset: () => handlersRef.current.onReset(),
    });

    source.onmessage = (message: MessageEvent<string>) => handle(message.data);
    source.onerror = () => {
      // `EventSource` reconnects on its own — with `Last-Event-ID`, which is what
      // turns a tunnel or a lock screen into a replayed gap instead of a silently
      // divergent transcript. A blip is not worth a toast.
    };

    // One read, for the one thing the stream cannot tell a latecomer: a request
    // to speak that was made before this client arrived. The holder rides on the
    // `presence.changed` the server publishes when this very connection opens,
    // so it is not what this is for.
    let abandoned = false;
    void api
      .getFloor(conversationId)
      .then((state) => {
        if (abandoned) return;
        setPresence((current) => ({
          viewers: Math.max(current.viewers, state.viewers),
          // The stream is the fresher source once it has said anything, so a
          // reply that lands after the first frame must not undo it.
          floor: current.floor ?? state.floor,
          request: current.request ?? state.request,
        }));
        if (state.request) forgetRequestLater();
      })
      .catch(() => {
        // Presence is decoration around a conversation that works without it.
      });

    return () => {
      abandoned = true;
      source.close();
      if (requestTimerRef.current) {
        clearTimeout(requestTimerRef.current);
        requestTimerRef.current = null;
      }
    };
  }, [conversationId, clientId, forgetRequestLater]);

  return {
    viewers: presence.viewers,
    floor: presence.floor,
    floorRequest: presence.request,
    noteFloor,
  };
}
