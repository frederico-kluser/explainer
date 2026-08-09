import { Router } from "express";

import {
  buildResume,
  clearMemory,
  exportMemory,
  importMemory,
} from "../services/memory.js";
import { noteMemoryChanged } from "../services/conversation-bus.js";
import { isUUID } from "../middleware/sandbox.js";
import type { MemoryFile } from "../types/deep-tools.js";

// ---------------------------------------------------------------------------
// /api/conversations/:id/memory — the conversation as a file you can take away
// ---------------------------------------------------------------------------
//
// Mounted on the same prefix as `conversations.ts` rather than under its own,
// because the memory of a conversation is addressed by the conversation. Express
// tries the routers in mount order and `/:id` never matches `/:id/memory`, so
// the two coexist.
//
// Every path here contains `:`, so no handler in this file may be annotated
// `(req: Request, res: Response)` — Express 5 discards the route-string
// inference when it is, and `req.params.id` widens to `string | string[]`.

const router = Router();

function validateUUID(id: string): void {
  if (!isUUID(id)) {
    const err = new Error(`Invalid conversation ID: ${id}`) as Error & { status: number };
    err.status = 400;
    throw err;
  }
}

/**
 * Read an affirmative query flag: `?f`, `?f=true` and `?f=1`.
 *
 * Everything else is a no, including a repeated parameter — Express hands that
 * over as an array, and `?overwrite=false&overwrite=true` is not a sentence
 * anyone should be able to write to authorise deleting their own memory.
 */
function isTrue(value: unknown): boolean {
  if (value === "") return true;
  return value === "true" || value === "1";
}

/** Portuguese, and a 404: the caller is a person who asked for a file. */
function noMemory(): Error & { status: number } {
  const err = new Error(
    "Esta conversa ainda não tem memória gravada.",
  ) as Error & { status: number };
  err.status = 404;
  return err;
}

// GET /api/conversations/:id/memory — the whole file
//
// `?download` sets the attachment header, so the browser can hand the user a
// file without having to rebuild one from the JSON.
router.get("/:id/memory", async (req, res, next) => {
  try {
    validateUUID(req.params.id!);

    const file = await exportMemory(req.params.id!);
    if (!file) throw noMemory();

    if (req.query.download !== undefined) {
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="memoria-${req.params.id}.json"`,
      );
    }
    res.json(file);
  } catch (err) {
    next(err);
  }
});

// POST /api/conversations/:id/memory/import[?overwrite=true] — take a file back in
//
// The conversation in the URL wins over the one written in the file, and the
// file's own `conversation_id` is overwritten before it is validated. That is
// the whole point of the route: a memory exported from one conversation is
// imported into a *new* one to continue it, possibly on another machine, and
// insisting the two ids match would leave the file importable only where it
// already is. It also removes the alternative reading of an id that does not
// match — that `importMemory` should write to the conversation the file names,
// which would let a file decide which conversation this request overwrites.
//
// An import *replaces*, so importing onto a conversation that already remembers
// something destroys it — reflections included, which cost a deep-think round
// each and have no backup anywhere. `?overwrite=true` is how the caller says
// that is what they meant; without it `importMemory` answers 409 and names both
// ways out. The default path cannot destroy anything.
//
// Everything else is checked by `importMemory`, which throws `MemoryFormatError`
// carrying `status: 400` and a message already in Portuguese. The error handler
// delivers it as-is; re-wrapping it here would replace a message naming the
// broken event with a generic one.
router.post("/:id/memory/import", async (req, res, next) => {
  try {
    validateUUID(req.params.id!);

    const body: unknown = req.body;
    // A non-object is passed through untouched so `importMemory` can say so; a
    // spread would turn it into an empty object and produce a worse message.
    const candidate =
      body !== null && typeof body === "object" && !Array.isArray(body)
        ? { ...(body as Record<string, unknown>), conversation_id: req.params.id! }
        : body;

    const file = await importMemory(candidate as MemoryFile, {
      overwrite: isTrue(req.query.overwrite),
    });
    // An import replaces the whole file, so anyone else watching this
    // conversation is holding a count that is now wrong.
    noteMemoryChanged(req.params.id!);
    res.status(201).json(file);
  } catch (err) {
    next(err);
  }
});

// GET /api/conversations/:id/memory/resume — the compressed form
//
// This one costs money: `buildResume` asks the summariser to compress the file.
// It is the same call the session mint makes, exposed so a client can show what
// a resumed session would be seeded with. `EXPLAINER_MEMORY_LLM_SUMMARY=0` turns
// the model call off and leaves the deterministic summary, which is free.
router.get("/:id/memory/resume", async (req, res, next) => {
  try {
    validateUUID(req.params.id!);

    const resume = await buildResume(req.params.id!);
    if (!resume) throw noMemory();

    res.json(resume);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/conversations/:id/memory — forget, without deleting the conversation
router.delete("/:id/memory", async (req, res, next) => {
  try {
    validateUUID(req.params.id!);
    await clearMemory(req.params.id!);
    noteMemoryChanged(req.params.id!);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
