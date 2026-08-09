import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { Request as ExpressRequest, Response as ExpressResponse } from "express";

// sandbox.ts freezes its homedir()-derived roots at module load, so HOME moves
// before the first import — the technique storage.test.ts uses, and what keeps
// the real conversation store out of this suite.
const tmpHome = mkdtempSync(join(tmpdir(), "explainer-access-key-"));
process.env.HOME = tmpHome;

const express = (await import("express")).default;
const {
  ACCESS_COOKIE,
  ACCESS_COOKIE_MAX_AGE,
  accessKeyGate,
  buildAccessCookie,
  loopbackOnly,
  matchesAccessKey,
  originIsLoopback,
  readCookie,
  requestIsSecure,
} = await import("../middleware/access-key.js");
const { createPairRouter } = await import("../routes/pair.js");
const conversationsRouter = (await import("../routes/conversations.js")).default;
const { errorHandler } = await import("../middleware/error-handler.js");

const KEY = "chave-de-teste-abcdef";

// index.ts's wiring, in its order: the gate ahead of the body parsers, the two
// exempt routes, then a *real* protected router. `/api/conversations` is the
// route that hands out every conversation uuid, so it is the one worth proving
// the gate actually closes.
const app = express();
app.use("/api", accessKeyGate(KEY));
app.use(express.json({ limit: "10mb" }));
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});
app.use("/api/pair", createPairRouter(KEY));
app.use("/api/conversations", conversationsRouter);
app.use("/api/credits", loopbackOnly, (_req, res) => {
  res.json({ providers: [] });
});
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not found" });
});
app.use(errorHandler);

// `listen(0)` and not `listen(0, "127.0.0.1")`: passing a host defers the bind
// past this line and `address()` is still null. Connections below are made to
// 127.0.0.1 either way, which is what the loopback cases need.
const server: Server = app.listen(0);
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;

afterAll(() => {
  server.close();
  rmSync(tmpHome, { recursive: true, force: true });
});

