import { Router } from "express";
import { synthesize } from "../services/openrouter.js";

const router = Router();

const MAX_TEXT_LENGTH = 4096;

// POST /api/tts
router.post("/", async (req, res, next) => {
  try {
    const { text } = req.body;

    // Validate: text must be present and a non-empty string
    if (text === undefined || text === null || typeof text !== "string" || text.trim().length === 0) {
      const err = new Error("text is required") as Error & { status: number };
      err.status = 400;
      throw err;
    }

    // Validate: text must not exceed max length
    if (text.length > MAX_TEXT_LENGTH) {
      const err = new Error(`text too long (max ${MAX_TEXT_LENGTH} chars)`) as Error & { status: number };
      err.status = 400;
      throw err;
    }

    // Synthesize
    let buffer: Buffer;
    try {
      buffer = await synthesize(text);
    } catch (synthErr) {
      const message = synthErr instanceof Error ? synthErr.message : String(synthErr);
      const err = new Error(`TTS failed: ${message}`) as Error & { status: number };
      err.status = 502;
      throw err;
    }

    // Send audio response
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", buffer.length);
    res.setHeader("Cache-Control", "no-cache");
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

export default router;
