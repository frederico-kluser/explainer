import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { motion } from "motion/react";
import { Plus, Paperclip, Send } from "lucide-react";
import { useMotionUITransition } from "@/components/motion-ui/ui-theme";
import {
  useToastStack,
  ToastStack,
  Toast,
} from "@/components/motion-ui/toast-stack";
import { ConversationTabs } from "@/components/ui/ConversationTabs";
import { ChatBubble } from "@/components/ui/ChatBubble";
import { MicButton, type MicButtonState } from "@/components/ui/MicButton";
import { AudioPlayer } from "@/components/ui/AudioPlayer";
import { FilePanel } from "@/components/ui/FilePanel";
import { Button } from "@/components/ui/button";
import * as api from "@/lib/api";
import { useAudioRecorder } from "@/hooks/useAudioRecorder";
import { useConversation } from "@/hooks/useConversation";
import { useAutoPlay } from "@/hooks/useAutoPlay";
import type { Conversation, Message } from "@/types";

export function App() {
  // ── Core state ────────────────────────────────────────────────
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  // ── Hooks ─────────────────────────────────────────────────
  const { isRecording, startRecording, stopRecording, error: micError } =
    useAudioRecorder();
  const [micProcessing, setMicProcessing] = useState(false);
  const micState: MicButtonState = isRecording
    ? "recording"
    : micProcessing
      ? "processing"
      : "idle";

  const {
    messages: chatMessages,
    isLoading: chatLoading,
    sendMessage,
    error: chatError,
  } = useConversation(activeConvId);

  const latestAudioUrl = useMemo(() => {
    for (let i = chatMessages.length - 1; i >= 0; i--) {
      const msg = chatMessages[i];
      if (msg?.audio_url) {
        return msg.audio_url;
      }
    }
    return null;
  }, [chatMessages]);

  useAutoPlay(latestAudioUrl);
  const [textInput, setTextInput] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);

  // ── Toast queue ───────────────────────────────────────────────
  const { toasts, add: addToast, dismiss: dismissToast } = useToastStack();
  const toastDataRef = useRef<Map<number, string>>(new Map());
  const [toastVersion, setToastVersion] = useState(0);

  const showError = useCallback(
    (message: string) => {
      const id = addToast();
      toastDataRef.current.set(id, message);
      setToastVersion((v) => v + 1);
      setTimeout(() => {
        dismissToast(id);
        toastDataRef.current.delete(id);
        setToastVersion((v) => v + 1);
      }, 5000);
    },
    [addToast, dismissToast],
  );

  const dismissToastEntry = useCallback(
    (id: number) => {
      dismissToast(id);
      toastDataRef.current.delete(id);
      setToastVersion((v) => v + 1);
    },
    [dismissToast],
  );

  // ── Error effects ──────────────────────────────────────────
  useEffect(() => {
    if (micError) showError(micError);
  }, [micError, showError]);

  useEffect(() => {
    if (chatError) showError(chatError);
  }, [chatError, showError]);

  const transition = useMotionUITransition("gentle");

  // ── Derived ───────────────────────────────────────────────────
  const activeConv = conversations.find((c) => c.id === activeConvId) ?? null;

  // ── On mount: fetch conversations ─────────────────────────────
  useEffect(() => {
    let cancelled = false;
    async function init() {
      try {
        const convs = await api.listConversations();
        if (cancelled) return;

        if (convs.length === 0) {
          const newConv = await api.createConversation("Nova conversa");
          if (cancelled) return;
          setConversations([newConv]);
          setActiveConvId(newConv.id);
        } else {
          setConversations(convs);
          if (convs[0]) setActiveConvId(convs[0].id);
        }
      } catch {
        if (!cancelled) {
          showError(
            "Não foi possível conectar ao servidor. O app iniciará offline.",
          );
          setConversations([]);
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    init();
    return () => {
      cancelled = true;
    };
  }, [showError]);

  // ── Conversation CRUD ─────────────────────────────────────────
  const handleCreate = useCallback(async () => {
    try {
      const newConv = await api.createConversation("Nova conversa");
      setConversations((prev) => [...prev, newConv]);
      setActiveConvId(newConv.id);
    } catch {
      showError("Erro ao criar conversa.");
    }
  }, [showError]);

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        await api.deleteConversation(id);
        const wasActive = activeConvId === id;
        setConversations((prev) => prev.filter((c) => c.id !== id));
        if (wasActive) {
          const remaining = conversations.filter((c) => c.id !== id);
          setActiveConvId(remaining[0]?.id ?? null);
        }
      } catch {
        showError("Erro ao deletar conversa.");
      }
    },
    [activeConvId, conversations, showError],
  );

  const handleSelect = useCallback((id: string) => {
    setActiveConvId(id);
    setTextInput("");
  }, []);

  // ── Microphone ────────────────────────────────────────────────
  const handleMicStart = useCallback(() => {
    startRecording();
  }, [startRecording]);

  const handleMicStop = useCallback(async () => {
    setMicProcessing(true);
    try {
      const blob = await stopRecording();
      const { text } = await api.transcribe(blob);
      setMicProcessing(false);
      sendMessage(text);
    } catch (err: unknown) {
      setMicProcessing(false);
      const message =
        err instanceof Error ? err.message : "Erro ao processar áudio.";
      showError(message);
    }
  }, [stopRecording, sendMessage, showError]);

  // ── Text input ────────────────────────────────────────────────
  const handleTextSubmit = useCallback(() => {
    if (!textInput.trim() || !activeConvId) return;
    const text = textInput.trim();
    setTextInput("");
    sendMessage(text);
  }, [textInput, activeConvId, sendMessage]);

  // ── File upload / remove ──────────────────────────────────────
  const handleFileUpload = useCallback(
    async (fileList: FileList) => {
      const convId = activeConvId;
      if (!convId) return;
      try {
        await api.uploadFiles(convId, Array.from(fileList));
        const updated = await api.getConversation(convId);
        setConversations((prev) => {
          if (!prev.some((c) => c.id === convId)) return prev;
          return prev.map((c) => (c.id === convId ? updated : c));
        });
      } catch {
        showError("Erro ao fazer upload de arquivos.");
      }
    },
    [activeConvId, showError],
  );

  const handleFileRemove = useCallback(
    (_id: string) => {
      showError("Remoção de arquivos ainda não disponível.");
    },
    [showError],
  );

  // ── Loading screen ────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="dark flex h-screen items-center justify-center bg-background">
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={transition}
          className="text-sm text-muted-foreground"
        >
          Carregando…
        </motion.p>
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────
  return (
    <div className="dark flex h-screen overflow-hidden bg-background text-foreground">
      {/* Toast stack — fixed bottom-centre */}
      <ToastStack>
        {toasts.map((toastId, idx) => {
          const message = toastDataRef.current.get(toastId) ?? "";
          return (
            <Toast key={toastId}>
              <div className="rounded-lg border border-border bg-card p-4 shadow-lg">
                <div className="flex items-start gap-3">
                  <p className="flex-1 text-sm text-foreground">
                    {message}
                  </p>
                  <button
                    type="button"
                    onClick={() => dismissToastEntry(toastId)}
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                    aria-label="Fechar"
                  >
                    &times;
                  </button>
                </div>
              </div>
            </Toast>
          );
        })}
      </ToastStack>

      {/* ── Header ──────────────────────────────────────────────── */}
      <header className="fixed inset-x-0 top-0 z-30 flex h-12 items-center justify-between border-b border-border bg-background/80 px-4 backdrop-blur-sm">
        <div className="flex items-center gap-2">
          <span className="text-lg" aria-hidden="true">
            &#x1F3A4;
          </span>
          <h1 className="text-sm font-semibold text-foreground">
            Voice Assistant
          </h1>
        </div>

        <button
          type="button"
          onClick={handleCreate}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
          title="Nova conversa"
        >
          <Plus className="size-3.5" />
          Nova Conversa
        </button>
      </header>

      {/* ── Body ────────────────────────────────────────────────── */}
      <div className="flex flex-1 pt-12">
        {/* ── Left sidebar ──────────────────────────────────────── */}
        <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-muted/30">
          {/* Conversation tabs */}
          <div className="flex-1 overflow-y-auto px-3 py-4">
            {conversations.length === 0 ? (
              <div className="flex flex-col items-center gap-3 py-8 text-center">
                <p className="text-sm text-muted-foreground">
                  Nenhuma conversa ainda
                </p>
                <Button variant="outline" size="sm" onClick={handleCreate}>
                  <Plus className="size-3.5" />
                  Criar conversa
                </Button>
              </div>
            ) : (
              <ConversationTabs
                conversations={conversations.map((c) => ({
                  id: c.id,
                  title: c.title,
                }))}
                activeId={activeConvId ?? ""}
                onSelect={handleSelect}
                onCreate={handleCreate}
                onDelete={handleDelete}
              />
            )}
          </div>

          {/* FilePanel trigger at sidebar bottom */}
          {activeConvId && (
            <div className="border-t border-border px-3 py-3">
              <FilePanel
                files={activeConv?.attachments ?? []}
                onUpload={(fileList) => {
                  void handleFileUpload(fileList);
                }}
                onRemove={handleFileRemove}
              />
            </div>
          )}
        </aside>

        {/* ── Main chat area ────────────────────────────────────── */}
        <main className="flex min-w-0 flex-1 flex-col">
          {/* Message list */}
          <div className="flex-1 overflow-y-auto p-4">
            {chatMessages.length > 0 ? (
              <div className="mx-auto max-w-3xl space-y-4">
                {chatMessages.map((msg: Message) => (
                  <div key={msg.id}>
                    {msg.content && (
                      <ChatBubble
                        role={msg.role === "user" ? "user" : "assistant"}
                        content={msg.content}
                        timestamp={msg.timestamp}
                      />
                    )}
                    {msg.audio_url && (
                      <div className="mt-2">
                        <AudioPlayer
                          audioUrl={msg.audio_url}
                          autoPlay={false}
                        />
                      </div>
                    )}
                  </div>
                ))}
                {chatLoading && (
                  <motion.div
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={transition}
                    className="flex items-start"
                  >
                    <div className="max-w-[80%] rounded-2xl rounded-bl-sm bg-secondary px-4 py-3 text-sm text-secondary-foreground">
                      <span className="inline-flex items-center gap-2">
                        <span className="size-2 animate-pulse rounded-full bg-current" />
                        Processando…
                      </span>
                    </div>
                  </motion.div>
                )}
              </div>
            ) : chatLoading ? (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={transition}
                className="flex h-full items-center justify-center"
              >
                <div className="max-w-sm text-center">
                  <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
                    <span className="size-2 animate-pulse rounded-full bg-current" />
                    Processando…
                  </span>
                </div>
              </motion.div>
            ) : (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={transition}
                className="flex h-full items-center justify-center"
              >
                <div className="max-w-sm text-center">
                  <p className="mb-2 text-lg font-medium text-foreground">
                    {conversations.length === 0
                      ? "Bem-vindo ao Voice Assistant"
                      : "Nova conversa"}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Clique no microfone para come&ccedil;ar a gravar ou digite
                    sua pergunta abaixo.
                  </p>
                </div>
              </motion.div>
            )}
          </div>

          {/* ── Bottom input bar ────────────────────────────────── */}
          <div className="border-t border-border p-4">
            <div className="mx-auto flex max-w-3xl items-center gap-3">
              {/* Mic button */}
              <MicButton
                state={micState}
                onStart={handleMicStart}
                onStop={handleMicStop}
              />

              {/* Text input */}
              <div className="flex flex-1 items-center gap-2 rounded-full border border-border bg-background px-4 py-2">
                <input
                  ref={inputRef}
                  type="text"
                  value={textInput}
                  onChange={(e) => setTextInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleTextSubmit();
                    }
                  }}
                  placeholder="Digite sua pergunta..."
                  className="flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
                />
                <button
                  type="button"
                  onClick={handleTextSubmit}
                  disabled={!textInput.trim()}
                  className="inline-flex size-8 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                  aria-label="Enviar"
                >
                  <Send className="size-4" />
                </button>
              </div>

              {/* Inline file upload */}
              <label className="inline-flex size-10 cursor-pointer items-center justify-center rounded-full border border-border bg-background text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
                <Paperclip className="size-4" />
                <input
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    if (e.target.files && e.target.files.length > 0) {
                      void handleFileUpload(e.target.files);
                      e.target.value = "";
                    }
                  }}
                />
              </label>
            </div>

            {/* Audio player for current utterance */}
            {latestAudioUrl && (
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={transition}
                className="mx-auto mt-3 max-w-3xl"
              >
                <AudioPlayer audioUrl={latestAudioUrl} autoPlay />
              </motion.div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
