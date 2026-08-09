/**
 * The regression net for `provider-key-sync.ts` — the bridge between the
 * settings store and a backend the main process may have spawned OR reused.
 *
 * The two behaviours that matter are the ones the boot order depends on: the
 * sync WAITS for a backend that is still coming up, and it never throws —
 * a refused or unreachable backend is a logged false, never a crash. The
 * module imports no `electron`, so this file proves both without one:
 *
 *     npx vitest run --root . electron/main/services/__tests__/provider-key-sync.test.ts
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createTcpServer } from 'node:net';

import {
  deleteProviderKeyFromBackend,
  putProviderKeyToBackend,
  syncProviderKeyToBackend,
  syncStoredKeysToBackend,
  waitForBackendReady
} from '../provider-key-sync';

const HOST = '127.0.0.1';

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
});

/** An ephemeral port that was bound and released — nothing listens on it now. */
async function freePort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((resolve) => server.listen(0, HOST, resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

interface RecordedRequest {
  method: string;
  url: string;
  body: string;
}

/**
 * A fake backend: answers `/api/health` (503 until `healthy` flips), records
 * every request, and answers PUT/DELETE on `/api/provider-keys/*` with the
 * configured status.
 */
async function listenAsBackend(answers: {
  putStatus: number;
  deleteStatus: number;
}): Promise<{
  port: number;
  requests: RecordedRequest[];
  healthy: { current: boolean };
}> {
  const requests: RecordedRequest[] = [];
  const healthy = { current: false };
  const server: Server = createHttpServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf-8');
    });
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', body });
      if (req.url === '/api/health') {
        res.writeHead(healthy.current ? 200 : 503, { 'content-type': 'application/json' });
        res.end(healthy.current ? '{"status":"ok"}' : '{"status":"degraded"}');
        return;
      }
      if (req.url?.startsWith('/api/provider-keys/')) {
        const provider = req.url.slice('/api/provider-keys/'.length);
        if (req.method === 'PUT') {
          const status = answers.putStatus;
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ provider, present: status === 200 }));
          return;
        }
        if (req.method === 'DELETE') {
          const status = answers.deleteStatus;
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ provider, present: false }));
          return;
        }
      }
      res.writeHead(404, { 'content-type': 'text/html' }).end('<h1>Not Found</h1>');
    });
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
  return { port: (server.address() as { port: number }).port, requests, healthy };
}

/** The sync options every case needs: the fake's port and fast pacing. */
function optionsFor(port: number) {
  return {
    baseUrl: `http://${HOST}:${port}`,
    readyTimeoutMs: 3_000,
    pollIntervalMs: 20,
    requestTimeoutMs: 1_000
  };
}

const KEYS = {
  openai: 'sk-proj-openai-0123456789abcdef',
  openrouter: 'sk-or-v1-openrouter-0123456789abcdef',
  deepseek: 'sk-deepseek-0123456789abcdef'
} as const;

describe('waitForBackendReady', () => {
  it('reports true once /api/health answers ok', async () => {
    const { port, healthy } = await listenAsBackend({ putStatus: 200, deleteStatus: 200 });
    healthy.current = true;

    await expect(waitForBackendReady(optionsFor(port))).resolves.toBe(true);
  });

  it('keeps waiting while the backend answers a non-ok health', async () => {
    // healthy.current stays false (the default) — the backend exists but is
    // not up yet, so every probe answers 503.
    const { port } = await listenAsBackend({ putStatus: 200, deleteStatus: 200 });
    const start = Date.now();
    await expect(waitForBackendReady(optionsFor(port))).resolves.toBe(false);
    expect(Date.now() - start).toBeGreaterThanOrEqual(3_000 - 500); // the full budget
  });

  it('reports false when nothing is listening, within the budget', async () => {
    await expect(
      waitForBackendReady({ ...optionsFor(await freePort()), readyTimeoutMs: 300 })
    ).resolves.toBe(false);
  });
});

describe('putProviderKeyToBackend', () => {
  it('PUTs { key } as JSON to the provider path and reports ok', async () => {
    const { port, requests } = await listenAsBackend({ putStatus: 200, deleteStatus: 200 });

    await expect(putProviderKeyToBackend('openrouter', KEYS.openrouter, optionsFor(port))).resolves.toBe(
      true
    );

    const put = requests.find((r) => r.method === 'PUT');
    expect(put).toBeDefined();
    expect(put!.url).toBe('/api/provider-keys/openrouter');
    expect(JSON.parse(put!.body)).toEqual({ key: KEYS.openrouter });
  });

  it('reports false when the backend refuses the key', async () => {
    const { port } = await listenAsBackend({ putStatus: 400, deleteStatus: 200 });

    await expect(putProviderKeyToBackend('openai', KEYS.openai, optionsFor(port))).resolves.toBe(
      false
    );
  });

  it('reports false when nothing is listening', async () => {
    await expect(
      putProviderKeyToBackend('openai', KEYS.openai, optionsFor(await freePort()))
    ).resolves.toBe(false);
  });
});

