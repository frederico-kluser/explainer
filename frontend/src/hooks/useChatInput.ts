import { useState, useCallback, useRef, useEffect } from "react";

import { sendChatMessage } from "@/lib/api";
import type { ReactEvent } from "@/types";

export type SendResult =
  | { kind: "conversation" }
  | { kind: "direct" }
  | { kind: "react" };

/**
 * Manages standalone text input — not tied to a live voice session.
 *
 * Sends a message to POST /api/chat and handles all three routing outcomes:
 * conversation (tell the caller to suggest voice), direct (store the answer),
 * and ReAct (read the SSE stream and accumulate events).
 */
export function useChatInput(conversationId: string | null) {
  const [isSending, setIsSending] = useState(false);
  const [reactEvents, setReactEvents] = useState<ReactEvent[]>([]);
  const [directAnswer, setDirectAnswer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sendingRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const streamTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Abort any in-flight SSE stream when the conversation changes or the hook
  // unmounts. Without this, stale events contaminate the new conversation's
  // state and sendingRef stays true, locking the user out.
  useEffect(() => {
    return () => {
      if (streamTimeoutRef.current) {
        clearTimeout(streamTimeoutRef.current);
        streamTimeoutRef.current = null;
      }
      abortRef.current?.abort();
      abortRef.current = null;
      sendingRef.current = false;
      setIsSending(false);
    };
  }, [conversationId]);

  const clearAnswer = useCallback(() => {
    setDirectAnswer(null);
    setReactEvents([]);
    setError(null);
  }, []);

  const sendMessage = useCallback(
    async (text: string): Promise<SendResult | null> => {
      const trimmed = text.trim();
      if (!trimmed || sendingRef.current) return null;

      sendingRef.current = true;
      setIsSending(true);
      clearAnswer();

      // Create a fresh AbortController for this request so we can cancel it
      // on conversation switch and also enforce a 120 s hard timeout.
      const controller = new AbortController();
      abortRef.current = controller;

      // 120 s overall timeout — protects against a hung server that stops
      // sending SSE chunks without closing the connection.
      streamTimeoutRef.current = setTimeout(() => {
        controller.abort();
      }, 120_000);

      try {
        const result = await sendChatMessage(
          trimmed,
          conversationId ?? undefined,
          controller.signal,
        );

        if (result.mode === "conversation") {
          return { kind: "conversation" };
        }

        if (result.mode === "task" && result.type === "direct") {
          setDirectAnswer(result.answer);
          return { kind: "direct" };
        }

        // ReAct stream — read the SSE body inline.
        const reader = result.stream.body?.getReader();
        if (!reader) {
          setError("Resposta do servidor sem corpo legivel.");
          return null;
        }

        const decoder = new TextDecoder();
        let buffer = "";

        try {
          while (true) {
            // Check for cancellation (conversation switch, timeout, unmount)
            // before each read so we don't keep pulling chunks for a dead
            // stream.
            if (controller.signal.aborted) break;

            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const parts = buffer.split("\n\n");
            // The last chunk after the final delimiter is incomplete (or empty
            // when the buffer ends with \n\n); hold it for the next read.
            buffer = parts.pop() ?? "";

            for (const part of parts) {
              for (const line of part.split("\n")) {
                if (!line.startsWith("data: ")) continue;
                const raw = line.slice(6);
                if (raw === "[DONE]") return { kind: "react" };

                try {
                  const parsed = JSON.parse(raw) as Record<string, unknown>;
                  const type = parsed.type as string;

                  if (type === "answer") {
                    setReactEvents((prev) => [
                      ...prev,
                      { type: "answer", data: (parsed.content as string) ?? "" },
                    ]);
                  } else if (type === "tool_call") {
                    const tool = typeof parsed.tool === "string" ? parsed.tool : "";
                    const args = parsed.args as Record<string, unknown> | undefined;
                    const display = JSON.stringify(
                      args ? { tool, args } : { tool },
                    );
                    setReactEvents((prev) => [
                      ...prev,
                      { type: "tool_call", data: display },
                    ]);
                  } else if (type === "tool_result") {
                    const tool = typeof parsed.tool === "string" ? parsed.tool : "";
                    const output =
                      typeof parsed.output === "string" ? parsed.output : "";
                    const display =
                      tool && output ? `${tool}: ${output}` : output || tool;
                    setReactEvents((prev) => [
                      ...prev,
                      { type: "tool_result", data: display },
                    ]);
                  } else if (type === "error") {
                    setError((parsed.message as string) ?? raw);
                  }
                } catch {
                  // Skip unparseable lines — the stream may carry keep-alive
                  // comments.
                }
              }
            }
          }
        } finally {
          reader.releaseLock();
        }

        return { kind: "react" };
      } catch (err) {
        // AbortError is expected when the user switches conversations or the
        // stream times out; don't show it as an error.
        if (err instanceof DOMException && err.name === "AbortError") {
          return null;
        }
        setError(
          err instanceof Error ? err.message : "Erro desconhecido.",
        );
        return null;
      } finally {
        if (streamTimeoutRef.current) {
          clearTimeout(streamTimeoutRef.current);
          streamTimeoutRef.current = null;
        }
        sendingRef.current = false;
        setIsSending(false);
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
      }
    },
    [conversationId, clearAnswer],
  );

  return { sendMessage, isSending, reactEvents, directAnswer, error, clearAnswer };
}
