// === Which mode a conversation is in ===
//
// The mode is chosen when the conversation is created and never changes after
// that. It lives in `Conversation.metadata.mode`, next to `metadata.settings`,
// for the same reason: `storage.ts` merges `metadata` shallowly on update, so a
// key written once survives every later PATCH that does not mention it.
//
// Immutability is enforced by nobody writing a second time — `POST` records it
// and `PATCH` strips it (see `routes/conversations.ts`). That is deliberate: a
// mode is frozen into the session token at mint time alongside the instructions
// and the tool list, so a conversation that changed mode mid-call would be a
// screen and a model disagreeing about what the call is for.

import { getConversation, updateConversation } from "./storage.js";
import { writeDocument } from "./document-store.js";
import { getMode, DEFAULT_MODE_ID, isModeId } from "../modes/registry.js";
import type { ModeDefinition } from "../modes/types.js";

/** The id to record for a value off the wire. Unknown becomes the default. */
export function normalizeModeId(value: unknown): string {
  return isModeId(value) ? value : DEFAULT_MODE_ID;
}

/** The mode of a stored conversation. A conversation that is gone is default. */
export async function getConversationMode(
  conversationId: string,
): Promise<ModeDefinition> {
  const conversation = await getConversation(conversationId);
  return getMode(conversation?.metadata?.mode);
}

/**
 * Record the mode on a freshly created conversation and lay down its document.
 *
 * The template is written here rather than on first read because the sidebar is
 * the mode's main affordance: opening a presentation conversation to an empty
 * pane would say the feature is missing, while the skeleton says what is about
 * to be filled in. `writeDocument` is a no-op when the content already matches,
 * so a retry costs nothing.
 *
 * Best effort on the document, fatal on the metadata: a conversation whose mode
 * was not recorded would silently be a different mode on the next connect,
 * while a conversation whose document was not seeded is one blank pane the
 * first write fixes.
 */
export async function initConversationMode(
  conversationId: string,
  modeId: unknown,
): Promise<ModeDefinition> {
  const mode = getMode(modeId);

  await updateConversation(conversationId, { metadata: { mode: mode.id } });

  if (mode.document) {
    try {
      await writeDocument(conversationId, mode.document.template);
    } catch (err) {
      console.warn(
        `[modes] ${conversationId}: could not seed the ${mode.id} document:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return mode;
}
