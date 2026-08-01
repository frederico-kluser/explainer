import { getConversation, updateConversation } from "./storage.js";
import { REALTIME_VOICE } from "./openai.js";

/**
 * Voices the Realtime API ships. `marin` and `cedar` are the two OpenAI
 * recommends for quality; the rest are the older set, kept because people have
 * preferences and switching is free.
 *
 * Note the constraint that shapes the UI: once a session has emitted audio, its
 * voice is frozen. Changing it takes a reconnect, so the picker is disabled
 * while a call is live.
 */
export const VOICES = [
  "marin",
  "cedar",
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "sage",
  "shimmer",
  "verse",
] as const;

export type Voice = (typeof VOICES)[number];

export interface ConversationSettings {
  voice: Voice;
  /** Playback rate, 0.25–1.5. Changes how fast it sounds, not what it says. */
  speed: number;
}

const MIN_SPEED = 0.25;
const MAX_SPEED = 1.5;

export function defaultSettings(): ConversationSettings {
  return {
    voice: (VOICES as readonly string[]).includes(REALTIME_VOICE)
      ? (REALTIME_VOICE as Voice)
      : "marin",
    speed: 1,
  };
}

/** Everything here comes off disk or off the wire, so nothing is trusted. */
export function normalizeSettings(value: unknown): ConversationSettings {
  const defaults = defaultSettings();
  if (value === null || typeof value !== "object") return defaults;

  const candidate = value as Partial<ConversationSettings>;
  const voice =
    typeof candidate.voice === "string" &&
    (VOICES as readonly string[]).includes(candidate.voice)
      ? (candidate.voice as Voice)
      : defaults.voice;

  const rawSpeed = Number(candidate.speed);
  const speed = Number.isFinite(rawSpeed)
    ? Math.min(MAX_SPEED, Math.max(MIN_SPEED, rawSpeed))
    : defaults.speed;

  return { voice, speed };
}

export async function getSettings(
  conversationId: string,
): Promise<ConversationSettings> {
  const conv = await getConversation(conversationId);
  return normalizeSettings(conv?.metadata?.settings);
}

export async function setSettings(
  conversationId: string,
  patch: unknown,
): Promise<ConversationSettings> {
  const conv = await getConversation(conversationId);
  const current = normalizeSettings(conv?.metadata?.settings);
  const merged = normalizeSettings({
    ...current,
    ...(patch && typeof patch === "object" ? patch : {}),
  });

  await updateConversation(conversationId, {
    metadata: { ...(conv?.metadata ?? {}), settings: merged },
  });

  return merged;
}
