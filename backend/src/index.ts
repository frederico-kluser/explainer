import "./load-env.js"; // must run before anything reads process.env

import express from "express";
import cors from "cors";
import { errorHandler } from "./middleware/error-handler.js";

import conversationsRouter from "./routes/conversations.js";
import realtimeRouter from "./routes/realtime.js";
import sourcesRouter from "./routes/sources.js";
import agentsRouter from "./routes/agents.js";
import costsRouter, { creditsRouter } from "./routes/costs.js";
import browseRouter from "./routes/browse.js";
import chatRouter from "./routes/chat.js";

const app = express();
const PORT = Number(process.env.PORT) || 3001;

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

// JSON body parser. Markdown sources are pasted whole, so the limit is generous.
app.use(express.json({ limit: "10mb" }));

// --- Health check ---

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

// --- Routes ---

app.use("/api/conversations", conversationsRouter);
app.use("/api/realtime", realtimeRouter);
app.use("/api/sources", sourcesRouter);
app.use("/api/agents", agentsRouter);
app.use("/api/costs", costsRouter);
app.use("/api/credits", creditsRouter);
app.use("/api/browse", browseRouter);
app.use("/api/chat", chatRouter);

// --- 404 for unknown API routes (JSON, not Express' HTML default) ---

app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// --- Error handler (must be last) ---

app.use(errorHandler);

// --- Start ---

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});

export default app;
