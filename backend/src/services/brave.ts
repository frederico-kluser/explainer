import type { BraveResult, BraveSearchResponse, SearchFn } from "../types/deep-tools.js";

// ---------------------------------------------------------------------------
// Why this exists
// ---------------------------------------------------------------------------
//
// The web the deep-think thinkers read from. Ten thinkers run in parallel and
// each one searches, so the interesting part of this file is not the fetch —
// it is the queue in front of it.
//
// The free plan is one request per second, enforced over a one-second sliding
// window; the tenth simultaneous request gets a 429, not a slot. Every search
// therefore goes through a single-file queue that spaces requests apart, which
// lets callers stay naively concurrent: a thinker just awaits `braveSearch`
// and the pacing is somebody else's problem.
//
// Shapes and limits below were verified against the live API on 2026-08-08
// rather than taken from documentation, because the two disagree — see the
// note on `MAX_COUNT`.

const ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

// The published reference says the ceiling is 20; the request validator
// advertises 50 in its schema error, and then a separate check rejects
// anything over 20 with "Count should be less than or equal to 20". 20 is the
// number that is actually enforced, so it is the number we clamp to.
const MAX_COUNT = 20;
const MIN_COUNT = 1;
const DEFAULT_COUNT = 10;

const MAX_ATTEMPTS = 3;

// 1 req/s is the free-plan budget; the extra 100 ms absorbs clock skew between
// our timer and Brave's window, which is the difference between a 200 and a 429.
const DEFAULT_MIN_INTERVAL_MS = 1_100;
const DEFAULT_RETRY_BASE_MS = 1_100;
const DEFAULT_TIMEOUT_MS = 15_000;

// A 429 that Brave says will clear in more than this is not throttling, it is
// the monthly quota: the reset is days away, so waiting is not an option and
// retrying only burns two more requests. Five seconds covers the per-second
// window with room for clock skew.
const DEFAULT_MAX_BACKOFF_MS = 5_000;

const SAFESEARCH_VALUES = new Set(["off", "moderate", "strict"]);
const FRESHNESS_PATTERN = /^(pd|pw|pm|py|\d{4}-\d{2}-\d{2}to\d{4}-\d{2}-\d{2})$/;

// `page_age` is Brave's ISO timestamp. `age` is prose for humans ("2 weeks
// ago", "November 22, 2024"), so it only qualifies for the contract's `age`
// field — documented as ISO — when it happens to lead with a real date.
const ISO_DATE_PREFIX = /^\d{4}-\d{2}-\d{2}/;

/**
 * A search that failed, with the HTTP status when the failure came back from
 * the API rather than from the socket.
 */
export class BraveSearchError extends Error {
  public readonly status?: number;
  /** Whether repeating the identical request could plausibly succeed. */
  public readonly retryable: boolean;
  /** How long the API itself said to wait, when it said so. */
  public readonly retryAfterMs?: number;

