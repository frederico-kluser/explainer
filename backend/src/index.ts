import express from "express";
import cors from "cors";
import { errorHandler } from "./middleware/error-handler.js";

const app = express();
const PORT = process.env.PORT || 3001;

// --- Middleware ---

// CORS: allow the Vite dev server
app.use(
  cors({
    origin: "http://localhost:5173",
  })
);

// JSON body parser with 10 MB limit (room for base64-encoded audio)
app.use(express.json({ limit: "10mb" }));

// --- Health check ---

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

// --- Routes ---
import conversationsRouter from "./routes/conversations.js";
// Placeholders — route modules will be created in later cards (F1-05, F4-02, F4-03, F6-01)
//
// import sttRouter        from "./routes/stt.js";
// import chatRouter       from "./routes/chat.js";
// import ttsRouter        from "./routes/tts.js";
// import filesRouter      from "./routes/files.js";

app.use("/api/conversations", conversationsRouter);
// app.use("/api/stt",            sttRouter);
// app.use("/api/chat",           chatRouter);
// app.use("/api/tts",            ttsRouter);
// app.use("/api/files",          filesRouter);

// --- Error handler (must be last) ---

app.use(errorHandler);

// --- Start ---

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});

export default app;
