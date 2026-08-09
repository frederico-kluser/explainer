import { createHash, timingSafeEqual } from "node:crypto";
import type { Request, RequestHandler } from "express";

/**
 * The door in front of `/api`, who it is for, and the reason it is a cookie.
 *
 * The app is meant to be opened from another device on the wifi, so the whole
 * surface — minting an OpenAI client secret, running tools, deleting a memory
 * file — would otherwise be reachable by anyone on the network. The key travels
 * inside the shared link (`?k=…`), gets traded for a cookie once, and every
 * later request carries it without a call site having to remember.
 *
 * The door faces the wifi and only the wifi. A request that really started on
 * this machine passes with no key, because there is nothing for it to present:
 * a host who never set `EXPLAINER_ACCESS_KEY` gets a random one that lives in
 * the terminal and nowhere else, so gating loopback turned the owner's own
 * first request into a 401 on an app that had always just worked.
 * `originIsLoopback` below is what decides "really started on this machine",
 * and it is the delicate part.
 *
 * A cookie and not an `Authorization` header because `new EventSource(url)`
 * takes no headers: a bearer scheme would force the secret into the query
 * string of every SSE stream, where it lands in server logs and browser
 * history. A same-origin cookie is sent by `fetch` (default
 * `credentials: "same-origin"`) and by `EventSource` alike.
 */

/** Cookie the pairing route sets and the gate reads. */
export const ACCESS_COOKIE = "explainer_key";

/** Header alternative, for callers that are not a browser — curl, a script. */
export const ACCESS_HEADER = "x-explainer-key";

/** How long a paired device stays paired, in seconds. */
export const ACCESS_COOKIE_MAX_AGE = 30 * 24 * 60 * 60;

const UNAUTHORIZED_MESSAGE =
  "Acesso restrito. Abra o link completo que o dono desta máquina compartilhou — " +
  "a chave vai no final dele.";

const FORBIDDEN_MESSAGE = "Disponível apenas no computador que hospeda o app.";

/**
 * Paths that answer before the gate, named relative to the `/api` mount.
 *
 * `/health` so a liveness probe never needs the secret, and `/pair` because it
 * is the door itself — gating it would leave no way to present the key.
 */
const OPEN_PATHS = new Set(["/health", "/pair"]);

/**
 * Constant-time key comparison that cannot throw on a length mismatch.
 *
 * `timingSafeEqual` rejects buffers of different sizes with a TypeError, and
 * the length of the presented value is entirely attacker-chosen. Hashing both
 * sides first makes every comparison 32 bytes against 32 bytes, so the length
 * check disappears instead of becoming an early return that leaks.
 */
export function matchesAccessKey(presented: string, expected: string): boolean {
  if (expected.length === 0) return false;
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/**
 * One cookie out of a `Cookie` header.
 *
 * Hand-parsed rather than pulling in `cookie-parser`: it is a single header
 * with a single format, and this app carries no dependency it can write in ten
 * lines.
 */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      // A malformed escape ("%zz") is a malformed cookie, not a crash.
      return raw;
    }
  }
  return null;
}

/** `Set-Cookie` value for a freshly paired device. */
export function buildAccessCookie(
  value: string,
  options: { secure: boolean },
): string {
  const attributes = [
    `${ACCESS_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${ACCESS_COOKIE_MAX_AGE}`,
    "HttpOnly",
    // Lax and not Strict: the shared link is usually opened from a chat app, and
    // Strict would withhold the cookie on that first cross-site navigation.
    "SameSite=Lax",
  ];
  if (options.secure) attributes.push("Secure");
  return attributes.join("; ");
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  // Node reports IPv4 peers on a dual-stack socket as "::ffff:127.0.0.1".
  const plain = address.startsWith("::ffff:") ? address.slice(7) : address;
  return plain === "::1" || plain === "127.0.0.1" || plain.startsWith("127.");
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  const single = Array.isArray(value) ? value[0] : value;
  return single?.split(",")[0]?.trim();
}

/**
 * Every hop of a comma-appended forwarded header, in order.
 *
 * Express hands the header back as an array when it arrived more than once, and
 * each of those values can itself carry a whole chain.
 */