  constructor(
    message: string,
    options: { status?: number; retryable?: boolean; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = "BraveSearchError";
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/** Counters for the deep-think cost ledger to fold in at the end of a run. */
export interface BraveSearchStats {
  /** Searches that returned results to a caller. */
  searches: number;
  /** HTTP requests actually issued, retries included. */
  requests: number;
  /** Searches that ended in an error. */
  failures: number;
  /** Attempts repeated after a 429 or a network fault. */
  retries: number;
}

const stats: BraveSearchStats = { searches: 0, requests: 0, failures: 0, retries: 0 };

export function getBraveSearchStats(): BraveSearchStats {
  return { ...stats };
}

export function resetBraveSearchStats(): void {
  stats.searches = 0;
  stats.requests = 0;
  stats.failures = 0;
  stats.retries = 0;
}

// ---------------------------------------------------------------------------
// Configuration, read per call
// ---------------------------------------------------------------------------
//
// Read at call time rather than at import so the key can be rotated and the
// pacing retuned against a live server, without a restart dropping the
// conversation that is running.

function apiKey(): string {
  const key = process.env.BRAVE_API_KEY?.trim();
  if (!key) {
    throw new BraveSearchError(
      "BRAVE_API_KEY não está definida. Crie uma chave em " +
        "https://api-dashboard.search.brave.com e exporte BRAVE_API_KEY antes de subir o backend.",
    );
  }
  return key;
}

/**
 * `Number("")` and `Number("   ")` are `0`, which is finite and clears a `min`
 * of zero — so a `BRAVE_MIN_INTERVAL_MS=` line left behind in a `.env` would
 * pass every guard and silently disable the pacer for the whole run. A blank
 * value means "not set", never "zero".
 */
function toFiniteNumber(raw: string | undefined): number | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

function envNumber(name: string, fallback: number, min: number): number {
  const value = toFiniteNumber(process.env[name]);
  return value !== undefined && value >= min ? value : fallback;
}

function minIntervalMs(): number {
  return envNumber("BRAVE_MIN_INTERVAL_MS", DEFAULT_MIN_INTERVAL_MS, 0);
}

function retryBaseMs(): number {
  return envNumber("BRAVE_RETRY_BASE_MS", DEFAULT_RETRY_BASE_MS, 0);
}

function timeoutMs(): number {
  return envNumber("BRAVE_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, 1);
}

/** Longest wait we are willing to sit through before giving the caller an error. */
function maxBackoffMs(): number {
  return envNumber("BRAVE_MAX_BACKOFF_MS", DEFAULT_MAX_BACKOFF_MS, 0);
}

function clampCount(requested?: number): number {
  if (typeof requested !== "number" || !Number.isFinite(requested)) return DEFAULT_COUNT;
  return Math.min(MAX_COUNT, Math.max(MIN_COUNT, Math.trunc(requested)));
}

function buildUrl(query: string, requestedCount?: number): string {
  const url = new URL(ENDPOINT);
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(clampCount(requestedCount)));

  // The thinkers write in Brazilian Portuguese and their citations are read by
  // a Brazilian user, so the default region is br/pt-br. `search_lang` is a
  // closed enum — "pt" is rejected with a 422, only "pt-br" and "pt-pt" exist.
  url.searchParams.set("country", process.env.BRAVE_COUNTRY?.trim() || "br");
  url.searchParams.set("search_lang", process.env.BRAVE_SEARCH_LANG?.trim() || "pt-br");

  // Validated rather than passed through: a typo in an operator's env var would
  // otherwise turn every single search of the run into a 422.
  const safesearch = process.env.BRAVE_SAFESEARCH?.trim().toLowerCase();
  url.searchParams.set(
    "safesearch",
    safesearch && SAFESEARCH_VALUES.has(safesearch) ? safesearch : "moderate",
  );

  const freshness = process.env.BRAVE_FRESHNESS?.trim();
  if (freshness && FRESHNESS_PATTERN.test(freshness)) {
    url.searchParams.set("freshness", freshness);
  }

  return url.toString();
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

let queueTail: Promise<unknown> = Promise.resolve();
let lastExchangeAt = 0;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Hold the caller until the shared one-request-per-second budget has room. */
async function awaitSlot(): Promise<void> {
  const interval = minIntervalMs();
  // Capped at one interval: if the system clock jumps backwards — an NTP
  // correction, a laptop waking from suspend — the raw difference would park
  // every remaining search of the run for the length of the jump.
  const wait = Math.min(lastExchangeAt + interval - Date.now(), interval);
  if (wait > 0) await delay(wait);
}

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const result = queueTail.then(task);
  // The tail swallows the rejection so that one failed search does not poison
  // every search queued behind it.
  queueTail = result.catch(() => undefined);
  return result;
}

function backoffMs(attempt: number): number {
  const base = retryBaseMs() * 2 ** (attempt - 1);
  // Jitter, because ten thinkers that hit the same 429 would otherwise back off
  // in lockstep and collide again on exactly the same retry.
  return Math.round(base * (1 + Math.random() * 0.25));
}

// ---------------------------------------------------------------------------
// Text cleanup
// ---------------------------------------------------------------------------

// Any tag, not just `<strong>`: whatever survives here is markup a model will
// read as instructions and a voice will read out loud.
const TAG = /<[^>]*>/g;
// Decoding is what produces these: `&#0;` is a real NUL by the time the
// snippet is built, and a control character reaches the model as invisible
// payload and the speech synthesiser as nothing at all. The ones that are also
// whitespace become a space so the words around them stay apart.
const CONTROL = /\p{Cc}/gu;
const ENTITY = /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi;
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function fromCode(code: number): string | undefined {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return undefined;
  return String.fromCodePoint(code);
}

function decodeEntities(text: string): string {
  return text.replace(ENTITY, (match, body: string) => {
    const token = body.toLowerCase();
    if (token.startsWith("#x")) return fromCode(Number.parseInt(token.slice(2), 16)) ?? match;
    if (token.startsWith("#")) return fromCode(Number.parseInt(token.slice(1), 10)) ?? match;
    return NAMED_ENTITIES[token] ?? match;
  });
}

// Two rounds are enough for `&amp;lt;script&amp;gt;`, where one decode only
// uncovers the entity that the next one turns into a tag; the third exists so
// the loop is bounded by a constant rather than by the input.
const MAX_SANITIZE_PASSES = 3;

/**
 * Brave wraps the matched terms in `<strong>` and escapes everything else the
 * page contained. This text is headed for an LLM and then for text-to-speech,
 * where markup is read out loud as noise — and where a decoded `<script>` is a
 * prompt-injection surface handed straight to a model.
 *
 * So decoding runs *before* stripping, and stripping takes every tag rather
 * than just `<strong>`: decoding after would rebuild, out of the escaping Brave
 * did for us, exactly the markup the page had. The text inside a tag survives;
 * only the tag itself goes, which is what makes a highlighted term readable.
 */
function stripMarkup(text: string): string {
  let out = text;
  for (let pass = 0; pass < MAX_SANITIZE_PASSES; pass++) {
    const next = decodeEntities(out).replace(TAG, "");
    if (next === out) return out;
    out = next;
  }
  return out.replace(TAG, "");
}

function clean(text: string): string {
  return stripMarkup(text)
    .replace(CONTROL, (char) => (/\s/.test(char) ? " " : ""))
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Request and response
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Brave reports failures as
 * `{ type: "ErrorResponse", error: { detail, code, meta } }`, where `meta`
 * sometimes carries a per-parameter breakdown and sometimes just names the
 * component. Both shapes are read, and anything unrecognised falls back to the
 * raw body so an unknown failure is still legible in the logs.
 */
async function apiDetail(response: Response): Promise<string> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return "";
  }
  if (!text) return "";

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return ` Resposta da API: ${text.slice(0, 200)}`;
  }

  const error = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : undefined;
  const parts: string[] = [];
  if (error && typeof error.detail === "string") parts.push(error.detail);

  const meta = error && isRecord(error.meta) ? error.meta : undefined;
  const errors = meta && Array.isArray(meta.errors) ? meta.errors : [];
  const first = errors[0];
  if (isRecord(first) && typeof first.msg === "string") parts.push(first.msg);

  const detail = parts.join(" — ") || text.slice(0, 200);
  return ` Resposta da API: ${detail}`;
}

// ---------------------------------------------------------------------------
// Rate limit headers
// ---------------------------------------------------------------------------
//
// Brave answers both of its limits — the per-second one and the monthly plan
// quota — with the same 429, and tells the two apart only in the headers:
// `X-RateLimit-Remaining: 0, 1934` and `X-RateLimit-Reset: 1, 1419704`, one
// figure per window, the reset counted in seconds from now. A monthly quota
// that ran out therefore reads as a reset days away, and retrying it three
// times only spends three more requests of a budget that is already gone.

function headerValue(response: Response, name: string): string | undefined {
  // Tolerates any response-like object: a header-less double, or a transport
  // that dropped the headers, degrades to "no hint" instead of throwing.
  const headers: unknown = (response as { headers?: unknown }).headers;
  if (!isRecord(headers) || typeof headers.get !== "function") return undefined;
  const value: unknown = (headers.get as (key: string) => unknown)(name);
  return typeof value === "string" ? value : undefined;
}

function parseWindowList(raw: string | undefined): number[] | undefined {
  if (!raw) return undefined;
  const values = raw.split(",").map((part) => toFiniteNumber(part));
  if (values.length === 0 || values.some((value) => value === undefined)) return undefined;
  return values as number[];
}

/** How long Brave says to wait, or `undefined` when it did not say. */
function resetWaitMs(response: Response): number | undefined {
  const reset = parseWindowList(headerValue(response, "X-RateLimit-Reset"));
  if (!reset || reset.length === 0 || reset.some((seconds) => seconds < 0)) return undefined;

  // `remaining` is what identifies *which* window is empty. Without it the
  // shortest reset is the earliest legal retry, which is the old blind
  // behaviour with a better number rather than a new failure mode.
  const remaining = parseWindowList(headerValue(response, "X-RateLimit-Remaining"));
  const empty =
    remaining && remaining.length === reset.length
      ? reset.filter((_, index) => remaining[index]! <= 0)
      : [];

  const seconds = empty.length > 0 ? Math.max(...empty) : Math.min(...reset);
  return Math.ceil(seconds * 1_000);
}

function humanWait(ms: number): string {
  const seconds = Math.ceil(ms / 1_000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.ceil(hours / 24)} dias`;
}

function rateLimitError(response: Response, detail: string): BraveSearchError {
  const waitMs = resetWaitMs(response);

  if (waitMs !== undefined && waitMs > maxBackoffMs()) {
    return new BraveSearchError(
      `A cota da Brave Search acabou (429). A API só volta a aceitar buscas em ` +
        `${humanWait(waitMs)}, então não adianta tentar de novo agora: espere esse ` +
        `prazo ou renove o plano em https://api-dashboard.search.brave.com.${detail}`,
      { status: 429 },
    );
  }

  return new BraveSearchError(
    `Limite de requisições da Brave atingido (429). O plano gratuito aceita ` +
      `uma busca por segundo; aumente BRAVE_MIN_INTERVAL_MS se isso persistir.${detail}`,
    { status: 429, retryable: true, retryAfterMs: waitMs },
  );
}

