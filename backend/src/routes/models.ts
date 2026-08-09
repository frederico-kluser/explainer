import { Router } from "express";

import { defaultMinYear, listCatalog } from "../services/model-catalog.js";
import { isProvider } from "../services/providers/keys.js";

// === GET /api/models — the model catalogue the roster picks from ===
//
// Multi-provider discovery, cached, with the year filter the operator asked for
// (2026+ by default) and a text search. Every policy decision lives in
// `services/model-catalog.ts`; this file only turns a query string into the
// options that service takes.
//
// Nothing here rejects. A query is CLAMPED into range instead of earning a 400,
// the precedent being `services/settings.ts`, which pulls an out-of-range speed
// into the range the API accepts rather than failing the request. The caller is
// a model picker: answering "your min_year is not a number" empties the list
// the user is looking at, while answering with the default fills it.

const router = Router();

/** First value wins when a key repeats; anything that is not a string reads as absent. */
function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const first = value[0];
    return typeof first === "string" ? first : "";
  }
  return "";
}

/** Accepts both `?k=a&k=b` and `?k=a,b`, because a caller will send either. */
function asList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const one of raw) {
    if (typeof one !== "string") continue;
    for (const part of one.split(",")) {
      const trimmed = part.trim();
      if (trimmed) out.push(trimmed);
    }
  }
  return out;
}

/** `?refresh` with no value counts as true — the precedent is `routes/memory.ts`. */
function isTrue(value: unknown): boolean {
  return value === "" || value === "true" || value === "1";
}

/** Tri-state: absent or unreadable takes `fallback`, so a typo does not invert a default. */
function boolParam(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const raw = asString(value).trim().toLowerCase();
  if (raw === "" || raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  return fallback;
}

// No calendar meaning, just a bound: a year is at most four digits, and this
// keeps `min_year=1e309` out of the response it is echoed into.
const MAX_YEAR = 9999;

function yearParam(value: unknown, fallback: number): number {
  const raw = asString(value).trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(MAX_YEAR, Math.max(0, Math.floor(parsed)));
}

router.get("/", async (req, res) => {
  // An unknown provider name filters away to nothing, which the service reads
  // as "all providers". That is the clamp again: a stale bookmark naming a
  // provider this build dropped shows the whole catalogue rather than an empty
  // one, and a valid name alongside it still narrows as asked.
  const providers = asList(req.query.provider).filter(isProvider);

  res.json(
    await listCatalog({
      providers,
      minYear: yearParam(req.query.min_year, defaultMinYear()),
      includeUndated: boolParam(req.query.include_undated, true),
      q: asString(req.query.q),
      keep: asList(req.query.keep),
      refresh: isTrue(req.query.refresh),
    }),
  );
});

export default router;
