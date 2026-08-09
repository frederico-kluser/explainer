/**
 * The regression net for `backend-process.ts`.
 *
 * It exists because the two answers this module gives are the ones that decide
 * whether the desktop app has an `/api` at all, and both were previously proven
 * by a harness that was run once and thrown away. Nothing in `npm run validate`
 * reaches `electron/`, so this file is run on its own:
 *
 *     npx vitest run --root . electron/main/services/__tests__/backend-process.test.ts
 *
 * No Electron here on purpose — the module under test imports none, which is
 * the whole reason it was split out of `index.ts`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createTcpServer, type Server as TcpServer } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BACKEND_HOST,
  BACKEND_PORT,
  probeBackendPort,
  resolveDevBackendCommand,
  resolvePackagedBackendCommand
} from '../backend-process';

const HOST = '127.0.0.1';

const closers: Array<() => Promise<void>> = [];
const tempRoots: string[] = [];

afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
  while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true });
});

/** An ephemeral port that was bound and released — nothing listens on it now. */
async function freePort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((resolve) => server.listen(0, HOST, resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/**
 * A socket that accepts connections and answers nothing at all.
 *
 * The held sockets are destroyed by hand at teardown: `server.close()` waits
 * for open connections, and the whole point of this fake is that it never
 * closes one.
 */
async function listenSilently(): Promise<number> {
  const held = new Set<{ destroy: () => void }>();
  const server: TcpServer = createTcpServer((socket) => {
    held.add(socket);
    socket.on('close', () => held.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, HOST, resolve));
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of held) socket.destroy();
        server.close(() => resolve());
      })
  );
  return (server.address() as { port: number }).port;
}

/** An HTTP server answering `/api/health` with the given status + raw body. */
async function listenAsHealth(status: number, body: string, contentType = 'application/json') {
  const server: Server = createHttpServer((req, res) => {
    if (req.url !== '/api/health') {
      res.writeHead(404, { 'content-type': 'text/html' }).end('<h1>Not Found</h1>');
      return;
    }
    res.writeHead(status, { 'content-type': contentType });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, HOST, resolve));
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        // keep-alive sockets outlive the response and would stall close()
        server.closeAllConnections();
        server.close(() => resolve());
      })
  );
  return (server.address() as { port: number }).port;
}

/** Any stranger that binds the port and has no `/api/health` at all. */
async function listenAsStranger(): Promise<number> {
  const server: Server = createHttpServer((_req, res) => {
    res.writeHead(404, { 'content-type': 'text/html' }).end('<h1>Not Found</h1>');
  });
  await new Promise<void>((resolve) => server.listen(0, HOST, resolve));
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  );
  return (server.address() as { port: number }).port;
}

/** A throwaway repo root; `parts` are the files to create under it. */
function fakeRepoRoot(parts: string[][]): string {
  const root = mkdtempSync(join(tmpdir(), 'explainer-backend-process-'));
  tempRoots.push(root);
  for (const part of parts) {
    const file = join(root, ...part);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, '');
  }
  return root;
}

const TSX_ENTRY = ['backend', 'node_modules', 'tsx', 'dist', 'cli.mjs'];
const BUILT_ENTRY = ['backend', 'dist', 'index.js'];

describe('BACKEND_PORT', () => {
  it('is the port backend/src/index.ts defaults to', () => {
    expect(BACKEND_PORT).toBe(3001);
  });
});

describe('BACKEND_HOST', () => {
  it('is the loopback address the probe and the provider-key sync share', () => {
    expect(BACKEND_HOST).toBe('127.0.0.1');
  });
});