function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${path}`, { headers });
}

/**
 * A guest, as the Vite proxy reports one.
 *
 * Every connection this suite makes is loopback, which is now exactly the case
 * that passes without a key — so a test about the gate closing has to arrive
 * the way a phone does: through the proxy, carrying the `X-Forwarded-For` that
 * `xfwd: true` adds.
 */
const LAN = { "X-Forwarded-For": "192.168.1.77" };

function getFromLan(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return get(path, { ...LAN, ...headers });
}

function pair(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}/api/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function errorOf(response: Response): Promise<string> {
  return ((await response.json()) as { error?: string }).error ?? "";
}

/** A fake request, for the branches a loopback test server cannot produce. */
function fakeRequest(init: {
  secure?: boolean;
  localAddress?: string;
  remoteAddress?: string;
  headers?: Record<string, string>;
}): ExpressRequest {
  return {
    secure: init.secure ?? false,
    socket: {
      localAddress: init.localAddress ?? "127.0.0.1",
      remoteAddress: init.remoteAddress ?? "127.0.0.1",
    },
    headers: init.headers ?? {},
  } as unknown as ExpressRequest;
}

/** Captures the status a middleware refuses with, or the fact that it passed. */
function runMiddleware(req: ExpressRequest): { status: number; nexted: boolean } {
  const outcome = { status: 0, nexted: false };
  const res = {
    status(code: number) {
      outcome.status = code;
      return this;
    },
    json() {
      return this;
    },
  } as unknown as ExpressResponse;

  loopbackOnly(req, res, () => {
    outcome.nexted = true;
  });

  return outcome;
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

describe("accessKeyGate", () => {
  // The regression the loopback exemption exists to end. The gate was written
  // for the wifi and shut the door on the person holding the house: opening the
  // app on the machine that runs it answered 401 to every call, with no key to
  // present, because a generated one never leaves the terminal.
  it("lets the machine's own owner through with no key at all", async () => {
    const response = await get("/api/conversations");

    expect(response.status).toBe(200);
    expect(Array.isArray(await response.json())).toBe(true);
  });

  it("answers 401, in Portuguese, when a guest presents no key", async () => {
    const response = await getFromLan("/api/conversations");

    expect(response.status).toBe(401);
    expect(await errorOf(response)).toMatch(/Acesso restrito/);
  });

  it("lets a guest through when the cookie carries the key", async () => {
    const response = await getFromLan("/api/conversations", {
      Cookie: `${ACCESS_COOKIE}=${encodeURIComponent(KEY)}`,
    });

    expect(response.status).toBe(200);
    expect(Array.isArray(await response.json())).toBe(true);
  });

  it("lets a guest through when the X-Explainer-Key header carries the key", async () => {
    const response = await getFromLan("/api/conversations", { "X-Explainer-Key": KEY });

    expect(response.status).toBe(200);
  });

  it("finds its cookie among the others the browser sends", async () => {
    const response = await getFromLan("/api/conversations", {
      Cookie: `theme=dark; ${ACCESS_COOKIE}=${encodeURIComponent(KEY)}; lang=pt-BR`,
    });

    expect(response.status).toBe(200);
  });

  it("answers 401 for a wrong key of the same length", async () => {
    const wrong = `${KEY.slice(0, -1)}X`;
    expect(wrong).toHaveLength(KEY.length);

    expect((await getFromLan("/api/conversations", { "X-Explainer-Key": wrong })).status).toBe(
      401,
    );
  });

  // timingSafeEqual throws a TypeError on buffers of different sizes, and the
  // length is entirely attacker-chosen — a 500 here would mean the comparison
  // was reached before both sides were hashed to a fixed width.
  it("answers 401 for keys of a different length, without throwing", async () => {
    for (const wrong of ["", "x", KEY.repeat(3)]) {
      expect((await getFromLan("/api/conversations", { "X-Explainer-Key": wrong })).status).toBe(
        401,
      );
    }
  });

  it("gates an unknown /api route too, so 404s do not map the surface", async () => {
    expect((await getFromLan("/api/does-not-exist")).status).toBe(401);
    expect((await getFromLan("/api/does-not-exist", { "X-Explainer-Key": KEY })).status).toBe(404);

    // The owner gets the honest answer, since nothing was hidden from them.
    expect((await get("/api/does-not-exist")).status).toBe(404);
  });

  it("leaves /api/health outside the gate", async () => {
    const response = await getFromLan("/api/health");

    expect(response.status).toBe(200);
    expect(((await response.json()) as { status: string }).status).toBe("ok");
  });

  it("leaves /api/pair outside the gate — it is the door", async () => {
    expect((await pair({ key: KEY }, LAN)).status).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// The forged origin — why the whole forwarded chain is read, not its head
// ---------------------------------------------------------------------------

describe("a forged X-Forwarded-For", () => {
  // What a phone actually produces when it sends `X-Forwarded-For: 127.0.0.1`:
  // xfwd appends the real peer instead of replacing the header, so the lie
  // survives in front of the truth. A gate that believed the first hop would
  // hand this request every conversation, every memory and the OpenAI account.
  it("does not open the gate when the proxy appended the real address behind it", async () => {
    const response = await get("/api/conversations", {
      "X-Forwarded-For": "127.0.0.1, 192.168.1.50",
    });

    expect(response.status).toBe(401);
    expect(await errorOf(response)).toMatch(/Acesso restrito/);
  });

  it("does not open the gate for a longer invented chain either", async () => {
    const response = await get("/api/conversations", {
      "X-Forwarded-For": "127.0.0.1, ::1, 10.0.0.9, 192.168.1.50",
    });

    expect(response.status).toBe(401);
  });

  it("still admits that chain when the guest does carry the key", async () => {
    const response = await get("/api/conversations", {
      "X-Forwarded-For": "127.0.0.1, 192.168.1.50",
      "X-Explainer-Key": KEY,
    });

    expect(response.status).toBe(200);
  });

  // A LAN client dialling port 3001 straight, which only exists under the
  // EXPLAINER_HOST opt-in: the header is pure invention and the socket is the
  // only witness left. A server bound to 127.0.0.1 cannot produce that peer,
  // so the predicate is exercised on its own.
  it("is not consulted at all when the peer itself is not loopback", () => {
    expect(
      originIsLoopback(
        fakeRequest({
          remoteAddress: "192.168.1.50",
          headers: { "x-forwarded-for": "127.0.0.1" },
        }),
      ),
    ).toBe(false);
  });

  it("accepts the chains the proxy really produces for the owner", () => {
    for (const chain of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "127.0.0.1, ::1"]) {
      expect(originIsLoopback(fakeRequest({ headers: { "x-forwarded-for": chain } }))).toBe(true);
    }

    // No proxy in front at all: the peer is already the origin.
    expect(originIsLoopback(fakeRequest({}))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /api/pair
// ---------------------------------------------------------------------------

describe("POST /api/pair", () => {
  it("sets a HttpOnly, Lax, root-scoped cookie that lasts 30 days", async () => {
    const cookie = (await pair({ key: KEY })).headers.get("set-cookie") ?? "";

    expect(cookie).toContain(`${ACCESS_COOKIE}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain(`Max-Age=${ACCESS_COOKIE_MAX_AGE}`);
    expect(ACCESS_COOKIE_MAX_AGE).toBe(30 * 24 * 60 * 60);
  });

  // The whole feature in one case: a device that only ever had the link ends up
  // reading the conversation list, and the same device without it does not.
  it("issues a cookie that opens the gate", async () => {
    expect((await getFromLan("/api/conversations")).status).toBe(401);

    const setCookie = (await pair({ key: KEY }, LAN)).headers.get("set-cookie") ?? "";
    const jar = setCookie.split(";")[0]!;

    expect((await getFromLan("/api/conversations", { Cookie: jar })).status).toBe(200);
  });

  it("refuses a wrong key with 401 and no cookie", async () => {
    const response = await pair({ key: "nao-e-a-chave" });

    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await errorOf(response)).toMatch(/Chave de acesso inválida/);
  });

  it("refuses a body that carries no usable key", async () => {
    expect((await pair({})).status).toBe(401);
    expect((await pair({ key: 42 })).status).toBe(401);

    // A bare `null` never reaches the handler: `express.json` is strict and
    // rejects a non-object top level with 400. Still not a cookie.
    expect((await pair(null)).status).toBe(400);
  });

  // Secure over plain http has the browser drop the cookie on arrival, which is
  // exactly the dev-on-localhost case.
  it("omits Secure when the request did not arrive over TLS", async () => {
    expect((await pair({ key: KEY })).headers.get("set-cookie") ?? "").not.toContain("Secure");
  });

  it("adds Secure when a loopback terminator reports https", async () => {
    const response = await pair({ key: KEY }, { "X-Forwarded-Proto": "https" });

    expect(response.headers.get("set-cookie") ?? "").toContain("Secure");
  });
});

