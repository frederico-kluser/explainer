"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Combobox } from "@base-ui/react/combobox";
import { Check, ChevronDown, RefreshCw } from "lucide-react";

import { cn } from "@/lib/utils";
import type {
  CatalogModel,
  CatalogResult,
  ModelChoice,
  ThinkerProvider,
} from "@/types";

export interface ModelSelectProps {
  /** The current choice — `null` means "nothing picked yet". */
  value: ModelChoice | null;
  /**
   * Called with a fresh choice whenever the operator picks a model. The
   * provider always comes from the `provider` prop: the catalogue is queried
   * for one provider at a time, so the picked model's provider is never a
   * guess.
   */
  onChange: (choice: ModelChoice) => void;
  /**
   * Model ids from the whole roster that must stay visible even when the year
   * filter would hide them. Crosses the YEAR filter only — `q` and `provider`
   * are narrowings the operator performed and are not overridden, exactly as
   * the backend documents.
   */
  keep: string[];
  /** The one provider whose catalogue the popup browses. */
  provider: ThinkerProvider;
  /** Called when the operator switches provider from inside the popup. */
  onProviderChange: (provider: ThinkerProvider) => void;
  /** Accessible name for the combobox input. */
  label: string;
  placeholder?: string;
  disabled?: boolean;
  /** Merged onto the input group, so a caller can size the row. */
  className?: string;
}

/**
 * One row of the catalogue, as a combobox item.
 *
 * `value` is the model id and the identity that the selection holds: ids are
 * stable across catalogue refetches, while the objects themselves are not.
 */
interface ModelItem {
  value: string;
  label: string;
  model: CatalogModel | null;
}

const PROVIDER_LABELS: Record<ThinkerProvider, string> = {
  openai: "OpenAI",
  openrouter: "OpenRouter",
  deepseek: "DeepSeek",
};

/** How long a keystroke waits before the catalogue is re-asked. */
const QUERY_DEBOUNCE_MS = 250;

/**
 * The catalogue, as a searchable combobox.
 *
 * The popup queries `GET /api/models` with the row's provider, the current
 * search text, the `keep` list and the undated toggle — the filtering happens
 * server-side, so the combobox never sees a model the roster should not be
 * able to choose. The catalogue is fetched LAZILY, on first open: the roster
 * panel mounts a dozen of these, and asking the backend twelve times on panel
 * load would be twelve requests for lists nobody is looking at.
 *
 * Every model list is what the operator asked for, so no browser-side filter
 * is needed or wanted — with one exception: a model the roster already chose
 * must never disappear from the list, which is what the `keep` parameter (and
 * the "(selecionado)" badge) is for.
 */
