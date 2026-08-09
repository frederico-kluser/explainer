import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { motion } from "motion/react";
import {
  Check,
  ChevronDown,
  CircleAlert,
  Eye,
  EyeOff,
  ExternalLink,
  KeyRound,
  Loader2,
  Mic,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useMotionUITransition } from "@/components/motion-ui/ui-theme";
import { Skeleton } from "@/components/motion-ui/skeleton";
import { Button } from "@/components/ui/button";
import type { ExplainerElectronApi } from "@/types/electron";

const OPENAI_KEYS_URL = "https://platform.openai.com/api-keys";

// How long the "saved" / "already configured" states stay on screen before the
// main app takes over — a scan pause for the eye, not a motion timing.
const AUTO_CONTINUE_MS = 1000;

type Phase =
  | "loading" // reading the settings store through IPC
  | "empty" // no valid key saved — show the form
  | "validating" // key being checked against the provider
  | "invalid" // key failed validation (or the call to validate it failed)
  | "success" // key saved — checkmark, then auto-advance
  | "error" // the initial settings read failed — error card with retry
  | "configured"; // a valid key already exists — checkmark, then auto-advance

export interface SetupScreenProps {
  onComplete: () => void;
  /** Rendered in place of the screen outside Electron — the browser build has
   *  no key store, so it must never see the setup UI. The parent normally
   *  gates on this; `children` just makes the component safe to mount
   *  standalone. */
  children?: ReactNode;
}

/**
 * First-launch key setup for the Electron build.
 *
 * `window.api` exists only when the preload script injected it, so a plain
 * browser renders `children` (or nothing) and the backend keeps using its
 * environment key as before. Inside Electron the screen reads the settings
 * store, shows the form when no valid key is saved, and calls `onComplete`
 * once one is.
 */
export function SetupScreen({ onComplete, children }: SetupScreenProps) {
  if (!window.api?.isElectron) return children ?? null;
  return <SetupScreenInner onComplete={onComplete} />;
}

