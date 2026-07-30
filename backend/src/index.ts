import "./load-env.js"; // must run before anything reads process.env

import express from "express";
import cors from "cors";
import { errorHandler } from "./middleware/error-handler.js";

import conversationsRouter from "./routes/conversations.js";
import filesRouter from "./routes/files.js";
import sttRouter from "./routes/stt.js";
import ttsRouter from "./routes/tts.js";
import chatRouter, { audioRouter as chatAudioRouter } from "./routes/chat.js";

const app = express();
const PORT = process.env.PORT || 3001;

// --- Middleware ---

// CORS: allow the Vite dev server
app.use(
  cors({
    origin: "http://localhost:5173",
  })
);

// Uploaded files are served back to the browser; never let it sniff a
// different Content-Type than the one we declare.
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
});

// JSON body parser with 10 MB limit (room for base64-encoded audio)
app.use(express.json({ limit: "10mb" }));

// --- Health check ---

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

// --- Routes ---

// Mounted before /api/files so the more specific prefix always wins.
app.use("/api/files/audio", chatAudioRouter);
app.use("/api/conversations", conversationsRouter);
app.use("/api/files", filesRouter);
app.use("/api/stt", sttRouter);
app.use("/api/chat", chatRouter);
app.use("/api/tts", ttsRouter);

// --- 404 for unknown API routes (JSON, not Express' HTML default) ---

app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// --- Error handler (must be last) ---

app.use(errorHandler);

// --- Start ---

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});

export default app;
