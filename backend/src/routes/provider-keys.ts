import { Router } from "express";

import {
  PROVIDERS,
  clearProviderKey,
  isProvider,
  providerKeyStatus,
  setProviderKey,
} from "../services/providers/keys.js";

const router = Router();

// ---------------------------------------------------------------------------
// /api/provider-keys — which providers can be called, and taking the ones that
// cannot from the user without a restart
// ---------------------------------------------------------------------------
//
// A key reaches this process two ways: exported in the environment before boot,
// or typed here afterwards. Until this router existed only the first one worked,
// so a user who opened the app without `OPENROUTER_API_KEY` in their shell had
// no way in short of quitting, editing a file and starting over.
//
// Nothing here ever answers with a key. `providerKeyStatus` builds the whole
// response inside the module that owns the secret, precisely so that the file
// deciding what is publishable is the same file holding the thing that is not.

/** English, unlike the rest of the messages: only a buggy caller can see it. */
const UNKNOWN_PROVIDER = `Unknown provider. Expected one of: ${PROVIDERS.join(", ")}.`;

// GET /api/provider-keys — the state of all three, for the setup screen
router.get("/", (_req, res) => {
  res.json({ providers: PROVIDERS.map((provider) => providerKeyStatus(provider)) });
});

// PUT /api/provider-keys/:provider — the user typed a key; use it from now on
router.put("/:provider", (req, res, next) => {
  const provider = req.params.provider;
  if (!isProvider(provider)) {
    res.status(400).json({ error: UNKNOWN_PROVIDER });
    return;
  }

  // Anything that is not a string becomes the empty string, so a `{"key": 42}`
  // gets the same "cole a chave" 400 as an empty field instead of a 500.
  const body = req.body as { key?: unknown } | undefined;
  const key = typeof body?.key === "string" ? body.key : "";

  try {
    setProviderKey(provider, key);
  } catch (err) {
    // Handed to `errorHandler` rather than mapped here: it is the one place that
    // redacts a >= 500 message, and a rejection about a credential is the last
    // error whose text should reach the client by accident.
    next(err);
    return;
  }

  res.json(providerKeyStatus(provider));
});

// DELETE /api/provider-keys/:provider — forget what was typed this session
router.delete("/:provider", (req, res) => {
  const provider = req.params.provider;
  if (!isProvider(provider)) {
    res.status(400).json({ error: UNKNOWN_PROVIDER });
    return;
  }

  clearProviderKey(provider);

  // The state after the clear, not an empty envelope: an environment variable
  // underneath the runtime key survives it, and the UI has to see that.
  res.json(providerKeyStatus(provider));
});

export default router;