function SetupScreenInner({ onComplete }: { onComplete: () => void }) {
  // The wrapper above verified the bridge exists — this discharges that same
  // guard once, so every call below is typed without repetition.
  const api: ExplainerElectronApi = window.api!;

  const [phase, setPhase] = useState<Phase>("loading");
  const [apiKey, setApiKey] = useState("");
  const [adminKey, setAdminKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumping this re-runs the settings-store read (the retry button).
  const [checkAttempt, setCheckAttempt] = useState(0);
  const completedRef = useRef(false);
  // Mirror of `phase` for callbacks: useCallback captures the value at render
  // time, and the submit guard needs the value at submit time.
  const phaseRef = useRef<Phase>("loading");
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  const transition = useMotionUITransition("gentle");

  const complete = useCallback(() => {
    if (completedRef.current) return;
    completedRef.current = true;
    onComplete();
  }, [onComplete]);

  // Reads the store on mount (and on retry). A saved and validated key skips
  // the form; everything else — no key, an unvalidated key, a failed read —
  // falls through to the states below.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.settings.get();
        if (cancelled) return;
        if (!res.success) {
          setPhase("error");
          setError(res.error ?? "Não foi possível ler as configurações.");
          return;
        }
        const saved = res.data?.apiKeys?.openai;
        if (saved?.key && saved.validationStatus === "valid") {
          setPhase("configured");
        } else {
          setPhase("empty");
        }
      } catch {
        if (!cancelled) {
          setPhase("error");
          setError("Não foi possível ler as configurações.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, checkAttempt]);

  const retry = useCallback(() => {
    setError(null);
    setCheckAttempt((attempt) => attempt + 1);
  }, []);

  // "configured" and "success" are terminal: show the checkmark long enough to
  // be read, then hand the app over.
  useEffect(() => {
    if (phase !== "configured" && phase !== "success") return;
    const timer = window.setTimeout(complete, AUTO_CONTINUE_MS);
    return () => window.clearTimeout(timer);
  }, [phase, complete]);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      // Enter can still submit while the button is disabled — ignore re-entry
      // while a validation round-trip is already in flight.
      if (phaseRef.current === "validating") return;
      const key = apiKey.trim();
      if (!key) {
        setPhase("invalid");
        setError("Digite sua chave da API para continuar.");
        return;
      }
      setPhase("validating");
      setError(null);
      try {
        const validation = await api.settings.validateApiKey(key);
        if (!validation.success) {
          setPhase("invalid");
          setError(
            validation.error ?? "Não foi possível validar a chave. Tente novamente.",
          );
          return;
        }
        if (!validation.data?.valid) {
          setPhase("invalid");
          setError(
            validation.data?.error ?? "Chave inválida. Confira e tente novamente.",
          );
          return;
        }
        const saved = await api.settings.saveApiKey(key);
        if (!saved.success) {
          setPhase("invalid");
          setError(saved.error ?? "Não foi possível salvar a chave. Tente novamente.");
          return;
        }
        // The admin key is the backend's business — stored without validation,
        // and a failure here never blocks the main flow.
        const admin = adminKey.trim();
        if (admin) {
          await api.settings.saveApiKey(admin, "openaiAdmin").catch(() => null);
        }
        setPhase("success");
      } catch {
        setPhase("invalid");
        setError("Ocorreu um erro ao salvar a chave. Tente novamente.");
      }
    },
    [api, apiKey, adminKey],
  );

  const openKeysHelp = useCallback(() => {
    // Electron opens the system browser; the window.open fallback exists so
    // the screen stays testable without the bridge.
    if (api.app.openExternal) {
      void api.app.openExternal(OPENAI_KEYS_URL);
    } else {
      window.open(OPENAI_KEYS_URL, "_blank", "noopener,noreferrer");
    }
  }, [api]);

  const inputClasses =
    "rounded-lg border border-border bg-background text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-ring focus:ring-3 focus:ring-ring/50 disabled:opacity-50";

  return (
    <div className="dark flex h-screen items-center justify-center overflow-hidden bg-background p-4 text-foreground">
      {phase === "loading" ? (
        <LoadingState />
      ) : phase === "error" ? (
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={transition}
          className="w-full max-w-md rounded-2xl border border-border bg-card p-8 text-center shadow-lg"
        >
          <CircleAlert className="mx-auto mb-4 size-10 text-destructive" />
          <h1 className="text-lg font-semibold text-foreground">
            Não foi possível ler as configurações
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">{error}</p>
          <Button className="mt-6 w-full" onClick={retry}>
            <RefreshCw className="mr-2 size-4" />
            Tentar novamente
          </Button>
          <button
            type="button"
            onClick={complete}
            className="mt-4 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            Pular configuração
          </button>
        </motion.div>
      ) : (
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={transition}
          className="w-full max-w-md rounded-2xl border border-border bg-card p-8 shadow-lg"
        >
          {phase === "configured" || phase === "success" ? (
            <div className="flex flex-col items-center py-4 text-center">
              <motion.div
                initial={{ opacity: 0, scale: 0.6 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={transition}
                className="flex size-14 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-400"
              >
                <Check className="size-7" strokeWidth={3} />
              </motion.div>
              <p className="mt-4 text-lg font-semibold text-foreground">
                {phase === "success" ? "Chave salva com sucesso!" : "Chave configurada"}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">Abrindo o Explainer…</p>
            </div>
          ) : (
            <>
              <div className="flex flex-col items-center text-center">
                <div className="flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                  <Mic className="size-7" />
                </div>
                <h1 className="mt-4 text-xl font-semibold text-foreground">
                  Bem-vindo ao Explainer
                </h1>
                <p className="mt-1.5 text-sm text-muted-foreground">
                  Configure sua chave da OpenAI para começar
                </p>
              </div>

              <form className="mt-8 space-y-4" onSubmit={handleSubmit}>
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    OPENAI_API_KEY
                  </span>
                  <div className="relative">
                    <KeyRound className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <input
                      type={showKey ? "text" : "password"}
                      value={apiKey}
                      onChange={(event) => setApiKey(event.target.value)}
                      disabled={phase === "validating"}
                      placeholder="sk-…"
                      autoComplete="off"
                      spellCheck={false}
                      autoFocus
                      className={cn(inputClasses, "h-10 w-full pl-9 pr-10")}
                    />
                    <button
                      type="button"
                      onClick={() => setShowKey((value) => !value)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-muted-foreground transition-colors hover:text-foreground"
                      aria-label={showKey ? "Ocultar chave" : "Mostrar chave"}
                    >
                      {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                    </button>
                  </div>
                </label>

                {/* Advanced section — collapsed by default; the admin key is
                    optional and its format is the backend's business. */}
                <div className="overflow-hidden rounded-lg border border-border">
                  <button
                    type="button"
                    onClick={() => setShowAdvanced((value) => !value)}
                    className="flex w-full items-center justify-between px-3.5 py-2.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
                    aria-expanded={showAdvanced}
                  >
                    <span className="inline-flex items-center gap-2">
                      <ShieldCheck className="size-4" />
                      Configurações avançadas
                    </span>
                    <ChevronDown
                      className={cn("size-4 transition-transform", showAdvanced && "rotate-180")}
                    />
                  </button>
                  {showAdvanced && (
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={transition}
                      className="border-t border-border p-3.5"
                    >
                      <label className="block">
                        <span className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-muted-foreground">
                          OPENAI_ADMIN_KEY
                        </span>
                        <input
                          type="password"
                          value={adminKey}
                          onChange={(event) => setAdminKey(event.target.value)}
                          disabled={phase === "validating"}
                          placeholder="Opcional"
                          autoComplete="off"
                          spellCheck={false}
                          className={cn(inputClasses, "h-9 w-full px-3")}
                        />
                      </label>
                    </motion.div>
                  )}
                </div>

                <Button
                  type="submit"
                  size="lg"
                  className="w-full"
                  disabled={phase === "validating"}
                >
                  {phase === "validating" ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      Validando…
                    </>
                  ) : (
                    "Validar e Salvar"
                  )}
                </Button>

                {phase === "invalid" && error && (
                  <div
                    role="alert"
                    className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
                  >
                    <CircleAlert className="mt-0.5 size-4 shrink-0" />
                    <span>{error}</span>
                  </div>
                )}
              </form>

              <div className="mt-6 flex items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={openKeysHelp}
                  className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
                >
                  Onde encontro minha chave?
                  <ExternalLink className="size-3.5" />
                </button>
                <button
                  type="button"
                  onClick={complete}
                  className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                >
                  Pular configuração
                </button>
              </div>
            </>
          )}
        </motion.div>
      )}
    </div>
  );
}

/** Centered skeleton previewing the card while the store is being read. */
function LoadingState() {
  return (
    <div className="w-full max-w-md">
      <div className="flex flex-col items-center gap-5">
        <Skeleton className="size-14 rounded-2xl" />
        <div className="flex w-full flex-col items-center gap-2">
          <Skeleton className="h-6 w-56" />
          <Skeleton className="h-4 w-72" />
        </div>
        <Skeleton className="h-10 w-full rounded-lg" />
        <Skeleton className="h-10 w-full rounded-lg" />
      </div>
      {/* The bones are decorative — this is the text they stand in for. */}
      <p className="sr-only" role="status">
        Verificando as configurações…
      </p>
    </div>
  );
}
