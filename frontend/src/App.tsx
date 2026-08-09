import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { motion } from "motion/react";
import { Plus, RefreshCw, Send } from "lucide-react";
import { cn } from "@/lib/utils";
import { useMotionUITransition } from "@/components/motion-ui/ui-theme";
import {
  useToastStack,
  ToastStack,
  Toast,
} from "@/components/motion-ui/toast-stack";
import { Skeleton } from "@/components/motion-ui/skeleton";
import {
  SetupScreen,
  electronBridge,
  isSetupDismissed,
  shouldShowSetup,
} from "@/components/SetupScreen";
import { Sidebar } from "@/components/ui/Sidebar";
import { ChatBubble } from "@/components/ui/ChatBubble";
import { ToolTrace } from "@/components/ui/ToolTrace";
import { MicButton, type MicButtonState } from "@/components/ui/MicButton";
import { MaterialPicker } from "@/components/ui/MaterialPicker";
import { AgentJobCard } from "@/components/ui/AgentJobCard";
import { VoiceSettings } from "@/components/ui/VoiceSettings";
import { CostPanel } from "@/components/ui/CostPanel";
import { DeepThinkCard } from "@/components/ui/DeepThinkCard";
import { MemoryPanel } from "@/components/ui/MemoryPanel";
import { MermaidDiagram } from "@/components/ui/MermaidDiagram";
import { Button } from "@/components/ui/button";
import { MobileTopBar } from "@/components/ui/MobileTopBar";
import { ConversationsSheet } from "@/components/ui/ConversationsSheet";
import { PanelsSheet } from "@/components/ui/PanelsSheet";
import { SessionAlerts } from "@/components/ui/SessionAlerts";
import { FirstRun } from "@/components/ui/FirstRun";
import { ProviderKeysPrompt } from "@/components/ui/ProviderKeysPrompt";
import { shouldShowFirstRun } from "@/components/ui/mobile-shell";
import { useCompactLayout } from "@/components/ui/use-compact-layout";
import * as api from "@/lib/api";
import {
  mergeConversationItems,
  useRealtimeSession,
} from "@/hooks/useRealtimeSession";
import type {
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
  const scrollRef = useRef<HTMLDivElement>(null);

  // ── Electron first-run gate ────────────────────────────────────
  // Only the Electron build has a usable preload bridge and a key store; a
  // plain browser has neither, so the setup screen exists only for the former.
  // The initial value comes from the module so a remount inside the same window
  // does not ask a question the user already answered — `SetupScreen` owns both
  // the rule and the memory, and this is the only place that reads them.
  const [setupDismissed, setSetupDismissed] = useState(isSetupDismissed);
  const completeSetup = useCallback(() => setSetupDismissed(true), []);
  const showSetup = shouldShowSetup({
    bridge: electronBridge(),
    dismissed: setupDismissed,
  });

  // ── Live voice session ────────────────────────────────────────
  const {
    status,
    error: sessionError,
    transcript,
    userSpeaking,
    assistantSpeaking,
    activeTool,
    jobs,
    deepThinkJobs,
    diagrams,
    resumed,
    memoryEvents,
    sessionUsd,
    connect,
    disconnect,
    sendText,
    cancelJob,
    reloadMemory,
    setSpeed,
    micFailure,
    audioBlocked,
    playAudio,
    callDropped,
  } = useRealtimeSession(activeConvId);

  // Which shell is on screen. This is a JavaScript decision and not a `md:`
  // utility because the rail and the two sheets hold the same panels: mounting
  // both copies would fetch the memory twice and hand the same Motion
  // `layoutId` to two elements, one of them invisible.
  const compact = useCompactLayout();
  const [navOpen, setNavOpen] = useState(false);
  const [panelsOpen, setPanelsOpen] = useState(false);
  const [firstRunDismissed, setFirstRunDismissed] = useState(false);
  // Session-only, like the setup gate's own flag: a reload asks again while
  // the keys are still missing, which is the honest cost of no storage.
  const [providerKeysDismissed, setProviderKeysDismissed] = useState(false);

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

  // One column, in the order things happened: a diagram belongs to the turn
  // that asked for it, and a resumed conversation brings its old drawings back
  // dated before today's first sentence.
  const conversationItems = useMemo(
    () => mergeConversationItems(transcript, diagrams),
    [transcript, diagrams],
  );

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

  // A microphone that will not open is reported by `SessionAlerts`, which keeps
  // the sentence on screen and puts a link or a button under it. Toasting the
  // same message would say it twice and take it away after five seconds — and
  // the certificate instructions are four sentences long.
  useEffect(() => {
    if (sessionError && !micFailure) showError(sessionError);
  }, [sessionError, micFailure, showError]);

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

  // Follow the conversation as it grows. A diagram is taller than a turn, so it
  // is the one thing that most needs scrolling to.
  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [transcript, diagrams]);

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

  // Choosing is the drawer's whole purpose, so it gets out of the way behind
  // the choice instead of leaving the transcript covered.
  const selectFromSheet = useCallback(
    (id: string) => {
      setNavOpen(false);
      handleSelect(id);
    },
    [handleSelect],
  );

  const createFromSheet = useCallback(() => {
    setNavOpen(false);
    void handleCreate();
  }, [handleCreate]);

  // The sheet is a native modal `<dialog>` and the palette portals to the body,
  // so a palette opened underneath it would be inert — visible and dead. The
  // sheet closes first, and the palette is then the only modal on the page.
  const searchFromSheet = useCallback(() => {
    setNavOpen(false);
    openCommandPalette();
  }, [openCommandPalette]);

  // ── Materials ─────────────────────────────────────────────────
  /** Resolves to whether the material actually landed, so a caller can chain. */
  const handleMaterialAdd = useCallback(
    async (spec: SourceSpec): Promise<boolean> => {
      if (!activeConvId) return false;
      setSourceBusy(true);
      try {
        const envelope = await api.addMaterial(activeConvId, spec);
        setMaterials(envelope.materials);
        setGreeting(envelope.greeting);
        setConversations(await api.listConversations());
        return true;
      } catch (err) {
        showError(
          err instanceof Error ? err.message : "Não foi possível carregar o material.",
        );
        return false;
      } finally {
        setSourceBusy(false);
      }
    },
    [activeConvId, showError],
  );

  // One tap does both halves of first contact. Splitting them is where the
  // first call gets lost: a phone that has just been told what the app is
  // should not then be asked to find a second button.
  //
  // The await spends the tap, so WebKit may refuse to start the voice — that
  // refusal is what `audioBlocked` is for, and it puts "Tocar áudio" on screen
  // inside a gesture of its own.
  const startFromFirstRun = useCallback(
    async (spec: SourceSpec) => {
      if (await handleMaterialAdd(spec)) await connect();
    },
    [connect, handleMaterialAdd],
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
  const handleTextSubmit = useCallback(() => {
    if (!textInput.trim() || status !== "live") return;
    sendText(textInput.trim());
    setTextInput("");
    inputRef.current?.focus();
  }, [textInput, status, sendText]);

  const runningJobs = jobs.filter((job) => job.status === "running");

  // ── First-launch setup ────────────────────────────────────────
  // Electron asks for the API keys before the dashboard loads; every way out of
  // that screen — a key already saved, a key entered, the skip link, a settings
  // read that never answers, the screen crashing — calls `onComplete` and drops
  // into the app below like any other first render.
  if (showSetup) {
    return <SetupScreen onComplete={completeSetup} />;
  }

  // ── Loading / error screen ────────────────────────────────────
  if (isLoading || loadError) {
    return (
      <div className="dark flex h-dvh overflow-hidden bg-background text-foreground">
        <aside className="hidden w-72 shrink-0 flex-col gap-2 border-r border-border bg-muted/20 px-3 py-4 md:flex">
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

  // ── The four panels, placed twice ─────────────────────────────
  // Written once and mounted in exactly one of two places: the lower half of
  // the rail on desktop, the four tabs of the ⋯ sheet on a phone. `compact`
  // decides, so only one copy exists — two `MemoryPanel`s would each fetch, and
  // two `Sidebar`s would claim the same `layoutId`.
  const agentsPanel =
    jobs.length > 0 || deepThinkJobs.length > 0 ? (
      <div
        className={cn(
          "space-y-2",
          compact ? "pb-1" : "border-t border-border px-3 py-3",
        )}
      >
        {/* Both kinds of background work under one heading: the user dispatched
            "um agente" either way, and two headings would suggest two places to
            look. `deepThinkJobs` stays empty for good on a server without a
            BRAVE_API_KEY — the tools simply are not in the session — so an empty
            list here is the ordinary case and never an error. In the sheet the
            tab is already called Agentes, so the heading only repeats itself. */}
        {!compact && (
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Agentes
          </p>
        )}
        {jobs.map((job) => (
          <AgentJobCard key={job.id} job={job} onCancel={cancelJob} />
        ))}
        {/* No `onCancel`: `POST /api/agents/:jobId/cancel` resolves the id
            through the pi job registry, so a round's id 404s there. The card
            hides the button when the prop is absent rather than offering one
            that cannot work. */}
        {deepThinkJobs.map((job) => (
          <DeepThinkCard key={job.id} job={job} />
        ))}
      </div>
    ) : (
      // The rail simply omits the section; a tab cannot omit itself.
      compact && (
        <p className="py-6 text-center text-xs text-muted-foreground">
          Nenhum agente trabalhando agora.
        </p>
      )
    );

  const voicePanel = (
    <VoiceSettings
      settings={settings}
      live={status === "live"}
      onChangeVoice={(voice) => void handleVoiceChange(voice)}
      onChangeSpeed={(speed) => void handleSpeedChange(speed)}
    />
  );

  const costsPanel = (
    <CostPanel
      sessionUsd={sessionUsd}
      costs={costs}
      credits={credits}
      refreshing={creditsLoading}
      onRefresh={() => void refreshCredits()}
    />
  );

  // `status` as the reload trigger: the memory grows during a call, so the
  // count on this line is stale exactly when a call ends. Importing or erasing
  // replaces the file — drawings included — which is why `onChanged` re-seeds
  // the gallery instead of only redrawing here.
  const memoryPanel = (
    <MemoryPanel
      conversationId={activeConvId}
      refreshToken={status}
      onChanged={reloadMemory}
    />
  );

  // ── Render ────────────────────────────────────────────────────
  return (
    <div className="dark flex h-dvh overflow-hidden bg-background text-foreground">
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

      {!compact && (
        <Sidebar
          conversations={conversations}
          activeId={activeConvId}
          onSelect={handleSelect}
          onCreate={handleCreate}
          onDelete={handleDelete}
          onRename={handleRename}
          onOpenPalette={openCommandPalette}
        >
          {agentsPanel}
          {voicePanel}
          {costsPanel}
          {memoryPanel}
        </Sidebar>
      )}

      {/* ── Main area ───────────────────────────────────────────── */}
      <main className="flex min-w-0 flex-1 flex-col">
        {/* On a phone the rail's 288px left 72px for the conversation, so it is
            behind ☰ and the panels behind ⋯. What a rail shows without being
            asked — where you are, whether the call is running, what it costs,
            whether an agent is still working — moves into this bar. */}
        {compact && (
          <MobileTopBar
            title={
              conversations.find((c) => c.id === activeConvId)?.title ??
              "Explainer"
            }
            live={status === "live"}
            connecting={status === "connecting"}
            sessionUsd={sessionUsd}
            runningJobs={runningJobs.length}
            onOpenConversations={() => setNavOpen(true)}
            onOpenPanels={() => setPanelsOpen(true)}
          />
        )}

        {/* The browser has no key store, so a missing key is a reminder, not a
            gate: the card asks, the user can close it, and the app works
            without it. Electron's own gate answers before this line and never
            reaches here. */}
        {!providerKeysDismissed && (
          <ProviderKeysPrompt
            onDismiss={() => setProviderKeysDismissed(true)}
          />
        )}

        {/* Source: full picker while choosing, one line once the call is open */}
        <div className="border-b border-border px-3 py-2 md:px-4 md:py-3">
          <div className="mx-auto max-w-3xl">
            {status === "live" && materials.length > 0 ? (
              // Wrapping put this row on four lines at 360px. On a phone it is
              // one line that scrolls sideways instead, and the two parts the
              // top bar already carries — that the call is live, what it has
              // cost — are dropped rather than repeated.
              <div
                className={cn(
                  "flex items-center gap-x-2 gap-y-1 text-xs",
                  compact
                    ? "-mx-3 overflow-x-auto px-3 [&>*]:shrink-0"
                    : "flex-wrap",
                )}
              >
                {!compact && (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2 py-0.5 font-medium text-emerald-400">
                    <span className="size-1.5 rounded-full bg-emerald-400" />
                    ao vivo
                  </span>
                )}

                {/* The one thing the user cannot otherwise tell apart: a session
                    that starts fresh and one that was handed the summary of
                    everything said before. The resume itself never leaves the
                    server, so this count is all the evidence there is that it
                    happened. */}
                {resumed && (
                  <span
                    className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2 py-0.5 font-medium text-primary"
                    title="Esta conversa foi retomada: o modelo recebeu um resumo do que já foi dito."
                  >
                    <span className="size-1.5 rounded-full bg-primary" />
                    retomando · {memoryEvents}{" "}
                    {memoryEvents === 1 ? "evento" : "eventos"}
                  </span>
                )}
                {materials.map((material) => (
                  <span
                    key={material.id}
                    className="rounded-full border border-border px-2 py-0.5 text-foreground"
                    title={material.origin ?? material.label}
                  >
                    {material.label}
                  </span>
                ))}
                {!compact && (
                  <>
                    <span className="text-muted-foreground">
                      · encerre para trocar de material
                    </span>
                    <span className="ml-auto tabular-nums text-muted-foreground">
                      ${sessionUsd.toFixed(4)} nesta sessão
                    </span>
                  </>
                )}
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
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 md:p-4">
          {conversationItems.length > 0 ? (
            <div className="mx-auto max-w-3xl space-y-4" aria-live="polite">
              {conversationItems.map((item) => {
                // Full width, in the flow, and not inside a ChatBubble: a
                // drawing is the answer to the turn that asked for it, and the
                // model has already spoken its caption by the time it lands.
                if (item.kind === "diagram") {
                  return <MermaidDiagram key={item.key} diagram={item.diagram} />;
                }

                const entry = item.entry;
                return (
                  <div key={item.key}>
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
                );
              })}

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
                    ? "Clique no botão abaixo e comece a falar. Eu escuto, respondo em voz e uso ferramentas quando preciso."
                    : "Aponte para um repositório do GitHub ou uma pasta desta máquina, cole um markdown, ou inclua a documentação do computador. Pode somar quantos quiser."}
                </p>
              </div>
            </motion.div>
          )}
        </div>

        {/* ── Bottom bar ──────────────────────────────────────── */}
        <div
          className={cn(
            "sticky bottom-0 border-t border-border bg-background p-3 md:p-4",
            // viewport-fit=cover puts the last row of pixels behind the home
            // indicator; without this the send button is under it.
            compact && "pb-[max(0.75rem,env(safe-area-inset-bottom))]",
          )}
        >
          <SessionAlerts
            micFailure={micFailure}
            micMessage={sessionError}
            audioBlocked={audioBlocked}
            callDropped={callDropped}
            onRetry={() => void connect()}
            onPlayAudio={playAudio}
          />

          {/* Reversed on a phone: the 64px microphone is the one control that
              has to be reachable one-handed, and that is the bottom right. */}
          <div className="mx-auto flex max-w-3xl flex-row-reverse items-center gap-3 md:flex-row md:gap-4">
            <div className="shrink-0">
              <MicButton
                state={micState}
                onConnect={() => void connect()}
                onDisconnect={disconnect}
                disabled={materials.length === 0}
              />
            </div>

            <div
              className={cn(
                "flex flex-1 items-center gap-2 rounded-full border border-border bg-background px-4 py-2",
                status !== "live" && "opacity-60",
              )}
            >
              <input
                ref={inputRef}
                type="text"
                value={textInput}
                disabled={status !== "live"}
                onChange={(e) => setTextInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleTextSubmit();
                  }
                }}
                placeholder={
                  status === "live"
                    ? "Ou digite, se preferir…"
                    : "Conecte para conversar"
                }
                // 16px on a phone: iOS Safari zooms the page in when a field
                // under 16px takes focus, and it never zooms back out.
                className="min-w-0 flex-1 bg-transparent text-base text-foreground outline-none placeholder:text-muted-foreground md:text-sm"
              />
              <button
                type="button"
                onClick={handleTextSubmit}
                disabled={!textInput.trim() || status !== "live"}
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

      {/* ── The two drawers ─────────────────────────────────────── */}
      {compact && (
        <>
          <ConversationsSheet
            open={navOpen}
            onOpenChange={setNavOpen}
            onSearch={searchFromSheet}
          >
            <Sidebar
              conversations={conversations}
              activeId={activeConvId}
              onSelect={selectFromSheet}
              onCreate={createFromSheet}
              onDelete={handleDelete}
              onRename={handleRename}
              onOpenPalette={searchFromSheet}
            />
          </ConversationsSheet>

          <PanelsSheet
            open={panelsOpen}
            onOpenChange={setPanelsOpen}
            agents={agentsPanel}
            voice={voicePanel}
            cost={costsPanel}
            memory={memoryPanel}
          />
        </>
      )}

      {/* First contact. `othersPresent` is hard-coded false: presence lands with
          the shared-call work, and inventing it here would drop an onboarding
          card over a call somebody else is already in. When the roster exists,
          this is the one line that reads it. */}
      {shouldShowFirstRun({
        compact,
        materialCount: materials.length,
        conversationItemCount: conversationItems.length,
        dismissed: firstRunDismissed,
        othersPresent: false,
      }) && (
        <FirstRun
          busy={sourceBusy}
          onStart={(spec) => void startFromFirstRun(spec)}
          onDismiss={() => setFirstRunDismissed(true)}
        />
      )}

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
