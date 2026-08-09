// === Provider registry ===
//
// The one place a `ThinkerProvider` becomes something callable. Lookup only:
// discovery, the roster and the fan-out each hold their own policy, and a
// registry that also cached or filtered would be a second place to look for it.

import { deepSeekAdapter, openRouterAdapter } from "./openai-chat.js";
import { openAIResponsesAdapter } from "./openai-responses.js";
import type { ThinkerProvider } from "../../types/thinker-roster.js";
import type { ProviderAdapter } from "./types.js";

const ADAPTERS: Record<ThinkerProvider, ProviderAdapter> = {
  openai: openAIResponsesAdapter,
  openrouter: openRouterAdapter,
  deepseek: deepSeekAdapter,
};

/**
 * Total, so there is no "unknown provider" branch to handle: `ThinkerProvider`
 * is a closed union and the record above is exhaustive by type. Adding a
 * provider to the union fails to compile here until an adapter exists for it.
 */
export function adapterFor(provider: ThinkerProvider): ProviderAdapter {
  return ADAPTERS[provider];
}

/** Every provider, for the callers that fan out across all of them. */
export const ALL_PROVIDERS: ThinkerProvider[] = ["openai", "openrouter", "deepseek"];