async function httpError(response: Response): Promise<BraveSearchError> {
  const detail = await apiDetail(response);
  const status = response.status;

  switch (status) {
    case 401:
      return new BraveSearchError(
        `A Brave recusou a chave (401). Confira BRAVE_API_KEY no ambiente do backend.${detail}`,
        { status },
      );
    case 422:
      return new BraveSearchError(
        `A Brave recusou os parâmetros da busca (422). Confira BRAVE_SEARCH_LANG, ` +
          `BRAVE_COUNTRY e BRAVE_FRESHNESS.${detail}`,
        { status },
      );
    case 429:
      return rateLimitError(response, detail);
    case 402:
    case 403:
      return new BraveSearchError(
        `A assinatura da Brave está sem créditos ou bloqueada (${status}). ` +
          `Confira o painel em https://api-dashboard.search.brave.com.${detail}`,
        { status },
      );
    default:
      return new BraveSearchError(
        `A Brave respondeu ${status} de forma inesperada.${detail}`,
        // 5xx is the provider having a bad moment, which is exactly what a
        // retry is for; an unexpected 4xx is our request being wrong.
        { status, retryable: status >= 500 },
      );
  }
}

function asBraveError(err: unknown): BraveSearchError {
  if (err instanceof BraveSearchError) return err;
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      // Not retryable: the full timeout budget is already spent, and three of
      // them in a row would leave a live conversation waiting the better part
      // of a minute for one thinker.
      return new BraveSearchError(
        `A busca na Brave passou de ${timeoutMs()} ms e foi cancelada.`,
      );
    }
    return new BraveSearchError(`Falha de rede ao chamar a Brave: ${err.message}`, {
      retryable: true,
    });
  }
  return new BraveSearchError("Falha desconhecida ao chamar a Brave Search.");
}

