import { Router } from "express";

import { SourceError, resolveSource } from "../services/sources.js";
import {
  MaterialLimitError,
  addSource,
  listSources,
  removeSource,
} from "../services/source-store.js";
import { getConversation, updateConversation } from "../services/storage.js";
import { toolsForSources } from "../tools/index.js";
import { greetingFor } from "../prompts.js";
import { isUUID } from "../middleware/sandbox.js";
import type { ResolvedSource, SourceSpec } from "../types/index.js";

const router = Router();

/**
 * The full anchor document can be tens of kilobytes and the browser has no use
 * for it — it lives in the model's instructions, not in the UI. Send a preview.
 */
function summarize(source: ResolvedSource) {
  return {
    id: source.id,
    kind: source.kind,
    label: source.label,
    origin: source.origin,
    primary_doc_path: source.primary_doc_path,
    primary_doc_preview: source.primary_doc?.slice(0, 400) ?? null,
    primary_doc_chars: source.primary_doc?.length ?? 0,
    ephemeral: source.ephemeral ?? false,
    resolved_at: source.resolved_at,
  };
}

function envelope(sources: ResolvedSource[]) {
  return {
    materials: sources.map(summarize),
    tools: toolsForSources(sources).map((tool) => tool.name),
    greeting: greetingFor(sources),
  };
}

// POST /api/sources — add a material to a conversation
router.post("/", async (req, res, next) => {
  const { conversation_id, source: spec } = req.body as {
    conversation_id?: string;
    source?: SourceSpec;
  };

  if (!conversation_id || !isUUID(conversation_id)) {
    res.status(400).json({ error: "Invalid conversation_id" });
    return;
  }
  if (!spec || typeof spec !== "object") {
    res.status(400).json({ error: "Missing source" });
    return;
  }

  const conv = await getConversation(conversation_id);
  if (!conv) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }

  try {
    const resolved = await resolveSource(spec);
    const sources = await addSource(conversation_id, resolved);

    // A conversation still called "Nova conversa" is worth naming after its
    // first material — after that the user's own title wins.
    if (/^nova conversa$/i.test(conv.title)) {
      await updateConversation(conversation_id, { title: resolved.label });
    }

    res.status(201).json({ ...envelope(sources), added: summarize(resolved) });
  } catch (err) {
    if (err instanceof SourceError || err instanceof MaterialLimitError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    const status = (err as { status?: number }).status;
    if (typeof status === "number") {
      res.status(status).json({ error: (err as Error).message });
      return;
    }
    next(err);
  }
});

// GET /api/sources/:convId — the materials of a conversation
router.get("/:convId", async (req, res) => {
  const convId = req.params.convId!;
  if (!isUUID(convId)) {
    res.status(400).json({ error: "Invalid conversation_id" });
    return;
  }
  res.json(envelope(await listSources(convId)));
});

// DELETE /api/sources/:convId/:sourceId — drop one material
router.delete("/:convId/:sourceId", async (req, res) => {
  const convId = req.params.convId!;
  if (!isUUID(convId)) {
    res.status(400).json({ error: "Invalid conversation_id" });
    return;
  }

  const before = await listSources(convId);
  const sources = await removeSource(convId, req.params.sourceId!);

  if (sources.length === before.length) {
    res.status(404).json({ error: "Material não encontrado" });
    return;
  }

  res.json(envelope(sources));
});

export default router;
