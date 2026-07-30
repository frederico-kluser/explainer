import { Router } from "express";
import {
  listConversations,
  getConversation,
  createConversation,
  updateConversation,
  deleteConversation,
} from "../services/storage.js";
import { isUUID } from "../middleware/sandbox.js";
import type { Conversation } from "../types/index.js";

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
    patch.metadata = source.metadata as Record<string, unknown>;
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
