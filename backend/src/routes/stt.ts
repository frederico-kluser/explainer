import { Router, type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile, unlink } from "node:fs/promises";
import { transcribe } from "../services/openrouter.js";

const router = Router();

// ---------------------------------------------------------------------------
// Multer config: memory storage, 25 MB limit, audio/* only
// ---------------------------------------------------------------------------

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB — Whisper max
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("audio/")) {
      cb(null, true);
    } else {
      cb(new Error("Only audio files are accepted"));
    }
  },
});

// ---------------------------------------------------------------------------
// POST /api/stt
// ---------------------------------------------------------------------------

router.post("/", upload.single("audio"), async (req, res, next) => {
  let tempPath: string | null = null;

  try {
    // --- File validation ---

    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "No audio file uploaded. Use field name 'audio'." });
      return;
    }

    // --- Save buffer to temp file ---

    const ext = file.originalname.split(".").pop() || "webm";
    tempPath = join(tmpdir(), `stt-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
    await writeFile(tempPath, file.buffer);

    // --- Transcribe ---

    const text = await transcribe(tempPath);

    // --- Respond ---

    res.json({ text });
  } catch (err) {
    // Forward to error-handler middleware (handles multer errors and OpenRouter errors)
    next(err);
  } finally {
    // --- Clean up temp file ---
    if (tempPath) {
      try {
        await unlink(tempPath);
      } catch {
        // Best effort — file may already be gone
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Multer error handling — transform multer errors into proper HTTP responses
// ---------------------------------------------------------------------------

router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      res.status(413).json({ error: "File too large. Maximum size is 25 MB." });
      return;
    }
    res.status(400).json({ error: err.message });
    return;
  }

  if (err instanceof Error && err.message === "Only audio files are accepted") {
    res.status(400).json({ error: "Invalid file type. Only audio files are accepted." });
    return;
  }

  next(err);
});

export default router;
