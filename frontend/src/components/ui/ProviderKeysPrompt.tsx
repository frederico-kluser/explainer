"use client";

import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { motion } from "motion/react";
import { Check, CircleAlert, KeyRound, Loader2, X } from "lucide-react";

import { useMotionUITransition } from "@/components/motion-ui/ui-theme";
import { Button } from "@/components/ui/button";
import * as api from "@/lib/api";
import type { ProviderKeyStatus, ProviderName } from "@/types";

export interface ProviderKeysPromptProps {
  /** Steps aside; the dashboard keeps working without keys. */
  onDismiss: () => void;
}

type Phase =
  | "unknown" // status not yet known, or keys present — nothing on screen
  | "missing" // both calling keys absent — the form
  | "saving" // PUTs in flight
  | "saved"; // PUTs answered and the re-read confirmed

/**
 * The browser's answer to a missing API key — a reminder, never a gate.
 *
 * Electron asks for the key on a screen the app cannot get past; the browser
 * has no key store, so this card asks in passing and lets the user close it
 * and keep using the app. Every way out of the card — the X, "Agora não",
 * saving the keys, the re-read failing — leaves the dashboard exactly where
 * it was, because nothing here is a portão like the `SetupScreen`.
 *
 * The card shows only when OpenAI AND OpenRouter are both unconfigured. A
 * status fetch that never answers stays in `"unknown"` and renders nothing:
 * a broken server must not decorate itself with a broken prompt.
 */
export function ProviderKeysPrompt({ onDismiss }: ProviderKeysPromptProps) {
  const [phase, setPhase] = useState<Phase>("unknown");
  const [openaiKey, setOpenaiKey] = useState("");
  const [openrouterKey, setOpenrouterKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  // `console_url` per provider comes from the same status read that decides
  // whether the card appears — a link under each field, not a hard-coded one.
  const [consoles, setConsoles] = useState<Partial<Record<ProviderName, string>>>({});
  const transition = useMotionUITransition("gentle");

  useEffect(() => {
    let cancelled = false;
    void api
      .getProviderKeys()
      .then((status) => {
        if (cancelled) return;
        setConsoles(
          Object.fromEntries(status.map((s) => [s.provider, s.console_url])),
        );
        const openai = status.find((s) => s.provider === "openai");
        const openrouter = status.find((s) => s.provider === "openrouter");
        setPhase(!openai?.present && !openrouter?.present ? "missing" : "unknown");
      })
      .catch(() => {
        /* unknown — render nothing, like a present key would */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (phase === "saving") return;
      const openai = openaiKey.trim();
      const openrouter = openrouterKey.trim();
      if (!openai && !openrouter) {
        setError("Cole ao menos uma chave para salvar.");
        return;
      }

      setError(null);
      setPhase("saving");
      const failures: string[] = [];
      const saved: ProviderKeyStatus[] = [];
      if (openai) {
        try {
          saved.push(await api.setProviderKey("openai", openai));
        } catch {
          failures.push("OpenAI");
        }
      }
      if (openrouter) {
        try {
          saved.push(await api.setProviderKey("openrouter", openrouter));
        } catch {
          failures.push("OpenRouter");
        }
      }
      if (failures.length > 0) {
        setError(
          `Não foi possível salvar a chave da ${failures.join(" e da ")}. ` +
            "Confira se ela foi copiada inteira e tente de novo.",
        );
        setPhase("missing");
        return;
      }

      // The PUT responses already said `present: true`; the re-read is the
      // confirmation the card learns the same way it first learned the keys
      // were missing. A failed re-read is transient — the PUTs answered 200
      // moments ago — so it costs the confirmation, not the save.
      try {
        const status = await api.getProviderKeys();
        const unconfirmed = saved.some(
          (s) => !status.find((p) => p.provider === s.provider)?.present,
        );
        if (unconfirmed) {
          setError("O servidor não confirmou a chave. Tente salvar de novo.");
          setPhase("missing");
          return;
        }
      } catch {
        /* the save already succeeded — see above */
      }
      setPhase("saved");
    },
    [openaiKey, openrouterKey, phase],
  );

  if (phase === "unknown") return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={transition}
      className="mx-auto mt-3 w-full max-w-3xl rounded-2xl border border-border bg-card p-4 shadow-lg md:mt-4"
    >
      {phase === "saved" ? (
        <div className="flex items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-400">
            <Check className="size-5" strokeWidth={3} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-foreground">Chaves salvas!</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              O servidor já está usando as chaves desta sessão. Pode fechar este
              card e continuar.
            </p>
            <Button className="mt-3" onClick={onDismiss}>
              Continuar
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-start gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <KeyRound className="size-5" />
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-semibold text-foreground">
                Faltam as chaves de API
              </h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Para chamar o modelo, o servidor precisa de uma chave da OpenAI
                ou da OpenRouter. Dá para fechar e adicionar depois.
              </p>
            </div>
            <button
              type="button"
              onClick={onDismiss}
              className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground"
              aria-label="Fechar"
            >
              <X className="size-4" />
            </button>
          </div>

          <form className="mt-3 space-y-3" onSubmit={handleSubmit}>
            <KeyField
              label="Chave da OpenAI"
              value={openaiKey}
              onChange={setOpenaiKey}
              placeholder="sk-…"
              consoleUrl={consoles.openai}
              disabled={phase === "saving"}
            />
            <KeyField
              label="Chave da OpenRouter"
              value={openrouterKey}
              onChange={setOpenrouterKey}
              placeholder="sk-or-…"
              consoleUrl={consoles.openrouter}
              disabled={phase === "saving"}
            />

            {error && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
              >
                <CircleAlert className="mt-0.5 size-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <div className="flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={onDismiss}
                className="text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                Agora não
              </button>
              <Button type="submit" disabled={phase === "saving"}>
                {phase === "saving" ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Salvando…
                  </>
                ) : (
                  "Salvar chaves"
                )}
              </Button>
            </div>
          </form>
        </>
      )}
    </motion.div>
  );
}

function KeyField({
  label,
  value,
  onChange,
  placeholder,
  consoleUrl,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  consoleUrl?: string;
  disabled: boolean;
}) {
  const inputId = useId();

  return (
    <div>
      {/* `htmlFor` and not a wrapping `<label>`: the row also carries the
          "Onde encontro?" link, and a label that wraps a link swallows its
          click into focus-the-input on some engines. */}
      <label
        htmlFor={inputId}
        className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-muted-foreground"
      >
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          id={inputId}
          type="password"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          // 16px on a phone: iOS Safari zooms the page in when a field under
          // 16px takes focus, and it never zooms back out.
          className="h-10 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 text-base text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-ring focus:ring-3 focus:ring-ring/50 disabled:opacity-50 md:h-9 md:text-sm"
        />
        {consoleUrl && (
          <a
            href={consoleUrl}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
          >
            Onde encontro?
          </a>
        )}
      </div>
    </div>
  );
}
