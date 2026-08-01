import { Router, type Request, type Response } from "express";
import { createHash } from "node:crypto";

import {
  REALTIME_MODEL,
  mintRealtimeClientSecret,
  type RealtimeSessionConfig,
} from "../services/openai.js";
import { getSettings } from "../services/settings.js";
import { listSources } from "../services/source-store.js";
import { executeTool, ToolValidationError } from "../services/tool-executor.js";
import { toolsForSources } from "../tools/index.js";
import { buildInstructions } from "../prompts.js";
import { isUUID } from "../middleware/sandbox.js";

const router = Router();

// ---------------------------------------------------------------------------
// POST /api/realtime/session — mint an ephemeral client secret
// ---------------------------------------------------------------------------
//
// The browser opens its own WebRTC peer connection straight to OpenAI, so the
// media never touches this server. What it gets from us is a short-lived token
// bound to a session we configured: model, voice, instructions and tool list are
// all fixed here. A tampered browser can waste the session it was handed and
// nothing more.

router.post("/session", async (req: Request, res: Response) => {
  const { conversation_id } = req.body as { conversation_id?: string };

  if (!conversation_id || !isUUID(conversation_id)) {
    res.status(400).json({ error: "Invalid conversation_id" });
    return;
  }

  const sources = await listSources(conversation_id);
  if (sources.length === 0) {
    res.status(409).json({
      error:
        "Nenhum material adicionado. Adicione um repositorio, cole um markdown ou " +
        "inclua a documentacao do computador antes de conectar.",
    });
    return;
  }

  const settings = await getSettings(conversation_id);

  const session: RealtimeSessionConfig = {
    type: "realtime",
    model: REALTIME_MODEL,
    instructions: buildInstructions(sources),
    output_modalities: ["audio"],
    audio: {
      input: {
        // Turns end on meaning rather than on a fixed silence window — the
        // difference between an assistant that interrupts you mid-thought and
        // one that waits for you to finish it.
        turn_detection: { type: "semantic_vad" },
        transcription: { model: "gpt-live-transcribe" },
        noise_reduction: { type: "near_field" },
      },
      output: { voice: settings.voice, speed: settings.speed },
    },
    tools: toolsForSources(sources),
    tool_choice: "auto",
  };

  // A stable, non-reversible per-conversation identifier. The Realtime API binds
  // it to the token, so the browser never has to send one itself.
  const safetyIdentifier = createHash("sha256")
    .update(conversation_id)
    .digest("hex")
    .slice(0, 32);

  const secret = await mintRealtimeClientSecret(session, safetyIdentifier);

  res.json({
    value: secret.value,
    expires_at: secret.expires_at,
    model: REALTIME_MODEL,
    voice: settings.voice,
    speed: settings.speed,
    materials: sources.map((source) => ({
      id: source.id,
      kind: source.kind,
      label: source.label,
      origin: source.origin,
      primary_doc_path: source.primary_doc_path,
    })),
    tools: toolsForSources(sources).map((t) => t.name),
  });
});

// ---------------------------------------------------------------------------
// POST /api/realtime/tool — execute one function call for the browser
// ---------------------------------------------------------------------------
//
// The model emits function calls on the data channel; the browser relays them
// here, because this is where the filesystem, the subprocesses and the API keys
// live. The browser only carries the result back as a `function_call_output`.

router.post("/tool", async (req: Request, res: Response) => {
  const { conversation_id, call_id, name, arguments: rawArgs } = req.body as {
    conversation_id?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
  };

  if (!conversation_id || !isUUID(conversation_id)) {
    res.status(400).json({ error: "Invalid conversation_id" });
    return;
  }
  if (!name || typeof name !== "string") {
    res.status(400).json({ error: "Missing tool name" });
    return;
  }

  try {
    const outcome = await executeTool(
      name,
      typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs ?? {}),
      conversation_id,
    );
    res.json({ call_id, name, output: outcome.output, meta: outcome.meta ?? null });
  } catch (err) {
    // A bad tool call is the model's mistake to fix, not a 500: hand the message
    // back as the tool's output so it can correct itself on the next turn.
    if (err instanceof ToolValidationError) {
      res.json({ call_id, name, output: `Erro de argumentos: ${err.message}`, meta: null });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[realtime] Tool ${name} failed:`, message);
    res.json({ call_id, name, output: `A ferramenta falhou: ${message}`, meta: null });
  }
});

export default router;
