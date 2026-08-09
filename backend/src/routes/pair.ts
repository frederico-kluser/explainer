import { Router } from "express";

import {
  buildAccessCookie,
  matchesAccessKey,
  requestIsSecure,
} from "../middleware/access-key.js";

/**
 * POST /api/pair — trade the key from the shared link for the access cookie.
 *
 * The one route deliberately outside the gate: it is the door. The browser
 * calls it once, on the first load of a link carrying `?k=…`, and then strips
 * the key from the address bar — from that point the cookie travels on its own,
 * including on `EventSource`, which cannot send a header.
 *
 * The key is taken from the body and not the query string so it does not reach
 * the access log of anything sitting in front of this server.
 */
export function createPairRouter(expectedKey: string): Router {
  const router = Router();

  router.post("/", (req, res) => {
    const body: unknown = req.body;
    const presented =
      typeof body === "object" && body !== null && "key" in body
        ? (body as { key?: unknown }).key
        : undefined;

    if (typeof presented !== "string" || !matchesAccessKey(presented, expectedKey)) {
      res.status(401).json({
        error: "Chave de acesso inválida. Peça o link novamente a quem te convidou.",
      });
      return;
    }

    res.setHeader(
      "Set-Cookie",
      buildAccessCookie(expectedKey, { secure: requestIsSecure(req) }),
    );
    res.status(204).end();
  });

  return router;
}
