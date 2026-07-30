import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { motion } from "motion/react";
import { Plus, Paperclip, Send, RefreshCw } from "lucide-react";
import { useMotionUITransition } from "@/components/motion-ui/ui-theme";
import {
  useToastStack,
  ToastStack,
  Toast,
} from "@/components/motion-ui/toast-stack";
import { Skeleton } from "@/components/motion-ui/skeleton";
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
import {
  CommandPalette,
  type CommandPaletteItem,
} from "@/components/motion-ui/command-palette";

export function App() {
  // ── Core state ────────────────────────────────────────────────
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

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

  // ── Command palette state ──────────────────────────────────
  const [commandOpen, setCommandOpen] = useState(false);
  const openCommandPalette = useCallback(() => setCommandOpen(true), []);

  const commandItems = useMemo<CommandPaletteItem[]>(
    () => [
      {
        id: "__new__",
        label: "Nova conversa",
        icon: Plus,
        group: "Ações",
        keywords: ["nova", "criar", "new", "create", "add"],
      },
      ...conversations.map((c) => ({
        id: c.id,
        label: c.title,
        group: "Conversas",
        hint: `Atualizada ${new Date(c.updated_at).toLocaleDateString("pt-BR")}`,
      })),
    ],
    [conversations],
  );

  // ── Derived ───────────────────────────────────────────────────
  const activeConv = conversations.find((c) => c.id === activeConvId) ?? null;

  // ── Fetch conversations (extracted for retry) ──────────────────
  const initRef = useRef<{ cancelled: boolean }>({ cancelled: false });

  const fetchConversations = useCallback(async () => {
    setIsLoading(true);
    setLoadError(false);
    initRef.current.cancelled = false;
    const ctx = initRef.current;

    try {
      const convs = await api.listConversations();
      if (ctx.cancelled) return;

      if (convs.length === 0) {
        const newConv = await api.createConversation("Nova conversa");
        if (ctx.cancelled) return;
        setConversations([newConv]);
        setActiveConvId(newConv.id);
      } else {
        setConversations(convs);
        if (convs[0]) setActiveConvId(convs[0].id);
      }
    } catch {
      if (!ctx.cancelled) {
        showError(
          "Não foi possível conectar ao servidor. Verifique sua conexão.",
        );
        setConversations([]);
        setLoadError(true);
      }
    } finally {
      if (!ctx.cancelled) setIsLoading(false);
    }
  }, [showError]);

  useEffect(() => {
    void fetchConversations();
    return () => {
      initRef.current.cancelled = true;
    };
  }, [fetchConversations]);

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

  // ── Command palette handler (after handleCreate/handleSelect) ─
  const handleCommandSelect = useCallback(
    (item: CommandPaletteItem) => {
      if (item.id === "__new__") {
        void handleCreate();
      } else {
        handleSelect(item.id);
      }
    },
    [handleCreate, handleSelect],
  );

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

  // ── Loading / error screen ────────────────────────────────────
  if (isLoading || loadError) {
    return (
      <div className="dark flex h-screen overflow-hidden bg-background text-foreground">
        {/* Header skeleton */}
        <header className="fixed inset-x-0 top-0 z-30 flex h-12 items-center justify-between border-b border-border bg-background/80 px-4 backdrop-blur-sm">
          <Skeleton className="h-5 w-32" animate />
          <Skeleton className="h-8 w-28 rounded-md" animate />
        </header>

        <div className="flex flex-1 pt-12">
          {/* Sidebar skeleton */}
          <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-muted/30 px-3 py-4">
            <Skeleton className="mb-2 h-10 w-full rounded-md" animate />
            <Skeleton className="mb-2 h-10 w-full rounded-md" animate />
            <Skeleton className="mb-2 h-10 w-full rounded-md" animate />
            <Skeleton className="h-10 w-full rounded-md" animate />
          </aside>

          {/* Main area — skeleton or error */}
          <main className="flex min-w-0 flex-1 flex-col">
            <div className="flex flex-1 items-center justify-center p-4">
              {loadError ? (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={transition}
                  className="max-w-sm text-center"
                >
                  <p className="mb-1 text-lg font-medium text-foreground">
                    Erro de conexão
                  </p>
                  <p className="mb-4 text-sm text-muted-foreground">
                    Não foi possível carregar as conversas. Verifique sua
                    conexão e tente novamente.
                  </p>
                  <Button
                    onClick={() => {
                      void fetchConversations();
                    }}
                  >
                    <RefreshCw className="mr-2 size-4" />
                    Tentar novamente
                  </Button>
                </motion.div>
              ) : (
                <div className="mx-auto w-full max-w-3xl space-y-4">
                  <div className="flex justify-end">
                    <Skeleton className="h-16 w-2/3 rounded-2xl" animate />
                  </div>
                  <div className="flex justify-start">
                    <Skeleton className="h-24 w-3/4 rounded-2xl" animate />
                  </div>
                  <div className="flex justify-end">
                    <Skeleton className="h-12 w-1/2 rounded-2xl" animate />
                  </div>
                </div>
              )}
            </div>

            {/* Input skeleton */}
            <div className="border-t border-border p-4">
              <div className="mx-auto flex max-w-3xl items-center gap-3">
                <Skeleton className="size-10 rounded-full" animate />
                <Skeleton className="h-10 flex-1 rounded-full" animate />
                <Skeleton className="size-10 rounded-full" animate />
              </div>
            </div>
          </main>
        </div>
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
          <button
            type="button"
            onClick={openCommandPalette}
            className="inline-flex items-center rounded border border-border bg-background px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="Paleta de comandos (⌘K)"
          >
            ⌘K
          </button>
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
                {/* ── Streaming skeleton bubble ──────────────────── */}
                {chatLoading && (
                  <motion.div
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={transition}
                    className="flex items-start"
                  >
                    <div className="max-w-[80%] rounded-2xl rounded-bl-sm bg-secondary px-4 py-3">
                      <Skeleton className="mb-2 h-3 w-48" animate />
                      <Skeleton className="h-3 w-32" animate />
                      <p className="mt-2 text-xs text-muted-foreground">
                        Digitando...
                      </p>
                    </div>
                  </motion.div>
                )}
              </div>
            ) : chatLoading ? (
              /* ── Empty-state streaming skeleton ───────────────── */
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={transition}
                className="flex h-full items-center justify-center"
              >
                <div className="max-w-sm text-center">
                  <Skeleton className="mx-auto mb-3 h-4 w-48" animate />
                  <Skeleton className="mx-auto mb-1 h-3 w-64" animate />
                  <Skeleton className="mx-auto h-3 w-40" animate />
                  <p className="mt-3 text-sm text-muted-foreground">
                    Digitando...
                  </p>
                </div>
              </motion.div>
            ) : (
              /* ── Idle empty state ─────────────────────────────── */
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

      {/* Command palette — trigger hidden off-screen; dialog renders in portal */}
      <div className="absolute -left-[9999px] -top-[9999px]" aria-hidden="true">
        <CommandPalette
          open={commandOpen}
          onOpenChange={setCommandOpen}
          items={commandItems}
          groupOrder={["Ações", "Conversas"]}
          onSelect={handleCommandSelect}
          triggerLabel="Buscar conversas…"
          triggerShortcut="⌘K"
          inputPlaceholder="Buscar conversa…"
          dialogLabel="Conversas"
          footerHints={[
            { keys: "↑↓", label: "navegar" },
            { keys: "↵", label: "abrir" },
            { keys: "esc", label: "fechar" },
          ]}
        />
      </div>
    </div>
  );
}
