import { Router } from "express";
import { isUUID } from "../middleware/sandbox.js";
import {
  readDocument,
  writeDocument,
  deleteDocument,
} from "../services/document-store.js";
import { noteDocumentChanged } from "../services/conversation-bus.js";

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/conversations/:id/document
// ---------------------------------------------------------------------------

router.get("/:id/document", async (req, res) => {
  const conversationId = req.params.id!;

  if (!isUUID(conversationId)) {
    res.status(400).json({ error: "Invalid conversation ID format." });
    return;
  }

  try {
    const content = await readDocument(conversationId);
    if (content === null) {
      res.status(404).json({ error: "Esta conversa ainda nao tem documento." });
      return;
    }
    res.json({ content });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// ---------------------------------------------------------------------------
// PUT /api/conversations/:id/document
// ---------------------------------------------------------------------------

router.put("/:id/document", async (req, res) => {
  const conversationId = req.params.id!;

  if (!isUUID(conversationId)) {
    res.status(400).json({ error: "Invalid conversation ID format." });
    return;
  }

  const raw = req.body;
  if (raw === null || typeof raw !== "object" || typeof raw.content !== "string") {
    res
      .status(400)
      .json({ error: "Body must be { content: string }." });
    return;
  }

  try {
    const stored = await writeDocument(conversationId, raw.content as string);

    // Broadcast so every open screen (including the one that sent this) stays in
    // sync.
    noteDocumentChanged(conversationId, stored, "user");

    res.json({ content: stored });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/conversations/:id/document
// ---------------------------------------------------------------------------

router.delete("/:id/document", async (req, res) => {
  const conversationId = req.params.id!;

  if (!isUUID(conversationId)) {
    res.status(400).json({ error: "Invalid conversation ID format." });
    return;
  }

  try {
    await deleteDocument(conversationId);
    noteDocumentChanged(conversationId, "", "user");
    res.status(204).send();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

export default router;
