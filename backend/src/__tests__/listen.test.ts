import { describe, it, expect } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { attachListenOutcome, listenFailureMessage } from "../services/listen.js";

/** Bind on an ephemeral port and hand back the server plus the port it took. */
function listenOnFreePort(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = express().listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("listenFailureMessage", () => {
  it("names the port, the command that finds the squatter, and the way out", () => {
    const message = listenFailureMessage({ code: "EADDRINUSE" } as NodeJS.ErrnoException, 3001, "127.0.0.1");
    expect(message).toContain("3001");
    expect(message).toContain("ss -ltnp");
    expect(message).toContain("PORT=3002");
  });

  it("reports an unexpected code rather than guessing at it", () => {
    const message = listenFailureMessage({ code: "EACCES" } as NodeJS.ErrnoException, 80, "0.0.0.0");
    expect(message).toContain("EACCES");
    expect(message).toContain("0.0.0.0:80");
  });
});

describe("attachListenOutcome", () => {
  // The regression this file exists for. Express 5's `app.listen(port, host, cb)`
  // aliases `cb` onto the server's `error` event, so a taken port ran the
  // startup banner and the process survived with no HTTP server — the terminal
  // said "Backend running on http://localhost:3001" while the UI said
  // "Erro de conexão". A real double bind is what proves it, because the bug
  // lives in Express's wiring rather than in any value this repo computes.
  it("does not announce a start when the port is already taken", async () => {
    const first = await listenOnFreePort();

    const banners: string[] = [];
    const failures: string[] = [];
    const second = express().listen(first.port, "127.0.0.1");
    attachListenOutcome(second, {
      port: first.port,
      host: "127.0.0.1",
      onListening: () => banners.push("started"),
      onFailure: (message) => failures.push(message),
    });

    await new Promise((resolve) => second.once("error", resolve));

    expect(banners).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain(String(first.port));

    await close(first.server);
  });

  it("announces the start exactly once when the port is free", async () => {
    const banners: string[] = [];
    const failures: string[] = [];
    const server = express().listen(0, "127.0.0.1");
    attachListenOutcome(server, {
      port: 0,
      host: "127.0.0.1",
      onListening: () => banners.push("started"),
      onFailure: (message) => failures.push(message),
    });

    await new Promise((resolve) => server.once("listening", resolve));

    expect(banners).toEqual(["started"]);
    expect(failures).toEqual([]);

    await close(server);
  });

  // The shape the fix depends on: if a future Express stops aliasing the
  // callback onto `error`, this fails and the comment in services/listen.ts is
  // the thing to rewrite.
  it("documents that express aliases a listen callback onto the error event", async () => {
    const first = await listenOnFreePort();

    const calls: unknown[] = [];
    const second = express().listen(first.port, "127.0.0.1", (...args: unknown[]) => {
      calls.push(args[0]);
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(calls).toHaveLength(1);
    expect((calls[0] as NodeJS.ErrnoException | undefined)?.code).toBe("EADDRINUSE");
    expect(second.address()).toBeNull();

    await close(first.server);
  });
});
