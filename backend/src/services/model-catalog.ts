// === The unified model catalogue ===
//
// One list across the three providers, cached, with the year filter the
// operator asked for. `ProviderAdapter.listModels` says its result is "expected
// to be called rarely and cached"; this module is where that caching and every
// policy decision live, so the adapters stay a thin read of each wire.
//
// WHAT A `year` ACTUALLY MEANS HERE, because the three providers disagree and
// the difference is invisible once it is a number:
//
//   - OpenRouter documents `created` as "Unix timestamp of when the model was
//     added to OpenRouter" (Model Object Schema,
//     https://openrouter.ai/docs/guides/overview/models), and its own
//     `sort=newest` reads "Most recently added to OpenRouter". So for the ~400
//     models that arrive from there, the year is the CATALOGUE-ENTRY year, not
//     the upstream release year: a model published in December and listed in
//     January counts as the later year. There is no better field to use —
//     the published schema carries no release date, only `created` and an
//     `expiration_date` that marks deprecation.
//   - OpenAI's `/v1/models` publishes `created` as when the model was created.
//   - DeepSeek's catalogue publishes no date at all, so every DeepSeek model
//     reaches this module with `released_at: null`.
//
// "2026+" therefore means "reached this catalogue in 2026 or later". That is
// close to what the operator asked for and it is not the same sentence, which
// is why `include_undated` exists rather than a rule that guesses.

import { adapterFor, ALL_PROVIDERS } from "./providers/index.js";
import { providerKeyPresent, providerKeyStatus } from "./providers/keys.js";
import type { ThinkerProvider } from "../types/thinker-roster.js";
import type { DiscoveredModel } from "./providers/types.js";

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

/**
 * A `DiscoveredModel` plus the two things only the catalogue can say.
 *
 * Everything inherited is passed through untouched — `rate` in particular. A
 * `null` rate (an OpenRouter router whose price depends on where it lands) and
 * a `{0,0,0}` rate (a `:free` model whose published price really is zero) stay
 * distinct all the way to the client. Collapsing them with `?? 0` would make an
 * unknown price look free.
 */
export interface CatalogModel extends DiscoveredModel {
  /**
   * The year of `released_at`, or `null` when the provider published no date.
   *
   * `null` is never rendered as, coerced to, or counted as the minimum year.
   * See the module note for what the year is a year OF.
   */
  year: number | null;
  /**
   * True only when this model is in the caller's `keep` list AND would have
   * been filtered out without it.
   *
   * The name is literal: the model is here *because* it was selected. A model
   * that passes the filter on its own merits is `false` even when it is also in
   * `keep`, so the UI can say "fora do filtro, mas é o que está escolhido" for
   * exactly the models where that sentence is true.
   */
  kept_by_selection: boolean;
}

export type CatalogProviderState = "ok" | "skipped" | "error";

/**
 * What one provider answered, reported rather than absorbed.
 *
 * Same spirit as `services/credits.ts`: three providers fail in three different
 * ways, and a catalogue that silently returned a short list would look like a
 * provider with few models rather than a provider that could not be reached.
 */
export interface CatalogProviderStatus {
  provider: ThinkerProvider;
  /**
   * `ok` — it answered. `skipped` — its catalogue needs a key and none is
   * configured, so nothing was sent. `error` — it was asked and it failed.
   */
  status: CatalogProviderState;
  /** Why, in Brazilian Portuguese for `skipped`; the provider's own words for `error`. */
  note?: string;
  /** Models this provider answered with, BEFORE any filter. Zero unless `ok`. */
  count: number;
}

export interface CatalogResult {
  models: CatalogModel[];
  providers: CatalogProviderStatus[];
  /** The minimum year actually applied, after defaults and clamping. */
  min_year: number;
  /** Models discovered before filtering. Always the sum of `providers[].count`. */
  total: number;
  /** Models that survived. Always `models.length`. */
  filtered: number;
}