describe('probeBackendPort', () => {
  it('reports free when nothing is listening', async () => {
    await expect(probeBackendPort(await freePort(), 300, HOST)).resolves.toBe('free');
  });

  it('reports occupied-by-other for a socket that accepts but never answers', async () => {
    // The timeout has to be the probe's, not the suite's: a silent socket is
    // exactly the case a plain HTTP probe hangs on.
    await expect(probeBackendPort(await listenSilently(), 300, HOST)).resolves.toBe(
      'occupied-by-other'
    );
  });

  it('reports backend-alive when /api/health answers status ok', async () => {
    const port = await listenAsHealth(200, '{"status":"ok"}');
    await expect(probeBackendPort(port, 1000, HOST)).resolves.toBe('backend-alive');
  });

  it('reports occupied-by-other when /api/health answers a non-2xx', async () => {
    const port = await listenAsHealth(503, '{"status":"ok"}');
    await expect(probeBackendPort(port, 1000, HOST)).resolves.toBe('occupied-by-other');
  });

  it('reports occupied-by-other when the body is JSON but not ours', async () => {
    const port = await listenAsHealth(200, '{"status":"degraded"}');
    await expect(probeBackendPort(port, 1000, HOST)).resolves.toBe('occupied-by-other');
  });

  it('reports occupied-by-other when the 200 body is not JSON at all', async () => {
    const port = await listenAsHealth(200, '<h1>hello</h1>', 'text/html');
    await expect(probeBackendPort(port, 1000, HOST)).resolves.toBe('occupied-by-other');
  });

  it('reports occupied-by-other for a stranger with no /api/health', async () => {
    await expect(probeBackendPort(await listenAsStranger(), 1000, HOST)).resolves.toBe(
      'occupied-by-other'
    );
  });
});

describe('resolveDevBackendCommand', () => {
  it('runs tsx WITH watch, matching backend/package.json dev', () => {
    const root = fakeRepoRoot([TSX_ENTRY]);
    const resolution = resolveDevBackendCommand(root, '/opt/electron');

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.command.args).toEqual([
      join(root, ...TSX_ENTRY),
      'watch',
      'src/index.ts'
    ]);
    expect(resolution.command.label).toBe('tsx watch src/index.ts');
  });

  it('spawns tsx through the app binary as Node, never through a shell', () => {
    const root = fakeRepoRoot([TSX_ENTRY]);
    const resolution = resolveDevBackendCommand(root, '/opt/electron');

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    // The regression this guards: a `.cmd` shim needs `shell: true`, and a
    // shell on Windows makes `child.kill()` kill cmd.exe and orphan the server.
    expect(resolution.command.file).toBe('/opt/electron');
    expect('shell' in resolution.command).toBe(false);
    expect(resolution.command.extraEnv).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
    expect(resolution.command.cwd).toBe(join(root, 'backend'));
  });

  it('falls back to the built output when tsx was never installed', () => {
    const root = fakeRepoRoot([BUILT_ENTRY]);
    const resolution = resolveDevBackendCommand(root, '/opt/electron');

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.command.file).toBe('/opt/electron');
    expect(resolution.command.args).toEqual([join(root, ...BUILT_ENTRY)]);
    expect(resolution.command.extraEnv).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
    expect(resolution.command.label).toContain('looks stale');
  });

  it('prefers the source over the build artifact when both exist', () => {
    const root = fakeRepoRoot([TSX_ENTRY, BUILT_ENTRY]);
    const resolution = resolveDevBackendCommand(root, '/opt/electron');

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.command.label).toBe('tsx watch src/index.ts');
  });

  it('fails with an actionable error when there is nothing to run', () => {
    const resolution = resolveDevBackendCommand(fakeRepoRoot([]), '/opt/electron');

    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.error).toContain('cli.mjs');
    expect(resolution.error).toContain('dist/index.js');
    expect(resolution.error).toContain('npm run setup');
  });
});

describe('resolvePackagedBackendCommand', () => {
  // Dead code until `utilityProcess.fork()` + `extraResources` land — the test
  // pins the shape so the eventual rewrite is a visible change, not a drift.
  it('points the app binary at resources/backend/index.js', () => {
    const command = resolvePackagedBackendCommand('/app/resources', '/app/explainer');

    expect(command.file).toBe('/app/explainer');
    expect(command.args).toEqual([join('/app/resources', 'backend', 'index.js')]);
    expect(command.label).toBe(join('/app/resources', 'backend', 'index.js'));
    expect('shell' in command).toBe(false);
  });
});
