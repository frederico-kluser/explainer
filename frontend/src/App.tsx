import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { motion } from "motion/react";
import { Plus, RefreshCw, Send } from "lucide-react";
import { useMotionUITransition } from "@/components/motion-ui/ui-theme";
import {
  useToastStack,
  ToastStack,
  Toast,
} from "@/components/motion-ui/toast-stack";
import { Skeleton } from "@/components/motion-ui/skeleton";
import { Sidebar } from "@/components/ui/Sidebar";
import { ChatBubble } from "@/components/ui/ChatBubble";
import { ChatResponse } from "@/components/ui/ChatResponse";
import { ToolTrace } from "@/components/ui/ToolTrace";
import { MicButton, type MicButtonState } from "@/components/ui/MicButton";
import { MaterialPicker } from "@/components/ui/MaterialPicker";
import { AgentJobCard } from "@/components/ui/AgentJobCard";
import { VoiceSettings } from "@/components/ui/VoiceSettings";
import { CostPanel } from "@/components/ui/CostPanel";
import { Button } from "@/components/ui/button";
import * as api from "@/lib/api";
import { useRealtimeSession } from "@/hooks/useRealtimeSession";
import { useChatInput } from "@/hooks/useChatInput";
import type {
  Message,
  Conversation,
  ConversationSettings,
  CostSummary,
  Material,
  ProviderCredit,
  SourceSpec,
} from "@/types";
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
  const [materials, setMaterials] = useState<Material[]>([]);
  const [greeting, setGreeting] = useState<string | null>(null);
  const [sourceBusy, setSourceBusy] = useState(false);
  const [settings, setSettings] = useState<ConversationSettings | null>(null);
  const [costs, setCosts] = useState<CostSummary | null>(null);
  const [credits, setCredits] = useState<ProviderCredit[]>([]);
  const [creditsLoading, setCreditsLoading] = useState(false);
  const [textInput, setTextInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const historyAbortRef = useRef<AbortController | null>(null);
  const historyEarliestRef = useRef<string | null>(null);
  const historyLoadingMoreRef = useRef(false);
  const loadMoreAbortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // ── Conversation history (fetched from disk) ──────────────────
  const [historyMessages, setHistoryMessages] = useState<Message[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyHasMore, setHistoryHasMore] = useState(false);

  // ── Live voice session ────────────────────────────────────────
  const {
    status,
    error: sessionError,
    transcript,
    userSpeaking,
    assistantSpeaking,
    activeTool,
    jobs,
    sessionUsd,
    connect,
    disconnect,
    sendText,
    cancelJob,
    setSpeed,
  } = useRealtimeSession(activeConvId);

  // ── Standalone chat (no live session) ──────────────────────────
  const {
    sendMessage,
    isSending: chatSending,
    reactEvents,
    directAnswer,
    error: chatError,
    clearAnswer,
  } = useChatInput(activeConvId);

  const [showVoiceHint, setShowVoiceHint] = useState(false);

  // Clear standalone chat state when switching conversations.
  useEffect(() => {
    clearAnswer();
    setShowVoiceHint(false);
  }, [activeConvId, clearAnswer]);

  const micState: MicButtonState =
    status === "connecting"
      ? "connecting"
      : status !== "live"
        ? "idle"
        : userSpeaking
          ? "hearing"
          : assistantSpeaking
            ? "speaking"
            : "listening";

  // ── Toast queue ───────────────────────────────────────────────
  const { toasts, add: addToast, dismiss: dismissToast } = useToastStack();
  const toastDataRef = useRef<Map<number, string>>(new Map());

  const showError = useCallback(
    (message: string) => {
      const id = addToast();
      toastDataRef.current.set(id, message);
      setTimeout(() => {
        dismissToast(id);
        toastDataRef.current.delete(id);
      }, 5000);
    },
    [addToast, dismissToast],
  );

  const dismissToastEntry = useCallback(
    (id: number) => {
      dismissToast(id);
      toastDataRef.current.delete(id);
    },
    [dismissToast],
  );

  useEffect(() => {
    if (sessionError) showError(sessionError);
  }, [sessionError, showError]);

  const transition = useMotionUITransition("gentle");

  // ── Command palette ────────────────────────────────────────────
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
        showError("Não foi possível conectar ao servidor. Verifique sua conexão.");
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

  const refreshCredits = useCallback(async () => {
    setCreditsLoading(true);
    try {
      setCredits(await api.getCredits());
    } catch {
      /* the panel shows whatever it last had */
    } finally {
      setCreditsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshCredits();
  }, [refreshCredits]);

  // Reloading a conversation has to bring back its source, its settings and its
  // ledger — otherwise the connect button refuses with no visible reason.
  useEffect(() => {
    setMaterials([]);
    setGreeting(null);
    setSettings(null);
    setCosts(null);
    if (!activeConvId) return;

    let cancelled = false;
    const load = async () => {
      const [envelope, existingSettings, existingCosts] = await Promise.all([
        api.listMaterials(activeConvId).catch(() => null),
        api.getSettings(activeConvId).catch(() => null),
        api.getCosts(activeConvId).catch(() => null),
      ]);
      if (cancelled) return;
      setMaterials(envelope?.materials ?? []);
      setGreeting(envelope?.greeting ?? null);
      setSettings(existingSettings);
      setCosts(existingCosts);
    };
    void load();

    return () => {
      cancelled = true;
    };
  }, [activeConvId]);

  // The ledger lives on the server; pull it back whenever the meter moves.
  // Finished agents matter as much as spoken turns — a `pi` run is often the
  // most expensive thing in the conversation.
  const finishedJobs = jobs.filter((job) => job.status !== "running").length;

  useEffect(() => {
    if (!activeConvId || (sessionUsd === 0 && finishedJobs === 0)) return;
    const timer = setTimeout(() => {
      void api
        .getCosts(activeConvId)
        .then(setCosts)
        .catch(() => {});
    }, 1500);
    return () => clearTimeout(timer);
  }, [activeConvId, sessionUsd, finishedJobs]);

  // Fetch stored messages whenever the active conversation changes.
  // Aborts any in-flight fetch so rapid sidebar clicks don't queue stale loads.
  useEffect(() => {
    if (historyAbortRef.current) {
      historyAbortRef.current.abort();
    }
    if (loadMoreAbortRef.current) {
      loadMoreAbortRef.current.abort();
    }
    setHistoryMessages([]);
    setHistoryHasMore(false);
    historyEarliestRef.current = null;
    setHistoryLoading(false);

    if (!activeConvId) return;

    const controller = new AbortController();
    historyAbortRef.current = controller;
    setHistoryLoading(true);

    const load = async () => {
      try {
        const result = await api.fetchMessages(activeConvId, {
          limit: 50,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setHistoryMessages(result.messages);
        setHistoryHasMore(result.has_more);
        if (result.messages.length > 0) {
          // With newest-first ordering, the oldest message in the loaded
          // batch is the last element.
          historyEarliestRef.current = result.messages[result.messages.length - 1]!.timestamp;
        }
      } catch (err) {
        // AbortError is expected when the user switches conversations
        // mid-load; everything else is a real failure worth logging.
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          console.error("Failed to fetch conversation messages:", err);
        }
      } finally {
        if (!controller.signal.aborted) {
          setHistoryLoading(false);
        }
      }
    };
    void load();

    return () => {
      controller.abort();
    };
  }, [activeConvId]);

  // Follow the conversation as it grows.
  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  // Only scroll on live transcript entries — loading history is a
  // deliberate navigation, not something the user wants auto-scrolled away from.
  }, [transcript]);

  const creatingRef = useRef(false);

  // ── Conversation CRUD ─────────────────────────────────────────
  const handleCreate = useCallback(async () => {
    if (creatingRef.current) return;
    creatingRef.current = true;
    try {
      const newConv = await api.createConversation("Nova conversa");
      setConversations((prev) => [newConv, ...prev]);
      setActiveConvId(newConv.id);
    } catch {
      showError("Erro ao criar conversa.");
    } finally {
      creatingRef.current = false;
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

  const handleRename = useCallback(
    async (id: string, title: string) => {
      setConversations((prev) =>
        prev.map((c) => (c.id === id ? { ...c, title } : c)),
      );
      try {
        await api.renameConversation(id, title);
      } catch {
        showError("Erro ao renomear conversa.");
        void api.listConversations().then(setConversations).catch(() => {});
      }
    },
    [showError],
  );

  const handleSelect = useCallback((id: string) => {
    setActiveConvId(id);
    setTextInput("");
    inputRef.current?.focus();
  }, []);

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

  // ── Materials ─────────────────────────────────────────────────
  const handleMaterialAdd = useCallback(
    async (spec: SourceSpec) => {
      if (!activeConvId) return;
      setSourceBusy(true);
      try {
        const envelope = await api.addMaterial(activeConvId, spec);
        setMaterials(envelope.materials);
        setGreeting(envelope.greeting);
        setConversations(await api.listConversations());
      } catch (err) {
        showError(
          err instanceof Error ? err.message : "Não foi possível carregar o material.",
        );
      } finally {
        setSourceBusy(false);
      }
    },
    [activeConvId, showError],
  );

  const handleMaterialRemove = useCallback(
    async (materialId: string) => {
      if (!activeConvId) return;
      try {
        const envelope = await api.removeMaterial(activeConvId, materialId);
        setMaterials(envelope.materials);
        setGreeting(envelope.greeting);
      } catch (err) {
        showError(
          err instanceof Error ? err.message : "Não foi possível remover o material.",
        );
      }
    },
    [activeConvId, showError],
  );

  // ── Load more history ───────────────────────────────────────
  const handleLoadMore = useCallback(async () => {
    if (!activeConvId || !historyEarliestRef.current || historyLoadingMoreRef.current) return;

    // Capture the conversation id before the await so we can detect whether the
    // user switched conversations while the fetch was in flight.
    const capturedConvId = activeConvId;
    historyLoadingMoreRef.current = true;
    loadMoreAbortRef.current?.abort();
    const controller = new AbortController();
    loadMoreAbortRef.current = controller;

    try {
      const result = await api.fetchMessages(capturedConvId, {
        limit: 50,
        before: historyEarliestRef.current,
        signal: controller.signal,
      });
      // Guard: if the user switched conversations, discard the stale response.
      if (controller.signal.aborted || activeConvId !== capturedConvId) return;
      setHistoryMessages((prev) => [...result.messages, ...prev]);
      setHistoryHasMore(result.has_more);
      if (result.messages.length > 0) {
        // With newest-first ordering, the oldest message in the loaded
        // batch is the last element.
        historyEarliestRef.current =
          result.messages[result.messages.length - 1]!.timestamp;
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      console.error("Failed to load more messages:", err);
    } finally {
      // Only clear the loading flag if our controller is still the current
      // one — if a conversation switch aborted us and started a new load,
      // the new load owns the flag.
      if (loadMoreAbortRef.current === controller) {
        historyLoadingMoreRef.current = false;
      }
    }
  }, [activeConvId]);

  // ── Settings ──────────────────────────────────────────────────
  const handleVoiceChange = useCallback(
    async (voice: string) => {
      if (!activeConvId) return;
      setSettings((prev) => (prev ? { ...prev, voice } : prev));
      try {
        setSettings(await api.updateSettings(activeConvId, { voice }));
      } catch {
        showError("Não foi possível salvar a voz.");
      }
    },
    [activeConvId, showError],
  );

  const handleSpeedChange = useCallback(
    async (speed: number) => {
      if (!activeConvId) return;
      setSettings((prev) => (prev ? { ...prev, speed } : prev));
      // Speed is the one setting that can move mid-call, so push it live too.
      if (status === "live") setSpeed(speed);
      try {
        await api.updateSettings(activeConvId, { speed });
      } catch {
        showError("Não foi possível salvar a velocidade.");
      }
    },
    [activeConvId, setSpeed, showError, status],
  );

  // ── Text input ────────────────────────────────────────────────
  const handleTextSubmit = useCallback(async () => {
    const trimmed = textInput.trim();
    if (!trimmed) return;

    // Voice session active — route through the data channel.
    if (status === "live") {
      sendText(trimmed);
      setTextInput("");
      inputRef.current?.focus();
      return;
    }

    // Standalone chat — call the text API.
    const result = await sendMessage(trimmed);
    setTextInput("");
    inputRef.current?.focus();

    if (result?.kind === "conversation") {
      setShowVoiceHint(true);
    }
  }, [textInput, status, sendText, sendMessage]);

  const runningJobs = jobs.filter((job) => job.status === "running");

  // ── Loading / error screen ────────────────────────────────────
  if (isLoading || loadError) {
    return (
      <div className="dark flex h-screen overflow-hidden bg-background text-foreground">
        <aside className="flex w-72 shrink-0 flex-col gap-2 border-r border-border bg-muted/20 px-3 py-4">
          <Skeleton className="mb-2 h-9 w-full rounded-lg" animate />
          <Skeleton className="h-9 w-full rounded-md" animate />
          <Skeleton className="h-9 w-full rounded-md" animate />
          <Skeleton className="h-9 w-full rounded-md" animate />
        </aside>

        <main className="flex min-w-0 flex-1 items-center justify-center p-4">
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
                Não foi possível carregar as conversas. Verifique sua conexão e
                tente novamente.
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
            </div>
          )}
        </main>
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────
  return (
    <div className="dark flex h-screen overflow-hidden bg-background text-foreground">
      <ToastStack>
        {toasts.map((toastId) => {
          const message = toastDataRef.current.get(toastId) ?? "";
          return (
            <Toast key={toastId}>
              <div className="rounded-lg border border-border bg-card p-4 shadow-lg">
                <div className="flex items-start gap-3">
                  <p className="flex-1 text-sm text-foreground">{message}</p>
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

      <Sidebar
        conversations={conversations}
        activeId={activeConvId}
        onSelect={handleSelect}
        onCreate={handleCreate}
        onDelete={handleDelete}
        onRename={handleRename}
        onOpenPalette={openCommandPalette}
      >
        {jobs.length > 0 && (
          <div className="space-y-2 border-t border-border px-3 py-3">
            <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Agentes
            </p>
            {jobs.map((job) => (
              <AgentJobCard key={job.id} job={job} onCancel={cancelJob} />
            ))}
          </div>
        )}

        <VoiceSettings
          settings={settings}
          live={status === "live"}
          onChangeVoice={(voice) => void handleVoiceChange(voice)}
          onChangeSpeed={(speed) => void handleSpeedChange(speed)}
        />

        <CostPanel
          sessionUsd={sessionUsd}
          costs={costs}
          credits={credits}
          refreshing={creditsLoading}
          onRefresh={() => void refreshCredits()}
        />
      </Sidebar>

      {/* ── Main area ───────────────────────────────────────────── */}
      <main className="flex min-w-0 flex-1 flex-col">
        {/* Source: full picker while choosing, one line once the call is open */}
        <div className="border-b border-border px-4 py-3">
          <div className="mx-auto max-w-3xl">
            {status === "live" && materials.length > 0 ? (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2 py-0.5 font-medium text-emerald-400">
                  <span className="size-1.5 rounded-full bg-emerald-400" />
                  ao vivo
                </span>
                {materials.map((material) => (
                  <span
                    key={material.id}
                    className="rounded-full border border-border px-2 py-0.5 text-foreground"
                    title={material.origin ?? material.label}
                  >
                    {material.label}
                  </span>
                ))}
                <span className="text-muted-foreground">
                  · encerre para trocar de material
                </span>
                <span className="ml-auto tabular-nums text-muted-foreground">
                  ${sessionUsd.toFixed(4)} nesta sessão
                </span>
              </div>
            ) : (
              <MaterialPicker
                materials={materials}
                busy={sourceBusy}
                disabled={!activeConvId}
                onAdd={(spec) => void handleMaterialAdd(spec)}
                onRemove={(id) => void handleMaterialRemove(id)}
              />
            )}
          </div>
        </div>

        {/* Transcript */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4">
          {historyLoading && historyMessages.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <div className="mx-auto w-full max-w-3xl space-y-4 px-4">
                <div className="flex justify-end">
                  <div className="h-16 w-2/3 animate-pulse rounded-2xl bg-muted" />
                </div>
                <div className="flex justify-start">
                  <div className="h-24 w-3/4 animate-pulse rounded-2xl bg-muted" />
                </div>
              </div>
            </div>
          ) : historyMessages.length > 0 || transcript.length > 0 ? (
            <div className="mx-auto max-w-3xl space-y-4" aria-live="polite">
              {/* "Carregar mais" at the top — fetches older messages before the earliest loaded */}
              {historyHasMore && (
                <div className="flex justify-center">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void handleLoadMore()}
                    className="text-xs text-muted-foreground"
                  >
                    Carregar mais
                  </Button>
                </div>
              )}

              {/* Historical messages from disk */}
              {historyMessages.length > 0 && (
                <>
                  <div className="flex items-center gap-3 py-1">
                    <div className="h-px flex-1 bg-border" />
                    <span className="shrink-0 text-xs text-muted-foreground">
                      Historico
                    </span>
                    <div className="h-px flex-1 bg-border" />
                  </div>
                  {historyMessages.map((msg) => (
                    <div key={msg.id} className="opacity-90">
                      {msg.role === "tool" ? (
                        <ToolTrace content={msg.content ?? ""} />
                      ) : msg.role === "agent" ? (
                        <div className="rounded-lg border border-primary/30 bg-primary/5 p-3">
                          <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-primary">
                            Agente pi
                          </p>
                          <p className="whitespace-pre-wrap text-sm text-foreground">
                            {msg.content}
                          </p>
                        </div>
                      ) : msg.role === "system" ? (
                        <p className="text-xs italic text-muted-foreground">
                          {msg.content}
                        </p>
                      ) : msg.content ? (
                        <ChatBubble
                          role={msg.role === "user" ? "user" : "assistant"}
                          content={msg.content}
                          timestamp={msg.timestamp}
                        />
                      ) : null}
                    </div>
                  ))}
                </>
              )}

              {/* Divider between history and what is happening right now */}
              {historyMessages.length > 0 && transcript.length > 0 && (
                <div className="flex items-center gap-3 py-1">
                  <div className="h-px flex-1 bg-border" />
                  <span className="shrink-0 text-xs font-medium text-emerald-400">
                    Ao vivo
                  </span>
                  <div className="h-px flex-1 bg-border" />
                </div>
              )}

              {/* Live transcript from the WebRTC session */}
              {transcript.map((entry) => (
                <div key={entry.id}>
                  {entry.role === "tool" ? (
                    <ToolTrace content={entry.text} />
                  ) : entry.role === "agent" ? (
                    <div className="rounded-lg border border-primary/30 bg-primary/5 p-3">
                      <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-primary">
                        Agente pi
                      </p>
                      <p className="whitespace-pre-wrap text-sm text-foreground">
                        {entry.text}
                      </p>
                    </div>
                  ) : (
                    entry.text && (
                      <ChatBubble
                        role={entry.role === "user" ? "user" : "assistant"}
                        content={entry.text}
                        timestamp={entry.timestamp}
                      />
                    )
                  )}
                </div>
              ))}

              {activeTool && (
                <p className="text-xs text-muted-foreground">
                  Usando {activeTool}…
                </p>
              )}
            </div>
          ) : (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={transition}
              className="flex h-full items-center justify-center"
            >
              <div className="max-w-md text-center">
                <p className="mb-2 text-lg font-medium text-foreground">
                  {greeting ?? "Adicione um material"}
                </p>
                <p className="text-sm text-muted-foreground">
                  {materials.length > 0
                    ? "Clique no botao abaixo e comece a falar. Eu escuto, respondo em voz e uso ferramentas quando preciso."
                    : "Aponte para um repositorio do GitHub ou uma pasta desta maquina, cole um markdown, ou inclua a documentacao do computador. Pode somar quantos quiser."}
                </p>
              </div>
            </motion.div>
          )}

          {/* Standalone chat response (no live session) */}
          {status !== "live" && (
            <div className="mx-auto mt-4 max-w-3xl">
              <ChatResponse
                directAnswer={directAnswer}
                reactEvents={reactEvents}
                error={chatError}
                isSending={chatSending}
                showVoiceHint={showVoiceHint}
                canConnectVoice={materials.length > 0}
                onConnectVoice={() => {
                  setShowVoiceHint(false);
                  void connect();
                }}
              />
            </div>
          )}
        </div>

        {/* ── Bottom bar ──────────────────────────────────────── */}
        <div className="border-t border-border p-4">
          <div className="mx-auto flex max-w-3xl items-center gap-4">
            <MicButton
              state={micState}
              onConnect={() => void connect()}
              onDisconnect={disconnect}
              disabled={materials.length === 0}
            />

            <div className="flex flex-1 items-center gap-2 rounded-full border border-border bg-background px-4 py-2">
              <input
                ref={inputRef}
                type="text"
                value={textInput}
                disabled={!activeConvId}
                onChange={(e) => setTextInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleTextSubmit();
                  }
                }}
                placeholder={
                  !activeConvId
                    ? "Selecione uma conversa para começar"
                    : status === "live"
                      ? "Fale ou digite algo..."
                      : "Digite uma pergunta..."
                }
                className="flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
              />
              <button
                type="button"
                onClick={handleTextSubmit}
                disabled={!textInput.trim() || !activeConvId}
                className="inline-flex size-8 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                aria-label="Enviar"
              >
                <Send className="size-4" />
              </button>
            </div>
          </div>

          {runningJobs.length > 0 && (
            <p className="mx-auto mt-3 max-w-3xl text-xs text-muted-foreground">
              {runningJobs.length} agente(s) trabalhando em segundo plano — a
              conversa continua normalmente.
            </p>
          )}
        </div>
      </main>

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
