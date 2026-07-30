import { useState, useEffect, useCallback, useRef } from "react";
import * as api from "@/lib/api";
import type { Message } from "@/types";

let _tempId = 0;
function nextTempId(): string {
  _tempId += 1;
  return `temp-${_tempId}-${Date.now()}`;
}

export interface ConversationState {
  messages: Message[];
  isLoading: boolean;
  sendMessage: (text: string) => Promise<void>;
  clearError: () => void;
  error: string | null;
}

export function useConversation(convId: string | null): ConversationState {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  // Reset when convId changes
  useEffect(() => {
    setMessages([]);
    setIsLoading(false);
    setError(null);
  }, [convId]);

  const clearError = useCallback(() => setError(null), []);

  const sendMessage = useCallback(
    async (text: string) => {
      if (!convId || !text.trim()) return;

      // Abort any in-flight request
      if (abortRef.current) {
        abortRef.current.abort();
      }
      abortRef.current = new AbortController();

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
        let assistantMsg: Message | null = null;

        for await (const event of api.chat(convId, text)) {
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
              if (!assistantMsg) {
                assistantMsg = {
                  id: nextTempId(),
                  role: "assistant",
                  content: event.text,
                  timestamp: new Date().toISOString(),
                };
                setMessages((prev) => [...prev, assistantMsg!]);
              } else {
                const updated = { ...assistantMsg };
                assistantMsg = {
                  ...updated,
                  content: (updated.content ?? "") + event.text,
                } as Message;
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === updated.id ? assistantMsg! : m,
                  ),
                );
              }
              break;
            }

            case "audio": {
              if (assistantMsg) {
                assistantMsg = {
                  ...assistantMsg,
                  audio_url: event.url,
                } as Message;
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantMsg!.id ? assistantMsg! : m,
                  ),
                );
              }
              break;
            }

            case "done":
              // Stream complete — nothing extra to do
              break;
          }
        }
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : "Erro ao enviar mensagem.";
        setError(message);
      } finally {
        setIsLoading(false);
        abortRef.current = null;
      }
    },
    [convId],
  );

  return { messages, isLoading, sendMessage, clearError, error };
}
