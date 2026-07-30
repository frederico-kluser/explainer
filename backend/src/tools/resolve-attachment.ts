import { getConversation } from "../services/storage.js";

/**
 * Map whatever name the model used onto the name the file is stored under.
 *
 * Uploads are stored as `<uuid>.<ext>` while `list_attachments` shows the
 * original name first, so the model naturally asks for `notes.txt` and used to
 * get "File not found" — costing an extra round trip to discover the UUID.
 * Both spellings resolve here; unknown names pass through unchanged so the
 * sandbox still gets the final say.
 */
export async function resolveAttachmentName(
  requested: string,
  convId: string,
): Promise<string> {
  const conv = await getConversation(convId);
  const attachments = conv?.attachments ?? [];

  const byStoredName = attachments.find((a) => a.filename === requested);
  if (byStoredName) return byStoredName.filename;

  const byOriginalName = attachments.find(
    (a) => a.original_name === requested,
  );
  if (byOriginalName) return byOriginalName.filename;

  // Case-insensitive last resort — models often normalise capitalisation.
  const lowered = requested.toLowerCase();
  const loose = attachments.find(
    (a) =>
      a.original_name.toLowerCase() === lowered ||
      a.filename.toLowerCase() === lowered,
  );
  if (loose) return loose.filename;

  return requested;
}