// ---------------------------------------------------------------------------
// The pieces
// ---------------------------------------------------------------------------

describe("matchesAccessKey", () => {
  it("accepts an exact match and rejects everything else", () => {
    expect(matchesAccessKey(KEY, KEY)).toBe(true);
    expect(matchesAccessKey("outra", KEY)).toBe(false);
    expect(matchesAccessKey(`${KEY} `, KEY)).toBe(false);
  });

  it("never throws on a length mismatch, in either direction", () => {
    expect(() => matchesAccessKey("", KEY)).not.toThrow();
    expect(matchesAccessKey("", KEY)).toBe(false);
    expect(matchesAccessKey(KEY.repeat(4), KEY)).toBe(false);
    expect(matchesAccessKey(KEY, "x")).toBe(false);
  });

  // An unset key must never read as "an empty cookie is welcome".
  it("refuses everything when the expected key is empty", () => {
    expect(matchesAccessKey("", "")).toBe(false);
    expect(matchesAccessKey("qualquer", "")).toBe(false);
  });
});

describe("readCookie", () => {
  it("reads a value, decoded, from among the rest", () => {
    expect(readCookie("a=1; explainer_key=ab%20cd; b=2", ACCESS_COOKIE)).toBe("ab cd");
  });

  it("returns null when the header is missing or holds no such cookie", () => {
    expect(readCookie(undefined, ACCESS_COOKIE)).toBeNull();
    expect(readCookie("a=1; b=2", ACCESS_COOKIE)).toBeNull();
    expect(readCookie("explainer_key_other=1", ACCESS_COOKIE)).toBeNull();
  });

  it("hands back a malformed escape instead of throwing", () => {
    expect(readCookie("explainer_key=%zz", ACCESS_COOKIE)).toBe("%zz");
  });
});

describe("buildAccessCookie", () => {
  it("appends Secure only when asked", () => {
    expect(buildAccessCookie("k", { secure: true })).toContain("; Secure");
    expect(buildAccessCookie("k", { secure: false })).not.toContain("Secure");
  });
});

describe("requestIsSecure", () => {
  it("believes a TLS socket", () => {
    expect(requestIsSecure(fakeRequest({ secure: true }))).toBe(true);
  });

  it("believes X-Forwarded-Proto only from a loopback peer", () => {
    const headers = { "x-forwarded-proto": "https" };

    expect(requestIsSecure(fakeRequest({ headers }))).toBe(true);
    expect(requestIsSecure(fakeRequest({ headers, remoteAddress: "::ffff:127.0.0.1" }))).toBe(
      true,
    );
    expect(requestIsSecure(fakeRequest({ headers, remoteAddress: "192.168.1.77" }))).toBe(false);
  });

  it("is false for a plain loopback request", () => {
    expect(requestIsSecure(fakeRequest({}))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// loopbackOnly — the provider balances are the host's business
// ---------------------------------------------------------------------------

describe("loopbackOnly", () => {
  it("allows a request from the machine itself", async () => {
    expect((await get("/api/credits", { "X-Explainer-Key": KEY })).status).toBe(200);
  });

  it("refuses a request a proxy says came from the LAN", async () => {
    const response = await get("/api/credits", {
      "X-Explainer-Key": KEY,
      "X-Forwarded-For": "192.168.1.77",
    });

    expect(response.status).toBe(403);
    expect(await errorOf(response)).toMatch(/computador que hospeda/);
  });

  // The EXPLAINER_HOST opt-in: a server bound to 127.0.0.1 can never produce
  // this socket, so the middleware is exercised directly.
  it("refuses a connection that landed on a LAN interface", () => {
    const outcome = runMiddleware(
      fakeRequest({ localAddress: "192.168.1.5", remoteAddress: "192.168.1.77" }),
    );

    expect(outcome.status).toBe(403);
    expect(outcome.nexted).toBe(false);
  });

  it("recognises an IPv4 peer reported through a dual-stack socket", () => {
    const outcome = runMiddleware(
      fakeRequest({ localAddress: "::ffff:127.0.0.1", remoteAddress: "::1" }),
    );

    expect(outcome.nexted).toBe(true);
    expect(outcome.status).toBe(0);
  });
});
