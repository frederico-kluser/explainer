import { Router } from "express";

import { addCost, getCosts } from "../services/costs.js";
import { getCredits } from "../services/credits.js";
import { priceRealtimeResponse, type RealtimeUsage } from "../services/pricing.js";
import { REALTIME_MODEL } from "../services/openai.js";
import { isUUID } from "../middleware/sandbox.js";

const router = Router();

// ---------------------------------------------------------------------------
// POST /api/costs/realtime — the browser reports what a response cost
// ---------------------------------------------------------------------------
//
// The realtime `usage` object only exists on the data channel, which only the
// browser holds. It reports the raw token counts and the *server* prices them:
// a client that lies about its usage would only be lying to itself, and the
// rate card stays in one place.

router.post("/realtime", async (req, res) => {
  const { conversation_id, usage, model } = req.body as {
    conversation_id?: string;
    usage?: RealtimeUsage;
    model?: string;
  };

  if (!conversation_id || !isUUID(conversation_id)) {
    res.status(400).json({ error: "Invalid conversation_id" });
    return;
  }
  if (!usage || typeof usage !== "object") {
    res.status(400).json({ error: "Missing usage" });
    return;
  }

  const priced = priceRealtimeResponse(model || REALTIME_MODEL, usage);

  await addCost(conversation_id, {
    source: "realtime",
    usd: priced.usd,
    tokens: {
      input: priced.input_tokens,
      output: priced.output_tokens,
      audio: priced.audio_tokens,
      cached: priced.cached_tokens,
    },
  });

  res.json({ usd: priced.usd, tokens: priced });
});

// GET /api/costs/:convId — what this conversation has cost so far
router.get("/:convId", async (req, res) => {
  const convId = req.params.convId!;
  if (!isUUID(convId)) {
    res.status(400).json({ error: "Invalid conversation_id" });
    return;
  }
  res.json(await getCosts(convId));
});

export default router;

// ---------------------------------------------------------------------------
// GET /api/credits — how much is left at each provider
// ---------------------------------------------------------------------------

export const creditsRouter = Router();

creditsRouter.get("/", async (_req, res) => {
  res.json({ providers: await getCredits() });
});
