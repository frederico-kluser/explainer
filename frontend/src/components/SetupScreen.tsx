import {
  Component,
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

// How long the first settings read may take before the app opens without it.
// `settings:get` is a local disk read behind a Zod-validated channel, so this
// is far past its worst case; what it really covers is an `ipcRenderer.invoke`
// on a channel the main process never registered, which never settles at all —
// neither resolving nor rejecting. Waiting on that forever is how the skeleton
// became the entire application, so the wait is bounded and the app wins.
const SETTINGS_READ_TIMEOUT_MS = 4000;

type Phase =
  | "loading" // reading the settings store through IPC
  | "empty" // no key saved — show the form
  | "validating" // key being checked against the provider
  | "invalid" // key failed validation (or the call to validate it failed)
  | "success" // key saved — checkmark, then auto-advance
  | "error" // the initial settings read failed — error card with retry
  | "configured"; // a key already exists — checkmark, then auto-advance

/**
 * Whether `window.api` is a bridge this screen can actually use.
 *
 * `isElectron` alone is not enough. `contextBridge.exposeInMainWorld` runs
 * inside a `try` in the preload, so a failure partway through leaves the flag
 * on the window without the calls behind it — and the old gate, which read
 * only the flag, then mounted a screen whose first `settings.get()` throws
 * over an app the user could no longer reach. A partial bridge is treated as
 * no bridge, which is the browser path: render the app.
 *
 * Every call this screen makes is listed, `app.openExternal` included. Leaving
 * it out let a bridge through that the screen then dereferenced on the "Onde
 * encontro minha chave?" button — `Cannot read properties of undefined` inside
 * a click handler, which the error boundary above only catches during render.
 */
export function hasSetupBridge(
  candidate: unknown,
): candidate is ExplainerElectronApi {
  if (typeof candidate !== "object" || candidate === null) return false;
  const api = candidate as Partial<ExplainerElectronApi>;
  return (
    api.isElectron === true &&
    typeof api.settings?.get === "function" &&
    typeof api.settings?.saveApiKey === "function" &&
    typeof api.settings?.validateApiKey === "function" &&
    typeof api.app?.openExternal === "function"
  );
}

/** `window.api` as this renderer found it, or `undefined` — in a browser, and
 *  in any environment without a `window` at all. */
export function electronBridge(): ExplainerElectronApi | undefined {
  if (typeof window === "undefined") return undefined;
  return hasSetupBridge(window.api) ? window.api : undefined;
}

export interface SetupGateInput {
  /** The preload bridge as the renderer found it. Deliberately `unknown`: the
   *  point of the check is that the declared type may be a lie. */
  bridge: unknown;
  /** The user already finished or skipped the setup. */
  dismissed: boolean;
}

/**
 * The one decision that can hide the whole application, written once so the
 * caller and the test read the same rule. Every answer other than "a usable
 * bridge and an unanswered question" renders the app: the setup is optional,
 * the app is not.
 */
export function shouldShowSetup({ bridge, dismissed }: SetupGateInput): boolean {
  return !dismissed && hasSetupBridge(bridge);
}

// Whether the setup was already finished or skipped in this window.
//
// It lives in the module and not in the settings store because there is no
// honest place for it there: `settings:set` accepts `language` and `theme` and
// drops everything else (`electron/main/ipc/settings-handlers.ts`), and opening
// a second store next to the encrypted one is a bigger decision than a gate.
// So the assumption is explicit — the answer survives a React remount, which is
// what re-asked the question three times in a row, and not a reload. A reload
// with a key saved answers itself through `configured`; a reload after a skip
// asks once more, which is the honest cost of not having a field to write to.
let dismissedThisSession = false;

/** Whether the setup has already been answered in this window. */
export function isSetupDismissed(): boolean {
  return dismissedThisSession;
}

/** Records that the setup was finished or skipped. */
export function markSetupDismissed(): void {
  dismissedThisSession = true;
}

/** Tests only: the flag outlives any component, so a suite has to clear it. */
export function resetSetupDismissed(): void {
  dismissedThisSession = false;
}

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
 * A usable `window.api` exists only when the preload script injected the whole
 * bridge, so a plain browser — and a half-injected one — renders `children`
 * (or nothing) and the backend keeps using its environment key as before.
 * Inside Electron the screen reads the settings store, shows the form when no
 * key is saved, and calls `onComplete` once one is.
 *
 * Every exit from this screen goes through `finish`, so "the user answered" is
 * recorded no matter which door was used: the saved key, the form, the skip
 * link, the read timeout, or the screen crashing.
 */
export function SetupScreen({ onComplete, children }: SetupScreenProps) {
  const finish = useCallback(() => {
    markSetupDismissed();
    onComplete();
  }, [onComplete]);

  // `electronBridge()` and not `window.api` directly: this component is also
  // mounted by tests and could one day be rendered without a `window` at all,
  // and a gate that throws is the blankest screen of the lot.
  if (!electronBridge()) return children ?? null;
  return (
    <SetupBoundary onFail={finish}>
      <SetupScreenInner onComplete={finish} />
    </SetupBoundary>
  );
}

/**
 * Turns a crash inside the setup screen into an open app.
 *
 * Without it React unmounts the whole tree on an error thrown during render,
 * and the window the user is left with is blank and has no way back — the exact
 * dead end this gate must never be. Handing over to `onFail` costs the setup and
 * keeps the app, which is the right trade in both directions.
 */
export class SetupBoundary extends Component<
  { onFail: () => void; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("[SetupScreen] crashed — opening the app without it:", error);
    this.props.onFail();
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function SetupScreenInner({ onComplete }: { onComplete: () => void }) {
  // The wrapper above verified the bridge exists — this discharges that same
  // guard once, so every call below is typed without repetition.
  const api: ExplainerElectronApi = window.api!;

  const [phase, setPhase] = useState<Phase>("loading");
  const [apiKey, setApiKey] = useState("");
  const [openRouterKey, setOpenRouterKey] = useState("");
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

  // `onComplete` through a ref so `complete` never changes identity. The parent
  // passes an inline arrow and re-renders on its own schedule — conversations
  // loading, credits arriving, a toast expiring — and with `onComplete` in the
  // dependency array every one of those re-renders cancelled and restarted the
  // auto-advance timer below. A parent that re-renders faster than the timeout
  // postpones it forever, which is a checkmark that never becomes the app.
  const onCompleteRef = useRef(onComplete);
  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  const transition = useMotionUITransition("gentle");

  const complete = useCallback(() => {
    if (completedRef.current) return;
    completedRef.current = true;
    onCompleteRef.current();
  }, []);

  // Reads the store on mount (and on retry). A saved key skips the form; every
  // other outcome — no key, a refused read, a main process that never answers —
  // lands on a state the user can leave.
  useEffect(() => {
    let settled = false;

    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      complete();
    }, SETTINGS_READ_TIMEOUT_MS);

    const finish = (apply: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      apply();
    };

    void (async () => {
      try {
        const res = await api.settings.get();
        if (!res.success) {
          finish(() => {
            setPhase("error");
            setError(res.error ?? "Não foi possível ler as configurações.");
          });
          return;
        }
        const saved = res.data?.apiKeys?.openai;
        finish(() => {
          // A present key that is not known-bad is a configured app. Demanding
          // `validationStatus === "valid"` locked the user out of their own
          // app: `settings:save-api-key` persists with `'idle'` and nothing in
          // the main process ever writes `'valid'`, so a key validated against
          // the provider and saved one second earlier came back as unconfigured
          // on the next launch, and on every launch after that.
          setPhase(
            saved?.key && saved.validationStatus !== "invalid"
              ? "configured"
              : "empty",
          );
        });
      } catch {
        finish(() => {
          setPhase("error");
          setError("Não foi possível ler as configurações.");
        });
      }
    })();

    return () => {
      settled = true;
      window.clearTimeout(timer);
    };
  }, [api, checkAttempt, complete]);

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
        // OpenRouter is optional but, when filled, is held to the same
        // standard as the OpenAI key: the form only advances with keys it
        // could validate. (The admin key below is the one stored unvalidated.)
        const routerKey = openRouterKey.trim();
        if (routerKey) {
          const routerValidation = await api.settings.validateApiKey(routerKey, "openrouter");
          if (!routerValidation.success) {
            setPhase("invalid");
            setError(
              routerValidation.error ??
                "Não foi possível validar a chave do OpenRouter. Tente novamente.",
            );
            return;
          }
          if (!routerValidation.data?.valid) {
            setPhase("invalid");
            setError(
              routerValidation.data?.error ??
                "Chave do OpenRouter inválida. Confira e tente novamente.",
            );
            return;
          }
          const routerSaved = await api.settings.saveApiKey(routerKey, "openrouter");
          if (!routerSaved.success) {
            setPhase("invalid");
            setError(
              routerSaved.error ?? "Não foi possível salvar a chave do OpenRouter. Tente novamente.",
            );
            return;
          }
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
    [api, apiKey, adminKey, openRouterKey],
  );

  const openKeysHelp = useCallback(() => {
    // No fallback: this screen only ever mounts behind `hasSetupBridge`, which
    // now checks this exact call. A `window.open` alternative here would be a
    // second opinion on whether the bridge is usable, and the two would drift.
    void api.app.openExternal(OPENAI_KEYS_URL);
  }, [api]);

  const inputClasses =
    "rounded-lg border border-border bg-background text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-ring focus:ring-3 focus:ring-ring/50 disabled:opacity-50";

  return (
    <div className="dark flex h-screen items-center justify-center overflow-hidden bg-background p-4 text-foreground">
      {phase === "loading" ? (
        <LoadingState onSkip={complete} />
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

                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    OPENROUTER_API_KEY
                  </span>
                  <div className="relative">
                    <KeyRound className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <input
                      type={showKey ? "text" : "password"}
                      value={openRouterKey}
                      onChange={(event) => setOpenRouterKey(event.target.value)}
                      disabled={phase === "validating"}
                      placeholder="sk-or-…"
                      autoComplete="off"
                      spellCheck={false}
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
                  <p className="mt-1 text-xs text-muted-foreground">
                    Opcional — para usar os modelos de pensamento via OpenRouter.
                  </p>
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

/**
 * Centered skeleton previewing the card while the store is being read.
 *
 * The skip link is on it because `SETTINGS_READ_TIMEOUT_MS` is four seconds of
 * bones with no explanation, and a user who does not want the setup at all
 * should not have to wait out a read to say so.
 */
function LoadingState({ onSkip }: { onSkip: () => void }) {
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
      <div className="mt-6 flex justify-center">
        <button
          type="button"
          onClick={onSkip}
          className="text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          Pular configuração
        </button>
      </div>
    </div>
  );
}
