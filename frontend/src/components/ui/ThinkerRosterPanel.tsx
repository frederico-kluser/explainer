"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { RotateCcw, Save } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ModelSelect } from "@/components/ui/ModelSelect";
import * as api from "@/lib/api";
import type {
  ModelChoice,
  RosterEnvelope,
  RosterRole,
  RosterWarning,
  ThinkerProvider,
  ThinkerRoster,
  ThinkerSlot,
} from "@/types";

const PROVIDERS: readonly ThinkerProvider[] = ["openai", "openrouter", "deepseek"];

const PROVIDER_LABELS: Record<ThinkerProvider, string> = {
  openai: "OpenAI",
  openrouter: "OpenRouter",
  deepseek: "DeepSeek",
};

/** The model ids currently chosen across the whole draft, for `keep=`. */
function rosterModelIds(roster: ThinkerRoster): string[] {
  const ids = new Set<string>([roster.master.model, roster.planner.model]);
  for (const slot of roster.slots) ids.add(slot.model.model);
  ids.delete("");
  return [...ids];
}

/**
 * The roster of thinkers, editable.
 *
 * The sheet that hosts this panel mounts it only while open, so a mount is an
 * open: the roster is fetched here and never outside. The envelope of the
 * RESPONSE is the source of truth — the draft starts from it, and every save
 * replaces both draft and envelope with the response, because the backend
 * normalises what it is handed and the screen must show what actually landed,
 * not what the form happened to send.
 */
