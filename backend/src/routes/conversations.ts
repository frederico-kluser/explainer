import { Router } from "express";
import {
  listConversations,
  getConversation,
  createConversation,
  updateConversation,
  deleteConversation,
} from "../services/storage.js";

const router = Router();

// UUID v4 regex for route parameter validation
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validateUUID(id: string): void {
  if (!UUID_RE.test(id)) {
    const err = new Error(`Invalid conversation ID: ${id}`) as Error & { status: number };
    err.status = 400;
    throw err;
  }
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
    const conversation = await updateConversation(req.params.id!, req.body);
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