export interface CatalogOptions {
  /** Empty or omitted means every provider. */
  providers?: ThinkerProvider[];
  /** Omitted means `MODEL_MIN_YEAR`, which defaults to 2026. `0` disables the year test. */
  minYear?: number;
  /** Whether models with no published date survive. Defaults to `true`. */
  includeUndated?: boolean;
  /** Free text over id and label, case- and accent-insensitive. */
  q?: string;
  /**
   * Ids that cross the YEAR filter — and only the year filter.
   *
   * `q` and `providers` are narrowings the user performed just now and are not
   * overridden; the year filter is a background policy they never typed, and it
   * is the one that would otherwise hide the model the roster is already using.
   */
  keep?: string[];
  /** Ignore the cache for this call and refill it. */
  refresh?: boolean;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * 2026 because that is what the operator asked for, `MODEL_MIN_YEAR` because a
 * literal would quietly become wrong on 2027-01-01. Read at call time, like
 * every `DEEP_THINK_*` tunable in `services/deep-think.ts`, so a running server
 * can be repointed and a test can move it without re-importing the module.
 *
 * Unlike those, zero is meaningful here — it means "no year test" — so the
 * guard is `>= 0` rather than `> 0`.
 */
const DEFAULT_MIN_YEAR = 2026;

export function defaultMinYear(): number {
  const raw = Number(process.env.MODEL_MIN_YEAR);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : DEFAULT_MIN_YEAR;
}

/**
 * Ten minutes.
 *
 * Discovery is one round trip per provider and the catalogues move on the order
 * of days — OpenRouter's own docs say the models response "is cached at the
 * edge". Ten minutes is short enough that a model added this morning shows up
 * within one coffee break and long enough that opening the roster panel
 * repeatedly does not re-ask three providers each time. Anyone who needs it
 * sooner has `?refresh=1`, which is why this does not need to be aggressive.
 */
const DEFAULT_TTL_MS = 10 * 60_000;

function ttlMs(): number {
  const raw = Number(process.env.MODEL_CATALOG_TTL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_TTL_MS;
}

/**
 * Whether a provider's CATALOGUE — not its chat endpoint — needs a key.
 *
 * `GET https://openrouter.ai/api/v1/models` answers 200 with no authentication
 * at all, measured against the live endpoint. The other two refuse: OpenAI's
 * `/v1/models` and DeepSeek's both 401 without one. That asymmetry is the whole
 * reason this catalogue is useful on a machine that has no keys yet, and it is
 * a fact about the endpoints rather than a preference, so it is written down
 * here instead of being discovered through a failed round trip.
 */
const DISCOVERY_NEEDS_KEY: Record<ThinkerProvider, boolean> = {
  openai: true,
  openrouter: false,
  deepseek: true,
};

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  models: DiscoveredModel[];
  at: number;
}

/** Keyed per provider, so one provider's failure cannot stale another's list. */
const cache = new Map<ThinkerProvider, CacheEntry>();

/** Forgets every cached catalogue. For tests and for `?refresh=1`'s blast radius. */
export function clearCatalogCache(): void {
  cache.clear();
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

interface Discovery {
  status: CatalogProviderStatus;
  models: DiscoveredModel[];
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function discover(
  provider: ThinkerProvider,
  refresh: boolean,
  signal?: AbortSignal,
): Promise<Discovery> {
  if (!refresh) {
    const hit = cache.get(provider);
    if (hit && Date.now() - hit.at < ttlMs()) {
      return {
        status: { provider, status: "ok", count: hit.models.length },
        models: hit.models,
      };
    }
  }

  if (DISCOVERY_NEEDS_KEY[provider] && !providerKeyPresent(provider)) {
    const { env_var, console_url } = providerKeyStatus(provider);
    return {
      status: {
        provider,
        status: "skipped",
        note:
          `${env_var} não está definida, então o catálogo desse provedor ficou ` +
          `de fora. Crie uma chave em ${console_url} para ver os modelos dele aqui.`,
        count: 0,
      },
      models: [],
    };
  }

  try {
    const models = await adapterFor(provider).listModels(signal);
    // Successes only. Caching the failure would make an operator who pasted
    // their key ten seconds ago wait out the whole TTL before the catalogue
    // noticed, which is the one moment this feature has to feel responsive.
    cache.set(provider, { models, at: Date.now() });
    return { status: { provider, status: "ok", count: models.length }, models };
  } catch (err) {
    return {
      status: { provider, status: "error", note: errText(err), count: 0 },
      models: [],
    };
  }
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/**
 * UTC, deliberately.
 *
 * `released_at` is an ISO instant minted by `isoFromEpochSeconds`, which builds
 * it in UTC. Reading the year back in local time moves a model published on 31
 * December into the previous year anywhere west of Greenwich, which would make
 * the same catalogue answer differently depending on where the backend runs.
 */
function yearOf(releasedAt: string | null): number | null {
  if (!releasedAt) return null;
  const date = new Date(releasedAt);
  return Number.isNaN(date.getTime()) ? null : date.getUTCFullYear();
}

/**
 * Case- and accent-insensitive form for comparison only.
 *
 * NFD splits a letter from its diacritic so the diacritic can be dropped, which
 * makes "ração" and "racao" the same needle. The product's users type
 * Portuguese; a search that only matches perfectly-accented text is a search
 * that fails on the first word with a cedilla.
 */
function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

/**
 * Every provider at once; one that fails or has no key must not take the others
 * with it. The DeepSeek and OpenAI catalogues can be unreachable for want of a
 * key while OpenRouter — which needs none — answers in full.
 */
export async function listCatalog(options: CatalogOptions = {}): Promise<CatalogResult> {
  // Deduplicated: `?provider=openrouter&provider=openrouter` would otherwise
  // fan out twice, report the provider twice, and hand the roster UI two copies
  // of every model — duplicate keys in the select the operator is looking at.
  const asked = options.providers?.length ? [...new Set(options.providers)] : ALL_PROVIDERS;
  const minYear = Math.max(0, Math.floor(options.minYear ?? defaultMinYear()));
  const includeUndated = options.includeUndated ?? true;
  const keep = new Set(options.keep ?? []);
  const needle = fold((options.q ?? "").trim());

  const discovered = await Promise.all(
    asked.map((provider) => discover(provider, options.refresh === true, options.signal)),
  );

  const models: CatalogModel[] = [];
  let total = 0;

  for (const one of discovered) {
    total += one.models.length;
    for (const model of one.models) {
      const year = yearOf(model.released_at);
      // An undated model is decided by `includeUndated` and is never compared
      // against `minYear` — treating `null` as the current year would silently
      // pass every DeepSeek model off as new.
      const passes = year === null ? includeUndated : year >= minYear;
      // A model may appear under different ids across providers: the roster
      // stores "gpt-5.2-mini" (OpenAI bare), the OpenRouter catalogue answers
      // "openai/gpt-5.2-mini". Without normalising, `keep` would fail to
      // rescue a selected model when only one provider answers — the exact
      // scenario that "getting the key later" creates and that the keep
      // parameter was added to handle.
      const bare = model.id.includes("/") ? model.id.slice(model.id.indexOf("/") + 1) : model.id;
      const kept = !passes && (keep.has(model.id) || (bare !== model.id && keep.has(bare)));
      if (!passes && !kept) continue;
      if (needle && !fold(`${model.id} ${model.label}`).includes(needle)) continue;

      models.push({ ...model, year, kept_by_selection: kept });
    }
  }

  return {
    models,
    providers: discovered.map((one) => one.status),
    min_year: minYear,
    total,
    filtered: models.length,
  };
}