function forwardedValues(value: string | string[] | undefined): string[] {
  const raw = value === undefined ? [] : Array.isArray(value) ? value : [value];
  return raw
    .flatMap((entry) => entry.split(","))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Whether the request really started on this machine.
 *
 * Under the default topology the owner and a guest are the same socket. What
 * faces the wifi is the Vite dev server; it runs on the host and proxies `/api`
 * to `127.0.0.1:3001`, so a phone's request and the owner's request both arrive
 * here from loopback and nothing at the socket level tells them apart. The
 * `xfwd: true` on that proxy — `frontend/vite.config.ts` — is what restores the
 * distinction: it sends `X-Forwarded-For` carrying the address that opened the
 * connection to *Vite*.
 *
 * `X-Forwarded-For` is an ordinary request header, so a client writes whatever
 * it likes in it. Two rules are what make reading it safe, and neither is
 * decoration:
 *
 *  - The immediate TCP peer must be loopback. `app.listen(PORT, "127.0.0.1")`
 *    makes that true for the proxy and impossible for a LAN client dialling
 *    this port directly, so a forgery from off-machine is never consulted at
 *    all — the socket outranks the header.
 *  - Every hop in the chain must be loopback, not just the first. `xfwd`
 *    *appends*: http-proxy's `XHeaders`, which vite bundles, joins the value
 *    the client already sent to the real peer with a comma rather than
 *    replacing it. A phone sending `X-Forwarded-For: 127.0.0.1` therefore
 *    reaches this function as `127.0.0.1,192.168.1.50`, and believing the first
 *    hop would hand that phone the entire surface. Reading the whole chain
 *    makes the forged prefix inert and fails closed on any shape this app did
 *    not produce.
 *
 * One consequence worth knowing before it surprises someone: opening the app at
 * the machine's own LAN address instead of `localhost` counts as a guest and
 * needs the key, because at that point it is genuinely indistinguishable from
 * one.
 */
export function originIsLoopback(req: Request): boolean {
  if (!isLoopbackAddress(req.socket.remoteAddress)) return false;
  // An absent header yields an empty chain, and `every` calls that loopback —
  // which is right: no proxy in front means the peer already is the origin.
  return forwardedValues(req.headers["x-forwarded-for"]).every(isLoopbackAddress);
}

/**
 * Whether the browser reached us over TLS.
 *
 * `Secure` is not set unconditionally because a dev session on
 * `http://localhost` would have the browser drop the cookie on arrival,
 * breaking pairing exactly where it is used most. When a TLS terminator sits in
 * front (the Vite dev server, a local reverse proxy) the backend only ever sees
 * a plain loopback connection, so its `X-Forwarded-Proto` is the only evidence
 * left — worth believing precisely because the peer is loopback, which under
 * the default bind no LAN client can be.
 */
export function requestIsSecure(req: Request): boolean {
  if (req.secure) return true;
  if (!isLoopbackAddress(req.socket.remoteAddress)) return false;
  // The last hop, for the reason `originIsLoopback` reads the whole chain:
  // `xfwd` appends, so every position but the final one belongs to the client.
  // Believing a forged "https" would put `Secure` on the cookie of a plain-http
  // session, and the browser drops such a cookie on arrival — pairing would
  // fail with nothing to see.
  return forwardedValues(req.headers["x-forwarded-proto"]).at(-1) === "https";
}

function requestPath(req: Request): string {
  // Mounted as `app.use("/api", …)`, Express strips the prefix from `req.url`,
  // so `req.path` is "/health". Both spellings are accepted so the exemption
  // does not silently depend on where the gate happens to be mounted.
  const path = req.path.replace(/\/+$/, "") || "/";
  return path.startsWith("/api/") ? path.slice(4) : path;
}

/**
 * Refuse anything under `/api` that does not present the key.
 *
 * Mount it before the body parsers: an unauthenticated request has no business
 * getting a 25 mb JSON body read into memory first.
 */
export function accessKeyGate(expectedKey: string): RequestHandler {
  return (req, res, next) => {
    // A CORS preflight carries no cookies by construction and reveals nothing;
    // gating it would only break the cross-origin case it exists to enable.
    if (req.method === "OPTIONS") {
      next();
      return;
    }

    if (OPEN_PATHS.has(requestPath(req))) {
      next();
      return;
    }

    // The owner of the machine is not a guest, and has no key to offer.
    if (originIsLoopback(req)) {
      next();
      return;
    }

    const presented =
      firstHeaderValue(req.headers[ACCESS_HEADER]) ??
      readCookie(req.headers.cookie, ACCESS_COOKIE) ??
      "";

    if (!matchesAccessKey(presented, expectedKey)) {
      res.status(401).json({ error: UNAUTHORIZED_MESSAGE });
      return;
    }

    next();
  };
}

/**
 * Hide a route from anyone who is not on the host itself.
 *
 * Used for `/api/credits`: the provider balances belong to whoever owns the
 * machine, and a guest invited to talk to a repository has no reason to read
 * them. Both ends of the socket are checked, because the interesting case is
 * the opt-in `EXPLAINER_HOST` bind — there the connection lands on a LAN
 * address and `localAddress` is what says so.
 *
 * The forwarded chain is what separates the visitor from the host under the
 * default topology, on the terms `originIsLoopback` sets out. This stays a hide
 * rather than a boundary because it depends on the proxy setting that header:
 * put something else in front of `/api` without `xfwd` and every guest reads as
 * local here, with the access key the only thing left in the way.
 */
export const loopbackOnly: RequestHandler = (req, res, next) => {
  if (!isLoopbackAddress(req.socket.localAddress) || !originIsLoopback(req)) {
    res.status(403).json({ error: FORBIDDEN_MESSAGE });
    return;
  }

  next();
};
