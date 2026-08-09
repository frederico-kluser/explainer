import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/api";
import type { ThinkerRoster } from "@/types";

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockFetchResponse(overrides: {
  ok: boolean;
  status: number;
  json?: unknown;
  text?: string;
}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({
        ok: overrides.ok,
        status: overrides.status,
        json:
          overrides.json !== undefined
            ? () => Promise.resolve(overrides.json)
            : undefined,
        text:
          overrides.text !== undefined
            ? () => Promise.resolve(overrides.text)
            : undefined,
      }),
    ),
  );
}

function roster(): ThinkerRoster {
  return {
    version: 1,
    master: {
      provider: "openai",
      model: "gpt-5.2",
      context_window: 128_000,
      supports_tools: true,
      rate: { input: 1.25, cached_input: 0.625, output: 10 },
    },
    planner: {
      provider: "openai",
      model: "gpt-5.2-mini",
      context_window: 128_000,
      supports_tools: true,
      rate: { input: 0.4, cached_input: 0.2, output: 1.6 },
    },
    slots: [
      {
        index: 1,
        enabled: true,
        model: {
          provider: "openai",
          model: "gpt-5.2-mini",
          context_window: 128_000,
          supports_tools: true,
          rate: { input: 0.4, cached_input: 0.2, output: 1.6 },
        },
      },
    ],
    updated_at: "2026-08-09T00:00:00.000Z",
  };
}

const ENVELOPE = {
  roster: roster(),
  providers: [
    {
      provider: "openai",
      env_var: "OPENAI_API_KEY",
      present: true,
      source: "env",
      console_url: "https://platform.openai.com/api-keys",
    },
  ],
  warnings: [],
};

describe("getRoster", () => {
  it("GETs /api/thinkers and returns the envelope", async () => {
    mockFetchResponse({ ok: true, status: 200, json: ENVELOPE });

    const result = await api.getRoster();

    expect(result).toEqual(ENVELOPE);
    expect(fetch).toHaveBeenCalledWith("/api/thinkers");
  });

  it("throws ApiError with the backend's message on failure", async () => {
    mockFetchResponse({
      ok: false,
      status: 500,
      text: JSON.stringify({ error: "Internal server error" }),
    });

    await expect(api.getRoster()).rejects.toMatchObject({
      status: 500,
      message: "Internal server error",
    });
  });
});

describe("putRoster", () => {
  it("PUTs the roster as JSON and returns the normalised envelope", async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(ENVELOPE),
        text: () => Promise.resolve(""),
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await api.putRoster(roster());

    expect(result).toEqual(ENVELOPE);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/thinkers");
    expect(init?.method).toBe("PUT");
    expect(init?.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(String(init?.body))).toEqual(roster());
  });

  it("surfaces a 422 that refuses the version", async () => {
    mockFetchResponse({
      ok: false,
      status: 422,
      text: JSON.stringify({ error: "Este servidor fala a versão 1..." }),
    });

    await expect(api.putRoster(roster())).rejects.toMatchObject({
      status: 422,
      message: "Este servidor fala a versão 1...",
    });
  });
});

describe("resetRoster", () => {
  it("POSTs /api/thinkers/reset and returns the default envelope", async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(ENVELOPE),
        text: () => Promise.resolve(""),
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await api.resetRoster();

    expect(result).toEqual(ENVELOPE);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/thinkers/reset");
    expect(init?.method).toBe("POST");
  });
});
