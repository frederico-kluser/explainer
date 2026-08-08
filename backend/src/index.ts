import "./load-env.js"; // must run before anything reads process.env

import express from "express";
import cors from "cors";
import { errorHandler } from "./middleware/error-handler.js";

import conversationsRouter from "./routes/conversations.js";
import memoryRouter from "./routes/memory.js";
import realtimeRouter from "./routes/realtime.js";
import sourcesRouter from "./routes/sources.js";
import agentsRouter from "./routes/agents.js";
import costsRouter, { creditsRouter } from "./routes/costs.js";
import browseRouter from "./routes/browse.js";
import { attachDeepThinkToMemory } from "./services/memory-recorder.js";

const app = express();
const PORT = Number(process.env.PORT) || 3001;

// A deliberation round emits its synthesis on an event bus and then forgets it —
// `pruneJobs` empties the registry and a restart empties it for good. This is
// what turns each round into a `reflection` in the conversation file, which is
// the one kind of event pruning rescues ahead of ordinary turns. Idempotent, so
// a second call adds no second listener and no duplicated reflections.
attachDeepThinkToMemory();

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

// JSON body parsers, largest first.
//
// A memory file is the one big body this app accepts: 500 events at up to
// 16 000 characters each, plus the diagrams kept whole. Everything else — a
// pasted markdown source, a tool call, a page of messages — belongs in a much
// smaller envelope, and one global 25 mb limit handed that ceiling to every
// route, so four concurrent 16 mb posts to `/api/realtime/tool` cost 603 MB of
// RSS for no reason.
//
// The order is what makes this work, and it is the opposite of the intuitive
// one: `express.json()` skips a request whose `req._body` is already set, so the
// *first* parser to run is the one that decides the limit, and a second one
// mounted deeper is the no-op. Mounting the generous parser on the narrow path
// first therefore gives that path its own ceiling; the global parser below sees
// the body already read and steps aside.
app.use(
  "/api/conversations/:id/memory/import",
  express.json({ limit: "25mb" }),
);
app.use(express.json({ limit: "10mb" }));

// --- Health check ---

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

// --- Routes ---

app.use("/api/conversations", conversationsRouter);
// Same prefix: the memory of a conversation is addressed by the conversation.
// `/:id` in the router above never matches `/:id/memory`, so order is free.
app.use("/api/conversations", memoryRouter);
app.use("/api/realtime", realtimeRouter);
app.use("/api/sources", sourcesRouter);
app.use("/api/agents", agentsRouter);
app.use("/api/costs", costsRouter);
app.use("/api/credits", creditsRouter);
app.use("/api/browse", browseRouter);

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