async function requestOnce(url: string, key: string): Promise<unknown> {
  stats.requests++;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": key,
      },
      signal: AbortSignal.timeout(timeoutMs()),
    });
  } finally {
    // Stamped when the exchange ends rather than when it starts. Brave meters
    // by arrival, and the first request of a run pays a TLS handshake that the
    // next one skips — so two requests sent 1100 ms apart were observed landing
    // inside the same one-second window and earning a 429. Measured from the
    // response, the gap the server sees is never narrower than the interval.
    lastExchangeAt = Date.now();
  }

  if (!response.ok) throw await httpError(response);

  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // A 200 whose body is not JSON is a proxy or CDN challenge page rather than
    // an answer. Degrade to zero results: a thinker without sources still
    // reasons, whereas a thrown error takes the whole angle out of the run.
    return null;
  }
}

async function withRetries(url: string, key: string): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    await awaitSlot();
    try {
      return await requestOnce(url, key);
    } catch (err) {
      const error = asBraveError(err);
      if (!error.retryable || attempt >= MAX_ATTEMPTS) throw error;
      stats.retries++;
      // Brave's own figure when it gave one — waiting less than it asked for
      // buys another 429, waiting the blind backoff instead can overshoot.
      const wait = error.retryAfterMs ?? backoffMs(attempt);
      if (wait > 0) await delay(wait);
    }
  }
}

