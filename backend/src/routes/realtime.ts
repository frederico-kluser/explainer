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
import { buildResume, readMemory, setMemoryMeta } from "../services/memory.js";
import { recordToolExchange } from "../services/memory-recorder.js";
import { getConversation } from "../services/storage.js";
import type { MemoryFile, MemoryResume } from "../types/deep-tools.js";
import type { ResolvedSource } from "../types/index.js";

const router = Router();

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * How long the mint may wait for the summariser, in ms.
 *
 * Read at call time; `EXPLAINER_MEMORY_SUMMARY_TIMEOUT_MS` overrides it. Values
 * under the floor are ignored rather than honoured — a budget too short to ever
 * be met is the same as switching the summary off, and
 * `EXPLAINER_MEMORY_LLM_SUMMARY=0` already says that out loud.
 */
const RESUME_SUMMARY_BUDGET_MS = 4_000;
const RESUME_SUMMARY_BUDGET_FLOOR_MS = 250;

function resumeSummaryBudgetMs(): number {
  const raw = Number(process.env.EXPLAINER_MEMORY_SUMMARY_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= RESUME_SUMMARY_BUDGET_FLOOR_MS
    ? Math.floor(raw)
    : RESUME_SUMMARY_BUDGET_MS;
}

/**
 * The conversation file, or null — read once, for everything below that needs
 * to know whether this conversation has a past.
 *
 * Never fatal: a session that cannot read its own past still opens. Losing the
 * memory costs continuity; refusing to mint costs the call.
 */
async function storedMemory(conversationId: string): Promise<MemoryFile | null> {
  try {
    return await readMemory(conversationId);
  } catch (err) {
    console.warn(
      `[realtime] ${conversationId}: could not read the memory file:`,
      message(err),
    );
    return null;
  }
}

/**
 * The compressed form of a previous session, or null when there is nothing to
 * resume.
 *
 * Three costs are being managed here, and they are why this is not a bare
 * `buildResume(conversationId)` call:
 *
 *   - Time. This is the last thing between the user pressing "Conectar" and the
 *     WebRTC session starting, and `completeText` defaults to a 30 s timeout
 *     with no retry — so a slow OpenAI used to hang the button for half a minute
 *     on every connect to a conversation with memory. The budget cuts that to a
 *     few seconds and falls back to `buildResume`'s deterministic summary, which
 *     is already built by then and costs nothing.
 *   - Money. `buildResume` pays the summariser to compress the file, and this
 *     route runs again on every reconnect — the session is capped at 60 minutes
 *     and the token at 10, so a long conversation mints several times. The
 *     summariser is only asked when there is something to summarise.
 *     `EXPLAINER_MEMORY_LLM_SUMMARY=0` removes the call entirely.
 *   - A second read of the file, avoided by handing over the one already made.
 */
async function resumeFor(file: MemoryFile): Promise<MemoryResume | null> {
  if (file.events.length === 0) return null;

  try {
    return await buildResume(file.conversation_id, {
      file,
      summaryBudgetMs: resumeSummaryBudgetMs(),
    });
  } catch (err) {
    console.warn(
      `[realtime] ${file.conversation_id}: could not build the memory resume:`,
      message(err),
    );
    return null;
  }
}

/**
 * Stamp the conversation file with what this session is about.
 *
 * This is the only place both halves are known at once — the title lives in
 * `storage.ts` and the material labels are resolved here — and it is what makes
 * an exported file identifiable as something other than "Conversa sem título".
 * Best effort, and deliberately not awaited: a session mint must not wait on,
 * or fail because of, a write to the archive.
 *
 * Called only when a memory file already exists. `setMemoryMeta` goes through
 * `mutate`, which *creates* the file — so stamping unconditionally gave every
 * conversation that ever opened a session a memory file on disk, title and
 * materials and no events, for a call in which nobody said anything. The
 * recorders create the file when there is something to record; this only
 * labels it.
 */
async function rememberMeta(
  conversationId: string,
  sources: ResolvedSource[],
): Promise<void> {
  try {
    const conversation = await getConversation(conversationId);
    await setMemoryMeta(conversationId, {
      ...(conversation ? { title: conversation.title } : {}),
      materials: sources.map((source) => source.label),
    });
  } catch (err) {
    console.warn(
      `[realtime] ${conversationId}: could not stamp the memory file:`,
      message(err),
    );
  }
}

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
  const stored = await storedMemory(conversation_id);
  const resume = stored ? await resumeFor(stored) : null;
  if (stored) void rememberMeta(conversation_id, sources);

  // Computed once and used three times. The instructions describe the tools the
  // session actually holds — `deep_think` and `check_deep_think` come and go
  // with `BRAVE_API_KEY` — and a Tools section written from anything but this
  // list would teach the model behaviour for a tool it was never given.
  const tools = toolsForSources(sources);
  const toolNames = tools.map((tool) => tool.name);

  const session: RealtimeSessionConfig = {
    type: "realtime",
    model: REALTIME_MODEL,
    instructions: buildInstructions(sources, resume, toolNames),
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
    tools,
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
    tools: toolNames,
    // So the UI can say the conversation was picked up rather than started. The
    // resume itself stays server-side: it is in the instructions, which the
    // browser is never shown.
    resumed: resume !== null,
    memory_events: resume?.event_count ?? 0,
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

  const args = typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs ?? {});

  // Every tool the model calls passes through here, so this is the one place
  // that can archive them all. What is recorded is exactly what the model saw —
  // the arguments as they arrived and the output as it goes back, failures
  // included, since "a ferramenta falhou" is part of what a resumed session has
  // to know. Nothing is shortened on the way in: the ceilings live in
  // `memory.ts` (2 000 arguments / 8 000 output) and clipping here would lower
  // them for `buildResume` without saying so.
  //
  // `void` rather than `await`: no function in the recorder rejects, and a disk
  // write does not belong in the latency of a spoken turn.

  try {
    const outcome = await executeTool(name, args, conversation_id);
    void recordToolExchange(conversation_id, name, args, outcome.output);
    res.json({ call_id, name, output: outcome.output, meta: outcome.meta ?? null });
  } catch (err) {
    // A bad tool call is the model's mistake to fix, not a 500: hand the message
    // back as the tool's output so it can correct itself on the next turn.
    const output =
      err instanceof ToolValidationError
        ? `Erro de argumentos: ${err.message}`
        : `A ferramenta falhou: ${message(err)}`;

    if (!(err instanceof ToolValidationError)) {
      console.error(`[realtime] Tool ${name} failed:`, message(err));
    }

    void recordToolExchange(conversation_id, name, args, output);
    res.json({ call_id, name, output, meta: null });
  }
});

export default router;
