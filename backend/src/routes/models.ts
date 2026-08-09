import { Router } from "express";

// === GET /api/models — the model catalogue the roster picks from ===
//
// Stub. `onda2-model-catalog` fills it: multi-provider discovery, cached, with
// the year filter the operator asked for (2026+ by default) and a text search.
//
// It exists ahead of the implementation so that two sub-tasks of the same wave
// can register their routes in `index.ts` without both editing that file.

const router = Router();

export default router;