function toResponse(query: string, body: unknown): BraveSearchResponse {
  const web = isRecord(body) && isRecord(body.web) ? body.web : undefined;
  const raw = web && Array.isArray(web.results) ? web.results : [];

  const results: BraveResult[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const url = typeof entry.url === "string" ? entry.url.trim() : "";
    if (!url) continue;

    const result: BraveResult = {
      title: clean(typeof entry.title === "string" ? entry.title : ""),
      url,
      snippet: clean(typeof entry.description === "string" ? entry.description : ""),
    };

    const pageAge = typeof entry.page_age === "string" ? entry.page_age.trim() : "";
    const age = typeof entry.age === "string" ? entry.age.trim() : "";
    if (pageAge) result.age = pageAge;
    else if (ISO_DATE_PREFIX.test(age)) result.age = age;

    results.push(result);
  }

  // `summary` stays unset on purpose. Brave returns a summarizer *key*, not
  // prose, and redeeming it costs a second round trip — which on a one-per-
  // second budget would halve how much of the web ten thinkers get to read.
  return { query, results };
}

async function runSearch(query: string, requestedCount?: number): Promise<BraveSearchResponse> {
  try {
    const trimmed = query.trim();
    if (!trimmed) {
      throw new BraveSearchError("A busca precisa de um termo — a query chegou vazia.");
    }
    const key = apiKey();
    const body = await withRetries(buildUrl(trimmed, requestedCount), key);
    stats.searches++;
    return toResponse(trimmed, body);
  } catch (err) {
    stats.failures++;
    throw asBraveError(err);
  }
}

/**
 * Search the web. Concurrent callers are serialised and spaced apart, so a
 * thinker never has to know about the rate limit — it only has to await.
 */
export const braveSearch: SearchFn = (query, options) =>
  enqueue(() => runSearch(query, options?.count));
