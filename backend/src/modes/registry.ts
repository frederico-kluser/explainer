// === The mode registry ===
//
// The one place that knows every mode. Adding a mode is: write the file next to
// this one, import it, and add a line to `MODES`. Nothing else in the codebase
// enumerates modes — the routes serve this map, the browser renders whatever
// `GET /api/modes` hands it, and `prompts.ts` asks the mode for its sections
// rather than branching on its id.
//
// Declaration order is the order the picker shows them in, and the first entry
// is the default.

import { CONVERSATION_MODE } from "./conversation.js";
import { PRESENTATION_MODE } from "./presentation.js";
import type { ModeDefinition } from "./types.js";

export const MODES = {
  conversation: CONVERSATION_MODE,
  presentation: PRESENTATION_MODE,
} as const satisfies Record<string, ModeDefinition>;

export type ModeId = keyof typeof MODES;

/**
 * What a conversation with no mode recorded is.
 *
 * Every conversation created before this feature existed is in that state, and
 * so is any conversation created by a client that does not send one. Both have
 * to keep behaving exactly as they did, which is why the default is the mode
 * that carries the old behaviour rather than a neutral empty one.
 */
export const DEFAULT_MODE_ID: ModeId = "conversation";

export function listModes(): ModeDefinition[] {
  return Object.values(MODES);
}

export function isModeId(value: unknown): value is ModeId {
  return typeof value === "string" && value in MODES;
}

/** The mode for an id off disk or off the wire. Unknown falls back, never throws. */
export function getMode(id: unknown): ModeDefinition {
  return isModeId(id) ? MODES[id] : MODES[DEFAULT_MODE_ID];
}
