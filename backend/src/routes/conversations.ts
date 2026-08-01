import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import {
  listConversations,
  getConversation,
  createConversation,
  updateConversation,
  deleteConversation,
  appendMessages,
} from "../services/storage.js";
import { getSettings, setSettings, VOICES } from "../services/settings.js";
import { isUUID } from "../middleware/sandbox.js";
import type { Conversation, Message } from "../types/index.js";

const router = Router();

function validateUUID(id: string): void {
  if (!isUUID(id)) {
    const err = new Error(`Invalid conversation ID: ${id}`) as Error & { status: number };
    err.status = 400;
    throw err;
  }
}

// Only these fields may be set from the outside. `messages` and `attachments`
// are owned by /api/chat and /api/files — a PATCH must not be able to rewrite
// or wipe them.
function pickPatchableFields(body: unknown): Partial<Conversation> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    const err = new Error("Request body must be a JSON object") as Error & { status: number };
    err.status = 400;
    throw err;
  }

  const source = body as Record<string, unknown>;
  const patch: Partial<Conversation> = {};

  // summary and summarized_count are managed internally by the summarizer —
  // no outside caller may set them.
  for (const key of ["summary", "summarized_count"]) {
    if (key in source) {
      const err = new Error(
        `The '${key}' field is managed internally and cannot be set via PATCH`,
      ) as Error & { status: number };
      err.status = 400;
      throw err;
    }
  }

  if (source.title !== undefined) {
    if (typeof source.title !== "string" || source.title.trim().length === 0) {
      const err = new Error('"title" must be a non-empty string') as Error & { status: number };
      err.status = 400;
      throw err;
    }
    patch.title = source.title;
  }

  if (source.metadata !== undefined) {
    if (
      source.metadata === null ||
      typeof source.metadata !== "object" ||
      Array.isArray(source.metadata)
    ) {
      const err = new Error('"metadata" must be an object') as Error & { status: number };
      err.status = 400;
      throw err;
    }
    const meta = { ...(source.metadata as Record<string, unknown>) };
    // Strip internally managed keys even when nested inside metadata.
    delete meta.summary;
    delete meta.summarized_count;
    patch.metadata = meta;
  }

  return patch;
}

// GET /api/conversations
router.get("/", async (_req, res, next) => {
  try {
    const conversations = await listConversations();
    res.json(conversations);
  } catch (err) {
    next(err);
  }
});

// POST /api/conversations
router.post("/", async (req, res, next) => {
  try {
    const { title } = req.body;
    if (!title || typeof title !== "string") {
      const err = new Error('Missing or invalid "title" field') as Error & { status: number };
      err.status = 400;
      throw err;
    }
    const conversation = await createConversation(title);
    res.status(201).json(conversation);
  } catch (err) {
    next(err);
  }
});

// GET /api/conversations/:id
router.get("/:id", async (req, res, next) => {
  try {
    validateUUID(req.params.id!);
    const conversation = await getConversation(req.params.id!);
    if (!conversation) {
      const err = new Error("Conversation not found") as Error & { status: number };
      err.status = 404;
      throw err;
    }
    res.json(conversation);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/conversations/:id
router.patch("/:id", async (req, res, next) => {
  try {
    validateUUID(req.params.id!);
    const conversation = await updateConversation(
      req.params.id!,
      pickPatchableFields(req.body),
    );
    res.json(conversation);
  } catch (err) {
    next(err);
  }
});

// POST /api/conversations/:id/messages
//
// The realtime session runs in the browser, so the transcript only exists there
// until it is posted back: user turns from
// `conversation.item.input_audio_transcription.completed`, assistant turns from
// `response.output_audio_transcript.done`. Appending (rather than PATCHing the
// array) keeps two tabs on the same conversation from clobbering each other.
router.post("/:id/messages", async (req, res, next) => {
  try {
    validateUUID(req.params.id!);

    const body = req.body as { messages?: unknown };
    const incoming = Array.isArray(body?.messages) ? body.messages : null;
    if (!incoming || incoming.length === 0) {
      const err = new Error("Body must be { messages: [...] }") as Error & { status: number };
      err.status = 400;
      throw err;
    }
    if (incoming.length > 50) {
      const err = new Error("At most 50 messages per request") as Error & { status: number };
      err.status = 400;
      throw err;
    }

    const messages: Message[] = incoming.map((raw) => {
      const item = (raw ?? {}) as Partial<Message>;
      const role =
        item.role === "user" || item.role === "assistant" || item.role === "tool"
          ? item.role
          : "assistant";
      return {
        id: typeof item.id === "string" && item.id ? item.id : uuidv4(),
        role,
        content: typeof item.content === "string" ? item.content : null,
        timestamp:
          typeof item.timestamp === "string"
            ? item.timestamp
            : new Date().toISOString(),
      };
    });

    const conversation = await appendMessages(req.params.id!, messages);
    res.status(201).json({ appended: messages.length, updated_at: conversation.updated_at });
  } catch (err) {
    next(err);
  }
});

// GET /api/conversations/:id/settings
router.get("/:id/settings", async (req, res, next) => {
  try {
    validateUUID(req.params.id!);
    res.json({ ...(await getSettings(req.params.id!)), voices: VOICES });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/conversations/:id/settings
//
// Voice and speed. The voice only takes effect on the next session — the
// Realtime API freezes it once a session has emitted audio — while speed can be
// pushed live over the data channel.
router.patch("/:id/settings", async (req, res, next) => {
  try {
    validateUUID(req.params.id!);
    const settings = await setSettings(req.params.id!, req.body);
    res.json({ ...settings, voices: VOICES });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/conversations/:id
router.delete("/:id", async (req, res, next) => {
  try {
    validateUUID(req.params.id!);
    await deleteConversation(req.params.id!);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
