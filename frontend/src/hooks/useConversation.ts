import { useState, useEffect, useCallback, useRef } from "react";
import * as api from "@/lib/api";
import type { Message } from "@/types";

let _tempId = 0;
function nextTempId(): string {
  _tempId += 1;
  return `temp-${_tempId}-${Date.now()}`;
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

export interface ConversationState {
  messages: Message[];
  isLoading: boolean;
  isLoadingHistory: boolean;
  sendMessage: (text: string) => Promise<void>;
  clearError: () => void;
  error: string | null;
}

export function useConversation(convId: string | null): ConversationState {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  // Load the stored history whenever the active conversation changes.
  // Conversations are persisted server-side; without this the UI showed an
  // empty thread after every switch and every page reload.
  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;

    setMessages([]);
    setIsLoading(false);
    setError(null);

    if (!convId) {
      setIsLoadingHistory(false);
      return;
    }

    let cancelled = false;
    setIsLoadingHistory(true);

    void (async () => {
      try {
        const conv = await api.getConversation(convId);
        if (cancelled) return;
        const history = conv.messages ?? [];
        // A message sent while this fetch was in flight is already in state,
        // and the server snapshot predates it — replacing wholesale would make
        // the user's own message disappear. Keep it after the history instead.
        setMessages((pending) =>
          pending.length === 0 ? history : [...history, ...pending],
        );
      } catch {
        if (!cancelled) setError("Não foi possível carregar o histórico.");
      } finally {
        if (!cancelled) setIsLoadingHistory(false);
      }
    })();

    return () => {
      cancelled = true;
      // Leaving the conversation also tears down any in-flight answer.
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [convId]);

  const clearError = useCallback(() => setError(null), []);

  const sendMessage = useCallback(
    async (text: string) => {
      if (!convId || !text.trim()) return;

      // Abort any in-flight request — the controller is now actually wired to
      // the fetch, so this really does cancel the stream.
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const optimisticUserMsg: Message = {
        id: nextTempId(),
        role: "user",
        content: text,
        timestamp: new Date().toISOString(),
      };

      setMessages((prev) => [...prev, optimisticUserMsg]);
      setIsLoading(true);
      setError(null);

      try {
        let assistantId: string | null = null;

        for await (const event of api.chat(convId, text, controller.signal)) {
          switch (event.type) {
            case "tool_call": {
              const toolMsg: Message = {
                id: nextTempId(),
                role: "tool",
                content: `Chamando ferramenta: ${event.tool}`,
                timestamp: new Date().toISOString(),
              };
              setMessages((prev) => [...prev, toolMsg]);
              break;
            }

            case "content": {
              if (assistantId === null) {
                const id = nextTempId();
                assistantId = id;
                setMessages((prev) => [
                  ...prev,
                  {
                    id,
                    role: "assistant",
                    content: event.text,
                    timestamp: new Date().toISOString(),
                  },
                ]);
              } else {
                const id = assistantId;
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === id
                      ? { ...m, content: (m.content ?? "") + event.text }
                      : m,
                  ),
                );
              }
              break;
            }

            case "audio": {
              // The backend emits `audio` after `content`, so the assistant
              // message exists by now; fall back to the last assistant message
              // if the order ever changes again.
              const id = assistantId;
              setMessages((prev) => {
                const targetIndex =
                  id !== null
                    ? prev.findIndex((m) => m.id === id)
                    : prev.map((m) => m.role).lastIndexOf("assistant");
                if (targetIndex === -1) return prev;
                const next = [...prev];
                next[targetIndex] = {
                  ...next[targetIndex]!,
                  audio_url: event.url,
                };
                return next;
              });
              break;
            }

            case "error":
              // The stream reports failures in-band; without this the user sat
              // on "Digitando..." forever with no explanation.
              setError(event.error);
              break;

            case "done":
              // Stream complete — nothing extra to do
              break;
          }
        }
      } catch (err: unknown) {
        // A cancelled request is not a failure worth showing.
        if (!isAbort(err)) {
          setError(
            err instanceof Error ? err.message : "Erro ao enviar mensagem.",
          );
        }
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        if (!controller.signal.aborted) setIsLoading(false);
      }
    },
    [convId],
  );

  return {
    messages,
    isLoading,
    isLoadingHistory,
    sendMessage,
    clearError,
    error,
  };
}
