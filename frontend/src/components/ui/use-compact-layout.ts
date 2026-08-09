import { useSyncExternalStore } from "react";

import { COMPACT_MEDIA_QUERY } from "@/components/ui/mobile-shell";

/**
 * Whether the app is below Tailwind's `md`.
 *
 * The shell needs this in JavaScript, not only in CSS: the rail and the two
 * sheets hold the same panels, and `hidden md:block` would mount both copies.
 * Two `MemoryPanel`s would each fetch, and two `Sidebar`s would claim the same
 * Motion `layoutId`, so the active-conversation marker would fly between a rail
 * nobody can see and a sheet nobody opened. One branch is mounted at a time.
 *
 * The list is lazy because this module is imported by code that runs in the
 * test suite, where there is no `window` to query at import time.
 */
let query: MediaQueryList | null = null;

function mediaQuery(): MediaQueryList {
  query ??= window.matchMedia(COMPACT_MEDIA_QUERY);
  return query;
}

function subscribe(onChange: () => void): () => void {
  const list = mediaQuery();
  list.addEventListener("change", onChange);
  return () => list.removeEventListener("change", onChange);
}

function getSnapshot(): boolean {
  return mediaQuery().matches;
}

/** The server snapshot: never used in this SPA, required by the hook's shape. */
function getServerSnapshot(): boolean {
  return false;
}

export function useCompactLayout(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
