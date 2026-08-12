import { Router } from "express";

import { listModes, DEFAULT_MODE_ID } from "../modes/registry.js";
import { toModeSummary } from "../modes/types.js";

const router = Router();

// GET /api/modes
//
// The whole reason this route exists is that the browser must not carry a list
// of modes of its own. A mode added in `modes/registry.ts` shows up on the
// picker without a line changing in `frontend/`, which is the property the
// modularity of this feature actually rests on — a hard-coded copy in the UI
// would drift the first time somebody added the third mode.
router.get("/", (_req, res) => {
  res.json({
    modes: listModes().map(toModeSummary),
    default: DEFAULT_MODE_ID,
  });
});

export default router;
