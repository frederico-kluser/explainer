import "./load-env.js"; // must run before anything reads process.env

import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";

import express from "express";
import cors from "cors";
import { errorHandler } from "./middleware/error-handler.js";
import { accessKeyGate, loopbackOnly } from "./middleware/access-key.js";

import conversationsRouter from "./routes/conversations.js";
import memoryRouter from "./routes/memory.js";
import liveRouter from "./routes/live.js";
import realtimeRouter from "./routes/realtime.js";
import sourcesRouter from "./routes/sources.js";
import agentsRouter from "./routes/agents.js";
import costsRouter, { creditsRouter } from "./routes/costs.js";
import browseRouter from "./routes/browse.js";
import providerKeysRouter from "./routes/provider-keys.js";
import { createPairRouter } from "./routes/pair.js";
import { attachDeepThinkToMemory } from "./services/memory-recorder.js";
import { attachListenOutcome } from "./services/listen.js";

const app = express();
const PORT = Number(process.env.PORT) || 3001;

// The interface the backend listens on stays loopback, deliberately.
//
// The wifi story is served by the Vite dev server, which runs on the host and
// proxies `/api` here — a phone on the network reaches this process through
// that hop, so the socket itself never has to face the LAN. `EXPLAINER_HOST` is
// the opt-in for the case where something else serves the built frontend.
const HOST = process.env.EXPLAINER_HOST || "127.0.0.1";

// The key that guards every `/api` route. Generated when the environment has
// none, rather than defaulting to open: a host who never edited `.env` would
// otherwise publish their OpenAI spend, their `~/Projects` tree and an
// irreversible memory delete to everyone on the wifi, and find out later.
const configuredKey = process.env.EXPLAINER_ACCESS_KEY?.trim();
const ACCESS_KEY = configuredKey || randomBytes(16).toString("base64url");

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

// The access gate, before the body parsers on purpose: a request that cannot
// prove it was invited has no business getting a 25 mb JSON body read into
// memory first. `/api/health` and `/api/pair` answer in front of it, and so
// does anything that really started on this machine — the key guards the wifi,
// not the owner.
app.use("/api", accessKeyGate(ACCESS_KEY));

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

// --- Pairing (outside the gate: it is the door) ---

app.use("/api/pair", createPairRouter(ACCESS_KEY));

// --- Routes ---

app.use("/api/conversations", conversationsRouter);
// Same prefix: the memory of a conversation is addressed by the conversation.
// `/:id` in the router above never matches `/:id/memory`, so order is free.
app.use("/api/conversations", memoryRouter);
// And again, for the same reason: `/:id/live` and `/:id/floor` are addressed by
// the conversation. Behind `accessKeyGate` like everything else under `/api` —
// the live stream carries the whole transcript, so it is the last route that
// should be open, and `EventSource` sends the cookie on its own in same-origin,
// so nothing has to repeat the key in a query string where logs would keep it.
app.use("/api/conversations", liveRouter);
app.use("/api/realtime", realtimeRouter);
app.use("/api/sources", sourcesRouter);
app.use("/api/agents", agentsRouter);
app.use("/api/costs", costsRouter);
// Holding the key buys a conversation, not a look at the owner's wallet.
app.use("/api/credits", loopbackOnly, creditsRouter);
// Loopback for the same reason, one step stronger: this route ACCEPTS a
// credential. A guest on the house wifi holding the access key must not be able
// to plant an API key that the owner's next call then spends money on, and the
// owner of the machine already gets in without one.
app.use("/api/provider-keys", loopbackOnly, providerKeysRouter);
app.use("/api/browse", browseRouter);

// --- 404 for unknown API routes (JSON, not Express' HTML default) ---

app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// --- Error handler (must be last) ---

app.use(errorHandler);

// --- Start ---

/** First non-internal IPv4 address, so the printed link is the shareable one. */
function lanAddress(): string | null {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) return address.address;
    }
  }
  return null;
}

// No callback here on purpose: Express 5 would alias it onto the server's
// `error` event too, and the banner below would announce a backend that never
// bound. `attachListenOutcome` explains what that cost.
const server = app.listen(PORT, HOST);

attachListenOutcome(server, {
  port: PORT,
  host: HOST,
  onFailure: (message) => {
    console.error(message);
    process.exit(1);
  },
  onListening: () => {
    console.log(`Backend running on http://localhost:${PORT}`);

    // Two lines because there are two audiences, and conflating them is what
    // made the key look mandatory: here the app opens with nothing, and the
    // link is only for the device that is not this computer. Printing both
    // every boot is what makes "abra essa url" a complete instruction either
    // way.
    const uiPort = Number(process.env.EXPLAINER_PUBLIC_PORT) || 5173;
    const uiHost = lanAddress() ?? "localhost";
    console.log(
      configuredKey
        ? "[access] Usando a EXPLAINER_ACCESS_KEY do ambiente."
        : "[access] Nenhuma EXPLAINER_ACCESS_KEY definida — gerei uma só para esta execução.",
    );
    console.log(
      `[access] Neste computador não precisa de chave: http://localhost:${uiPort}`,
    );
    console.log(
      `[access] Para outro aparelho no wifi, compartilhe: http://${uiHost}:${uiPort}/?k=${ACCESS_KEY}`,
    );
  },
});

export default app;