export function ModelSelect({
  value,
  onChange,
  keep,
  provider,
  onProviderChange,
  label,
  placeholder,
  disabled = false,
  className,
}: ModelSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [includeUndated, setIncludeUndated] = useState(true);
  const [catalog, setCatalog] = useState<CatalogResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // One entry per model id, kept alive across refetches. The selection holds
  // the entry's identity, so a catalogue refresh must not orphan it: without
  // the cache, typing in the search box would rebuild every item object and
  // the check next to the chosen model would vanish with the old identity.
  // The entry is mutated in place so its data stays fresh while its identity
  // stays put.
  const itemCacheRef = useRef(new Map<string, ModelItem>());

  function itemFor(model: CatalogModel): ModelItem {
    const cached = itemCacheRef.current.get(model.id);
    if (cached) {
      cached.label = model.label;
      cached.model = model;
      return cached;
    }
    const item: ModelItem = { value: model.id, label: model.label, model };
    itemCacheRef.current.set(model.id, item);
    return item;
  }

  /** The item for a chosen model that the current list may not contain. */
  function placeholderItem(id: string): ModelItem {
    const cached = itemCacheRef.current.get(id);
    if (cached) return cached;
    const item: ModelItem = { value: id, label: id, model: null };
    itemCacheRef.current.set(id, item);
    return item;
  }

  const items = useMemo(
    () => (catalog?.models ?? []).map(itemFor),
    // `catalog` only: itemFor keeps the cache entries' data in step with the
    // latest catalogue, so the item list is a pure projection of it.
    [catalog],
  );

  const selectedItem: ModelItem | null = useMemo(
    () => (value && value.model ? placeholderItem(value.model) : null),
    // `items` too: when the catalogue catches up with the choice, the
    // placeholder must be swapped for the item carrying the real label.
    [value, items],
  );

  // The popup refills the input with the selection's label on open, on close
  // and after a pick; that refill is the selection speaking, not a search the
  // operator typed, so it must not narrow the list. A real keystroke cannot
  // produce exactly the label while the popup is open — the only paths here
  // are the store's own refills.
  const isRefill = (input: string) =>
    selectedItem !== null && input === selectedItem.label;

  useEffect(() => {
    if (disabled || !open) return;
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);

    // The first open is not debounced — the list should answer the moment the
    // popup is on screen — but every keystroke is.
    const timer = setTimeout(
      () => {
        const params = new URLSearchParams({
          q: query.trim(),
          include_undated: includeUndated ? "1" : "0",
          provider,
        });
        // Repeated `keep` params, the shape `routes/models.ts` accepts both.
        for (const id of keep) {
          if (id.trim() !== "") params.append("keep", id.trim());
        }
        void fetch(`/api/models?${params.toString()}`, {
          signal: controller.signal,
        })
          .then(async (response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return (await response.json()) as CatalogResult;
          })
          .then((result) => {
            if (!cancelled) {
              setCatalog(result);
              setError(null);
            }
          })
          .catch((err: unknown) => {
            if (!cancelled && !controller.signal.aborted) {
              setError(
                err instanceof Error
                  ? err.message
                  : "Não foi possível carregar os modelos.",
              );
            }
          })
          .finally(() => {
            if (!cancelled) setLoading(false);
          });
      },
      query.trim() === "" ? 0 : QUERY_DEBOUNCE_MS,
    );

    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, disabled, query, includeUndated, provider, keep, reloadKey]);

  const handlePick = (item: ModelItem | null) => {
    const model = item?.model;
    if (!model) return;
    onChange({
      provider,
      model: model.id,
      context_window: model.context_window,
      supports_tools: model.supports_tools,
      rate: model.rate,
      ...(model.released_at ? { discovered_at: model.released_at } : {}),
    });
  };

  const activeProviderStatus = catalog?.providers.find(
    (one) => one.provider === provider,
  );

  return (
    <Combobox.Root
      items={items}
      value={selectedItem}
      onValueChange={handlePick}
      onInputValueChange={(input) => {
        if (!isRefill(input)) setQuery(input);
      }}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setQuery("");
      }}
      disabled={disabled}
      // The backend already filtered this list (provider, search, year, keep).
      // The combobox's own collator filter would narrow it AGAIN — and on
      // open it treats the refilled selection label as a query, hiding every
      // other model. `null` keeps the list exactly as the server sent it.
      filter={null}
    >
      <Combobox.InputGroup
        className={cn(
          "relative flex h-9 min-w-0 items-center rounded-md border border-border bg-background transition-colors focus-within:border-primary",
          className,
        )}
      >
        <Combobox.Input
          aria-label={label}
          placeholder={placeholder ?? "Escolher modelo"}
          className="h-full min-w-0 flex-1 bg-transparent px-2.5 pr-8 text-sm text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-50"
        />
        <Combobox.Trigger
          aria-label="Abrir lista de modelos"
          className="absolute right-0 flex h-full w-7 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronDown className="size-4" />
        </Combobox.Trigger>
      </Combobox.InputGroup>

      <Combobox.Portal>
        <Combobox.Positioner sideOffset={4} align="start">
          <Combobox.Popup className="z-50 w-[min(22rem,var(--available-width))] overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg">
            {/* The two controls every list read shares: which provider's
                catalogue is on screen, and whether undated models survive. */}
            <div className="space-y-1.5 border-b border-border p-2">
              <div className="flex items-center gap-1">
                {(
                  ["openai", "openrouter", "deepseek"] as const
                ).map((candidate) => (
                  <button
                    key={candidate}
                    type="button"
                    onClick={() => onProviderChange(candidate)}
                    className={cn(
                      "flex-1 rounded-md border px-1.5 py-1 text-[11px] transition-colors",
                      candidate === provider
                        ? "border-primary bg-primary/10 text-foreground"
                        : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
                    )}
                  >
                    {PROVIDER_LABELS[candidate]}
                  </button>
                ))}
              </div>
              <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground select-none">
                <input
                  type="checkbox"
                  checked={includeUndated}
                  onChange={(event) => setIncludeUndated(event.target.checked)}
                  className="size-3.5 accent-primary"
                />
                Incluir modelos sem data
              </label>
            </div>

            {activeProviderStatus &&
              activeProviderStatus.status !== "ok" &&
              activeProviderStatus.note && (
                <p className="border-b border-border px-2.5 py-1.5 text-[11px] leading-snug text-amber-500">
                  {activeProviderStatus.note}
                </p>
              )}

            {error && !loading ? (
              // Before the error branch: a failed FIRST fetch leaves the
              // catalogue null, and `loading || catalog === null` must not
              // swallow the failure into an endless "Carregando modelos…".
              <div className="space-y-1.5 px-2.5 py-2">
                <p className="text-xs text-destructive">{error}</p>
                <button
                  type="button"
                  onClick={() => setReloadKey((key) => key + 1)}
                  className="text-xs text-primary hover:underline"
                >
                  Tentar de novo
                </button>
              </div>
            ) : loading || catalog === null ? (
              <p className="flex items-center gap-1.5 px-2.5 py-2 text-xs text-muted-foreground">
                <RefreshCw className="size-3 animate-spin" aria-hidden="true" />
                Carregando modelos…
              </p>
            ) : catalog.models.length === 0 ? (
              <Combobox.Empty className="px-2.5 py-2 text-xs text-muted-foreground">
                Nenhum modelo encontrado.
              </Combobox.Empty>
            ) : (
              <Combobox.List className="max-h-64 overflow-y-auto overscroll-contain py-1 outline-none">
                {(item: ModelItem) => (
                  <Combobox.Item
                    key={item.value}
                    value={item}
                    className="flex cursor-default items-center gap-2 px-2.5 py-1.5 text-sm outline-none select-none data-highlighted:bg-accent data-highlighted:text-foreground"
                  >
                    <Combobox.ItemIndicator className="w-4 shrink-0 text-primary">
                      <Check className="size-3.5" aria-hidden="true" />
                    </Combobox.ItemIndicator>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-foreground">
                        {item.model?.label ?? item.value}
                      </span>
                      {item.model && item.model.id !== item.model.label && (
                        <span className="block truncate text-[11px] text-muted-foreground">
                          {item.model.id}
                        </span>
                      )}
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      {item.model?.kept_by_selection && (
                        <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
                          (selecionado)
                        </span>
                      )}
                      {/* The year is a catalogue-entry year (OpenRouter
                          documents `created` as "added to OpenRouter"), never
                          a release date; and `null` is "sem data", never the
                          filter's floor. */}
                      <span className="text-[10px] tabular-nums text-muted-foreground">
                        {item.model?.year ?? "sem data"}
                      </span>
                    </span>
                  </Combobox.Item>
                )}
              </Combobox.List>
            )}
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
