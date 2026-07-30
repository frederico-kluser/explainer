// A single AudioContext for the whole app.
//
// Browsers cap the number of live AudioContexts per page (Chrome allows ~6).
// Every AudioPlayer used to construct its own, so a conversation with more than
// a handful of spoken replies stopped producing sound entirely. One shared
// context — never closed while the app is mounted — removes that ceiling.

let ctx: AudioContext | null = null;

export function getAudioContext(): AudioContext {
  if (!ctx || ctx.state === "closed") {
    ctx = new AudioContext();
  }
  return ctx;
}

/** Resume the context after the browser's autoplay policy suspended it. */
export async function resumeAudioContext(): Promise<AudioContext> {
  const context = getAudioContext();
  if (context.state === "suspended") {
    await context.resume();
  }
  return context;
}

// Decoded buffers are reusable across sources, so the same reply is never
// fetched or decoded twice — the inline player and the "current utterance"
// player share one download.
//
// Decoded PCM is bulky (~5 MB per 30 s clip), so the cache is capped and
// evicted oldest-first rather than growing for the lifetime of the page.
const MAX_CACHED_CLIPS = 12;
const buffers = new Map<string, Promise<AudioBuffer>>();

export function loadAudioBuffer(url: string): Promise<AudioBuffer> {
  const cached = buffers.get(url);
  if (cached) {
    // Refresh recency: Map preserves insertion order, so re-inserting moves
    // this entry to the end and keeps it out of the next eviction.
    buffers.delete(url);
    buffers.set(url, cached);
    return cached;
  }

  const pending = (async () => {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch audio (${response.status})`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return getAudioContext().decodeAudioData(arrayBuffer);
  })();

  // Don't cache failures — a retry should be able to succeed.
  pending.catch(() => buffers.delete(url));

  buffers.set(url, pending);

  while (buffers.size > MAX_CACHED_CLIPS) {
    const oldest = buffers.keys().next();
    if (oldest.done) break;
    buffers.delete(oldest.value);
  }

  return pending;
}