export function ThinkerRosterPanel() {
  const [envelope, setEnvelope] = useState<RosterEnvelope | null>(null);
  const [draft, setDraft] = useState<ThinkerRoster | null>(null);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const next = await api.getRoster();
      setEnvelope(next);
      setDraft(next.roster);
      setDirty(false);
    } catch {
      setLoadError(
        "Não foi possível carregar o roster de pensadores. Verifique se o servidor está no ar.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  // A mount IS an open: the sheet that hosts this panel renders it only while
  // open, so every open of the drawer fetches the roster afresh.
  useEffect(() => {
    void load();
  }, [load]);

  const keep = useMemo(() => {
    if (!draft) return [];
    return rosterModelIds(draft);
    // Keyed on the ids, not on `draft`: an angle or toggle edit changes the
    // object without changing any model id, and must not re-fetch the twelve
    // comboboxes on the screen.
  }, [draft ? rosterModelIds(draft).join("|") : ""]);

  const patchChoice = useCallback(
    (role: "master" | "planner" | number, choice: ModelChoice) => {
      setDraft((current) => {
        if (!current) return current;
        if (role === "master") return { ...current, master: choice };
        if (role === "planner") return { ...current, planner: choice };
        return {
          ...current,
          slots: current.slots.map((slot) =>
            slot.index === role ? { ...slot, model: choice } : slot,
          ),
        };
      });
      setDirty(true);
    },
    [],
  );

  const patchProvider = useCallback(
    (role: "master" | "planner" | number, provider: ThinkerProvider) => {
      setDraft((current) => {
        if (!current) return current;
        const repoint = (choice: ModelChoice): ModelChoice => ({
          ...choice,
          provider,
          // A model id picked under the old provider is a lie under the new
          // one — it either does not exist there or resolves to a different
          // model. Forcing a fresh pick costs one step and saves a roster
          // that fails at runtime.
          model: "",
        });
        if (role === "master") {
          return { ...current, master: repoint(current.master) };
        }
        if (role === "planner") {
          return { ...current, planner: repoint(current.planner) };
        }
        return {
          ...current,
          slots: current.slots.map((slot) =>
            slot.index === role ? { ...slot, model: repoint(slot.model) } : slot,
          ),
        };
      });
      setDirty(true);
    },
    [],
  );

  const patchSlot = useCallback(
    (
      index: number,
      patch: Partial<Pick<ThinkerSlot, "enabled" | "angle">>,
    ) => {
      setDraft((current) => {
        if (!current) return current;
        return {
          ...current,
          slots: current.slots.map((slot) =>
            slot.index === index ? { ...slot, ...patch } : slot,
          ),
        };
      });
      setDirty(true);
    },
    [],
  );

  const patchSlotEffort = useCallback((index: number, effort: string) => {
    setDraft((current) => {
      if (!current) return current;
      return {
        ...current,
        slots: current.slots.map((slot) =>
          slot.index === index
            ? {
                ...slot,
                model: {
                  ...slot.model,
                  // Effort is a closed <select> — empty means "use the model
                  // default", any other value is one of the six valid levels.
                  effort: (effort === "" ? undefined : effort) as ModelChoice["effort"],
                },
              }
            : slot,
        ),
      };
    });
    setDirty(true);
  }, []);

  const warningsFor = useCallback(
    (role: RosterRole, slotIndex?: number): RosterWarning[] => {
      if (!envelope) return [];
      return envelope.warnings.filter(
        (warning) =>
          warning.role === role &&
          (slotIndex === undefined || warning.slot_index === slotIndex),
      );
    },
    [envelope],
  );

  const handleSave = async () => {
    if (!draft || saving) return;
    setSaving(true);
    setSaveError(null);
    setFeedback(null);
    try {
      const next = await api.putRoster(draft);
      setEnvelope(next);
      setDraft(next.roster);
      setDirty(false);
      setFeedback("Salvo.");
    } catch (err) {
      setSaveError(
        err instanceof Error
          ? err.message
          : "Não foi possível salvar o roster de pensadores.",
      );
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    setFeedback(null);
    try {
      const next = await api.resetRoster();
      setEnvelope(next);
      setDraft(next.roster);
      setDirty(false);
      setFeedback("Restaurado para o padrão.");
    } catch (err) {
      setSaveError(
        err instanceof Error
          ? err.message
          : "Não foi possível restaurar o roster de pensadores.",
      );
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <p className="px-1 py-6 text-center text-xs text-muted-foreground">
        Carregando os pensadores…
      </p>
    );
  }

  if (loadError || !draft) {
    return (
      <div className="space-y-3 px-1 py-6 text-center">
        <p className="text-xs text-destructive">
          {loadError ?? "O roster de pensadores não está disponível."}
        </p>
        <Button variant="outline" onClick={() => void load()}>
          Tentar de novo
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4 px-1 pb-2">
      <p className="text-xs leading-relaxed text-muted-foreground">
        Quais modelos pensam, planejam os ângulos e escrevem a resposta. O
        roster vale para todas as conversas.
      </p>

      <RoleCard
        label="Master"
        hint="Lê o traço de todos os pensadores e escreve a resposta final."
        choice={draft.master}
        keep={keep}
        warnings={warningsFor("master")}
        onChoiceChange={(choice) => patchChoice("master", choice)}
        onProviderChange={(provider) => patchProvider("master", provider)}
      />

      <RoleCard
        label="Planner"
        hint="Planeja os ângulos de cada rodada — um modelo pequeno basta."
        choice={draft.planner}
        keep={keep}
        warnings={warningsFor("planner")}
        onChoiceChange={(choice) => patchChoice("planner", choice)}
        onProviderChange={(provider) => patchProvider("planner", provider)}
      />

      <div className="space-y-2">
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Pensadores
          </p>
          <p className="text-[11px] text-muted-foreground">
            Desligar um pensador pula o turno dele — o modelo escolhido fica
            guardado.
          </p>
        </div>

        {draft.slots.map((slot) => (
          <SlotCard
            key={slot.index}
            slot={slot}
            keep={keep}
            warnings={warningsFor("thinker", slot.index)}
            onChoiceChange={(choice) => patchChoice(slot.index, choice)}
            onProviderChange={(provider) =>
              patchProvider(slot.index, provider)
            }
            onToggle={(enabled) => patchSlot(slot.index, { enabled })}
            onAngleChange={(angle) => patchSlot(slot.index, { angle })}
            onEffortChange={(effort) => patchSlotEffort(slot.index, effort)}
          />
        ))}
      </div>

      <div className="space-y-2 border-t border-border pt-3">
        {saveError && <p className="text-xs text-destructive">{saveError}</p>}
        {feedback && !saveError && (
          <p className="text-xs text-muted-foreground">{feedback}</p>
        )}

        <div className="flex items-center gap-2">
          <Button
            onClick={() => void handleSave()}
            disabled={!dirty || saving}
            className="flex-1"
          >
            <Save className="mr-1.5 size-3.5" aria-hidden="true" />
            {saving ? "Salvando…" : "Salvar"}
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              if (confirmReset) void handleReset();
              else setConfirmReset(true);
            }}
            disabled={saving}
            className={cn(confirmReset && "border-destructive text-destructive")}
            title={
              confirmReset
                ? "Clique de novo para confirmar"
                : "Voltar para o roster padrão"
            }
          >
            <RotateCcw className="mr-1.5 size-3.5" aria-hidden="true" />
            {confirmReset ? "Confirmar" : "Padrão"}
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Avisos e modelos refletem o que está salvo no servidor — os avisos
          são recalculados a cada salvamento.
        </p>
      </div>
    </div>
  );
}

interface RoleCardProps {
  label: string;
  hint: string;
  choice: ModelChoice;
  keep: string[];
  warnings: RosterWarning[];
  onChoiceChange: (choice: ModelChoice) => void;
  onProviderChange: (provider: ThinkerProvider) => void;
}

/** Master and planner share a card; the slots add their own extras. */
function RoleCard({
  label,
  hint,
  choice,
  keep,
  warnings,
  onChoiceChange,
  onProviderChange,
}: RoleCardProps) {
  return (
    <div className="space-y-1.5 rounded-lg border border-border bg-card p-2.5">
      <div>
        <p className="text-xs font-medium text-foreground">{label}</p>
        <p className="text-[11px] text-muted-foreground">{hint}</p>
      </div>
      <ChoiceFields
        choice={choice}
        keep={keep}
        label={label}
        onChoiceChange={onChoiceChange}
        onProviderChange={onProviderChange}
      />
      {warnings.map((warning) => (
        <p
          key={`${warning.code}-${warning.provider}`}
          className="text-[11px] leading-snug text-amber-500"
        >
          {warning.message}
        </p>
      ))}
    </div>
  );
}

interface SlotCardProps {
  slot: ThinkerSlot;
  keep: string[];
  warnings: RosterWarning[];
  onChoiceChange: (choice: ModelChoice) => void;
  onProviderChange: (provider: ThinkerProvider) => void;
  onToggle: (enabled: boolean) => void;
  onAngleChange: (angle: string) => void;
  onEffortChange: (effort: string) => void;
}

function SlotCard({
  slot,
  keep,
  warnings,
  onChoiceChange,
  onProviderChange,
  onToggle,
  onAngleChange,
  onEffortChange,
}: SlotCardProps) {
  return (
    <div
      className={cn(
        "space-y-1.5 rounded-lg border border-border bg-card p-2.5",
        !slot.enabled && "opacity-70",
      )}
    >
      <label className="flex cursor-pointer items-center gap-2 select-none">
        <input
          type="checkbox"
          checked={slot.enabled}
          onChange={(event) => onToggle(event.target.checked)}
          className="size-3.5 accent-primary"
        />
        <span className="text-xs font-medium text-foreground">
          Pensador {slot.index}
        </span>
      </label>

      <ChoiceFields
        choice={slot.model}
        keep={keep}
        label={`Pensador ${slot.index}`}
        onChoiceChange={onChoiceChange}
        onProviderChange={onProviderChange}
      />

      <div className="grid grid-cols-2 gap-1.5">
        <input
          type="text"
          value={slot.angle ?? ""}
          onChange={(event) => onAngleChange(event.target.value)}
          placeholder="Ângulo próprio (opcional)"
          title="Sobrepõe o ângulo do planner para este pensador"
          className="h-8 min-w-0 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-primary"
        />
        <select
          value={slot.model.effort ?? ""}
          onChange={(event) => onEffortChange(event.target.value)}
          title="Quanto o modelo é convidado a pensar"
          className="h-8 min-w-0 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-primary"
        >
          <option value="">Esforço (padrão do modelo)</option>
          <option value="minimal">minimal</option>
          <option value="low">low</option>
          <option value="medium">medium</option>
          <option value="high">high</option>
          <option value="xhigh">xhigh</option>
          <option value="max">max</option>
        </select>
      </div>

      {warnings.map((warning) => (
        <p
          key={`${warning.code}-${warning.provider}`}
          className="text-[11px] leading-snug text-amber-500"
        >
          {warning.message}
        </p>
      ))}
    </div>
  );
}

interface ChoiceFieldsProps {
  choice: ModelChoice;
  keep: string[];
  label: string;
  onChoiceChange: (choice: ModelChoice) => void;
  onProviderChange: (provider: ThinkerProvider) => void;
}

/** The provider select and the model combobox every row shares. */
function ChoiceFields({
  choice,
  keep,
  label,
  onChoiceChange,
  onProviderChange,
}: ChoiceFieldsProps) {
  return (
    <div className="flex items-center gap-1.5">
      <select
        value={choice.provider}
        onChange={(event) =>
          onProviderChange(event.target.value as ThinkerProvider)
        }
        aria-label={`Provedor do ${label.toLowerCase()}`}
        className="h-9 shrink-0 rounded-md border border-border bg-background px-1.5 text-xs text-foreground outline-none focus:border-primary"
      >
        {PROVIDERS.map((provider) => (
          <option key={provider} value={provider}>
            {PROVIDER_LABELS[provider]}
          </option>
        ))}
      </select>
      <ModelSelect
        value={choice.model === "" ? null : choice}
        onChange={onChoiceChange}
        onProviderChange={onProviderChange}
        provider={choice.provider}
        keep={keep}
        label={label}
        placeholder="Escolher modelo"
        className="min-w-0 flex-1"
      />
    </div>
  );
}
