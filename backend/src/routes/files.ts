import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname } from "node:path";
import { v4 as uuidv4 } from "uuid";
import { validateAttachmentPath, ensureDir } from "../middleware/sandbox.js";
import { getConversation, updateConversation } from "../services/storage.js";
import type { Attachment } from "../types/index.js";

const router = Router();

// 50 MB per file
const MAX_FILE_SIZE = 50 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
});

// MIME map for sending files with proper Content-Type
const MIME_MAP: Record<string, string> = {
  ".txt": "text/plain",
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".zip": "application/zip",
  ".csv": "text/csv",
  ".md": "text/markdown",
};

function mimeFromFilename(filename: string): string {
  const ext = extname(filename).toLowerCase();
  return MIME_MAP[ext] ?? "application/octet-stream";
}

// Types the browser can render without being able to run script in this
// origin. Everything else — notably text/html and image/svg+xml, both of
// which execute JavaScript — is forced to download instead of render, so an
// uploaded file can never become stored XSS against the API origin.
const INLINE_SAFE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
  "video/mp4",
  "video/webm",
  "text/plain",
]);

/**
 * Build a Content-Disposition value that is safe to put in a header:
 * quoted ASCII fallback plus the RFC 5987 UTF-8 form.
 */
function contentDisposition(mode: "inline" | "attachment", name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${mode}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function sendAttachmentFile(
  res: Response,
  data: Buffer,
  storedName: string,
  downloadName: string,
): void {
  const mime = mimeFromFilename(storedName);
  const inline = INLINE_SAFE_TYPES.has(mime);

  res.setHeader("Content-Type", inline ? mime : "application/octet-stream");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader(
    "Content-Disposition",
    contentDisposition(inline ? "inline" : "attachment", downloadName),
  );
  res.send(data);
}

// ── POST /api/files/:convId — Upload one or more files ──────────────────────

router.post(
  "/:convId",
  upload.array("files", 20),
  async (req, res, next) => {
    try {
      const convId = req.params.convId as string;

      // Ensure the conversation exists
      const conversation = await getConversation(convId);
      if (!conversation) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      const files = req.files as Express.Multer.File[] | undefined;
      if (!files || files.length === 0) {
        return res.status(400).json({ error: "No files provided" });
      }

      const dir = validateAttachmentPath(convId);
      await ensureDir(dir);

      const now = new Date().toISOString();
      const added: Attachment[] = [];

      for (const file of files) {
        const safeName = `${uuidv4()}${extname(file.originalname).toLowerCase()}`;
        const filePath = validateAttachmentPath(convId, safeName);

        await writeFile(filePath, file.buffer);

        const attachment: Attachment = {
          id: uuidv4(),
          filename: safeName,
          original_name: file.originalname,
          mime_type: mimeFromFilename(file.originalname),
          size_bytes: file.size,
          path: safeName,
          added_at: now,
        };

        added.push(attachment);
      }

      // Append attachments to the conversation record
      const existingAttachments = conversation.attachments ?? [];
      await updateConversation(convId, {
        attachments: [...existingAttachments, ...added],
      });

      res.status(201).json(added);
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /api/files/:convId — List attachments for a conversation ────────────

router.get("/:convId", async (req, res, next) => {
  try {
    const convId = req.params.convId as string;

    const conversation = await getConversation(convId);
    if (!conversation) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    const dir = validateAttachmentPath(convId);

    try {
      const entries = await readdir(dir, { withFileTypes: true });
      const attachments: Attachment[] = [];

      for (const entry of entries) {
        if (!entry.isFile()) continue;

        const filePath = validateAttachmentPath(convId, entry.name);
        const stats = await stat(filePath);

        // Try to match against existing metadata
        const existing = (conversation.attachments ?? []).find(
          (a) => a.filename === entry.name,
        );

        attachments.push({
          id: existing?.id ?? "",
          filename: entry.name,
          original_name: existing?.original_name ?? entry.name,
          mime_type: existing?.mime_type ?? mimeFromFilename(entry.name),
          size_bytes: stats.size,
          path: entry.name,
          added_at: existing?.added_at ?? "",
        });
      }

      res.json(attachments);
    } catch (err: unknown) {
      if (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        // Directory doesn't exist yet — no files uploaded
        return res.json([]);
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

// ── GET /api/files/:convId/:filename — Read a single file ───────────────────

router.get("/:convId/:filename", async (req, res, next) => {
  try {
    const convId = req.params.convId as string;
    const filename = req.params.filename as string;

    const filePath = validateAttachmentPath(convId, filename);

    try {
      const data = await readFile(filePath);

      // Prefer the name the user uploaded for the download prompt; fall back
      // to the stored UUID name when there is no metadata for it.
      const conversation = await getConversation(convId);
      const known = (conversation?.attachments ?? []).find(
        (a) => a.filename === filename,
      );

      sendAttachmentFile(res, data, filename, known?.original_name ?? filename);
    } catch (err: unknown) {
      if (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return res.status(404).json({ error: "File not found" });
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

// ── Multer error handling ───────────────────────────────────────────────────
// MulterError carries no `status`, so without this an oversized upload reaches
// the generic handler and comes back as 500 "Internal server error".

router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      res.status(413).json({ error: "File too large. Maximum size is 50 MB." });
      return;
    }
    if (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE") {
      res.status(400).json({ error: "Too many files. Maximum is 20 per upload." });
      return;
    }
    res.status(400).json({ error: err.message });
    return;
  }

  next(err);
});

export default router;