describe('deleteProviderKeyFromBackend', () => {
  it('DELETEs the provider path and reports ok', async () => {
    const { port, requests } = await listenAsBackend({ putStatus: 200, deleteStatus: 200 });

    await expect(deleteProviderKeyFromBackend('openai', optionsFor(port))).resolves.toBe(true);

    const del = requests.find((r) => r.method === 'DELETE');
    expect(del).toBeDefined();
    expect(del!.url).toBe('/api/provider-keys/openai');
  });

  it('reports false when the backend refuses, and never asks for openaiAdmin', async () => {
    const { port, requests } = await listenAsBackend({ putStatus: 200, deleteStatus: 400 });

    await expect(deleteProviderKeyFromBackend('openai', optionsFor(port))).resolves.toBe(false);
    // A store-only slot the backend accepts on no route — skipped, not asked.
    await expect(deleteProviderKeyFromBackend('openaiAdmin', optionsFor(port))).resolves.toBe(false);
    expect(requests.some((r) => r.url.includes('openaiAdmin'))).toBe(false);
  });
});

describe('syncProviderKeyToBackend', () => {
  it('waits for a backend that is still coming up, then PUTs', async () => {
    const { port, requests, healthy } = await listenAsBackend({
      putStatus: 200,
      deleteStatus: 200
    });
    setTimeout(() => {
      healthy.current = true;
    }, 100);

    await expect(
      syncProviderKeyToBackend('deepseek', KEYS.deepseek, optionsFor(port))
    ).resolves.toBe(true);

    expect(requests.filter((r) => r.method === 'PUT' && r.url.includes('deepseek'))).toHaveLength(1);
  });

  it('reports false when the backend never comes up', async () => {
    await expect(
      syncProviderKeyToBackend('openai', KEYS.openai, {
        ...optionsFor(await freePort()),
        readyTimeoutMs: 300
      })
    ).resolves.toBe(false);
  });

  it('reports false for a store-only provider and for an empty key', async () => {
    const { port } = await listenAsBackend({ putStatus: 200, deleteStatus: 200 });

    await expect(syncProviderKeyToBackend('openaiAdmin', KEYS.openai, optionsFor(port))).resolves.toBe(
      false
    );
    await expect(syncProviderKeyToBackend('openai', '   ', optionsFor(port))).resolves.toBe(false);
  });
});

describe('syncStoredKeysToBackend', () => {
  it('PUTs every non-empty syncable key, skipping empty slots and openaiAdmin', async () => {
    const { port, requests, healthy } = await listenAsBackend({
      putStatus: 200,
      deleteStatus: 200
    });
    healthy.current = true;

    const result = await syncStoredKeysToBackend(
      {
        openai: { key: KEYS.openai },
        openaiAdmin: { key: KEYS.openai }, // store-only: skipped
        openrouter: { key: KEYS.openrouter },
        deepseek: { key: '' } // empty: skipped
      },
      optionsFor(port)
    );

    expect(result.synced.sort()).toEqual(['openai', 'openrouter']);
    expect(result.failed).toEqual([]);
    const putUrls = requests.filter((r) => r.method === 'PUT').map((r) => r.url);
    expect(putUrls.sort()).toEqual(['/api/provider-keys/openai', '/api/provider-keys/openrouter']);
    expect(putUrls.some((url) => url.includes('openaiAdmin'))).toBe(false);
  });

  it('makes no requests at all when there is nothing to sync', async () => {
    const { port, requests, healthy } = await listenAsBackend({
      putStatus: 200,
      deleteStatus: 200
    });
    healthy.current = true;

    const result = await syncStoredKeysToBackend(
      {
        openai: { key: '' },
        openaiAdmin: { key: '' },
        openrouter: { key: '  ' },
        deepseek: { key: '' }
      },
      optionsFor(port)
    );

    expect(result).toEqual({ synced: [], failed: [] });
    expect(requests).toHaveLength(0);
  });

  it('names every provider as failed when the backend never answers', async () => {
    const result = await syncStoredKeysToBackend(
      {
        openai: { key: KEYS.openai },
        openrouter: { key: KEYS.openrouter }
      },
      { ...optionsFor(await freePort()), readyTimeoutMs: 300 }
    );

    expect(result.synced).toEqual([]);
    expect(result.failed.sort()).toEqual(['openai', 'openrouter']);
  });

  it('reports the refused providers separately when the backend is up', async () => {
    const { port, healthy } = await listenAsBackend({ putStatus: 400, deleteStatus: 200 });
    healthy.current = true;

    const result = await syncStoredKeysToBackend(
      {
        openai: { key: KEYS.openai },
        deepseek: { key: KEYS.deepseek }
      },
      optionsFor(port)
    );

    expect(result.synced).toEqual([]);
    expect(result.failed.sort()).toEqual(['deepseek', 'openai']);
  });
});
