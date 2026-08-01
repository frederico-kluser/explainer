import { Router, type Request, type Response } from "express";

import { cancelJob, getJob, listJobs, subscribe } from "../services/agent-jobs.js";
import { isUUID } from "../middleware/sandbox.js";

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/agents/events?conversation_id=… — one SSE stream per conversation
// ---------------------------------------------------------------------------
//
// The browser opens this alongside the realtime session. When a dispatched agent
// finishes, the result arrives here and the browser injects it into the live
// conversation, so the model can speak an answer it asked for a minute ago
// without ever having blocked on it.

router.get("/events", (req: Request, res: Response) => {
  const conversationId = String(req.query.conversation_id ?? "");
  if (!isUUID(conversationId)) {
    res.status(400).json({ error: "Invalid conversation_id" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  // Nginx and friends buffer SSE into uselessness without this.
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const send = (data: object) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Replay whatever already finished — a job can complete between the tool call
  // and the moment this stream opens.
  //
  // `replay: true` matters: the client speaks fresh results out loud, and a
  // reconnect must not make it narrate an answer from an hour ago all over
  // again. Replays repopulate the UI and stay silent.
  for (const job of listJobs(conversationId)) {
    if (job.status === "done") {
      send({ type: "done", job_id: job.id, result: job.result ?? "", replay: true });
    } else if (job.status === "error" || job.status === "cancelled") {
      send({
        type: "error",
        job_id: job.id,
        error: job.error ?? "Falhou.",
        replay: true,
      });
    }
  }

  const unsubscribe = subscribe((event) => {
    const job = getJob(event.job_id);
    if (!job || job.conversation_id !== conversationId) return;
    send(event);
  });

  // Proxies drop idle connections; a comment line every 25s keeps this one warm.
  const keepAlive = setInterval(() => {
    if (!res.writableEnded) res.write(": keep-alive\n\n");
  }, 25_000);

  req.on("close", () => {
    clearInterval(keepAlive);
    unsubscribe();
    if (!res.writableEnded) res.end();
  });
});

// GET /api/agents?conversation_id=… — the jobs of one conversation
router.get("/", (req: Request, res: Response) => {
  const conversationId = String(req.query.conversation_id ?? "");
  if (!isUUID(conversationId)) {
    res.status(400).json({ error: "Invalid conversation_id" });
    return;
  }
  res.json(listJobs(conversationId));
});

// GET /api/agents/:jobId
router.get("/:jobId", (req, res) => {
  const job = getJob(req.params.jobId!);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  res.json(job);
});

// POST /api/agents/:jobId/cancel
router.post("/:jobId/cancel", (req, res) => {
  const job = getJob(req.params.jobId!);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  const cancelled = cancelJob(job.id);
  res.json({ cancelled, job: getJob(job.id) });
});

export default router;
