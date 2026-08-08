import { describe, it, expect, afterEach, vi } from "vitest";
import * as api from "@/lib/api";

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
        json: overrides.json !== undefined
          ? () => Promise.resolve(overrides.json)
          : undefined,
        text: overrides.text !== undefined
          ? () => Promise.resolve(overrides.text)
          : undefined,
      }),
    ),
  );
}

// ---------------------------------------------------------------------------
// listConversations
// ---------------------------------------------------------------------------

describe("listConversations", () => {
  it("returns parsed JSON on success (200)", async () => {
    mockFetchResponse({
      ok: true,
      status: 200,
      json: [{ id: "1", title: "Test" }],
    });

    const result = await api.listConversations();
    expect(result).toEqual([{ id: "1", title: "Test" }]);
  });

  it("throws ApiError with extracted error message from JSON body", async () => {
    mockFetchResponse({
      ok: false,
      status: 500,
      text: JSON.stringify({ error: "custom message" }),
    });

    await expect(api.listConversations()).rejects.toMatchObject({
      status: 500,
      message: "custom message",
    });
  });

  it("throws ApiError with 'HTTP {status}' fallback on non-JSON body", async () => {
    mockFetchResponse({
      ok: false,
      status: 502,
      text: "<html>Server Error</html>",
    });

    await expect(api.listConversations()).rejects.toMatchObject({
      status: 502,
      message: "HTTP 502",
    });
  });

  it("throws ApiError with 'HTTP {status}' fallback when JSON body has no .error field", async () => {
    mockFetchResponse({
      ok: false,
      status: 403,
      text: JSON.stringify({ detail: "forbidden" }),
    });

    await expect(api.listConversations()).rejects.toMatchObject({
      status: 403,
      message: "HTTP 403",
    });
  });
});

// ---------------------------------------------------------------------------
// deleteConversation
// ---------------------------------------------------------------------------

describe("deleteConversation", () => {
  it("resolves without error on success (204)", async () => {
    mockFetchResponse({
      ok: true,
      status: 204,
    });

    await expect(api.deleteConversation("id1")).resolves.toBeUndefined();
  });

  it("throws ApiError with extracted error on 404 with JSON body", async () => {
    mockFetchResponse({
      ok: false,
      status: 404,
      text: JSON.stringify({ error: "Not found" }),
    });

    await expect(api.deleteConversation("id1")).rejects.toMatchObject({
      status: 404,
      message: "Not found",
    });
  });
});

// ---------------------------------------------------------------------------
// Realtime session + tools
// ---------------------------------------------------------------------------

const CONV = "550e8400-e29b-41d4-a716-446655440000";

describe("createRealtimeSession", () => {
  it("posts the conversation id and returns the ephemeral token", async () => {
    mockFetchResponse({
      ok: true,
      status: 200,
      json: { value: "ek_test", expires_at: 1, model: "gpt-realtime-2.1" },
    });

    const token = await api.createRealtimeSession(CONV);
    expect(token.value).toBe("ek_test");
    expect(fetch).toHaveBeenCalledWith(
      "/api/realtime/session",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("surfaces the server's refusal when no source is selected", async () => {
    mockFetchResponse({
      ok: false,
      status: 409,
      text: JSON.stringify({ error: "Nenhuma fonte selecionada." }),
    });

    await expect(api.createRealtimeSession(CONV)).rejects.toMatchObject({
      status: 409,
      message: "Nenhuma fonte selecionada.",
    });
  });
});

describe("materials", () => {
  it("lists what a conversation is pointed at", async () => {
    mockFetchResponse({
      ok: true,
      status: 200,
      json: {
        materials: [{ id: "m1", kind: "machine", label: "Este computador" }],
        tools: ["web_search"],
        greeting: "Pronto.",
      },
    });
    const envelope = await api.listMaterials(CONV);
    expect(envelope.materials[0]?.label).toBe("Este computador");
  });

  it("returns an empty list rather than throwing for a fresh conversation", async () => {
    mockFetchResponse({
      ok: true,
      status: 200,
      json: { materials: [], tools: [], greeting: "Adicione um material." },
    });
    await expect(api.listMaterials(CONV)).resolves.toMatchObject({ materials: [] });
  });

  it("removes one by id", async () => {
    mockFetchResponse({
      ok: true,
      status: 200,
      json: { materials: [], tools: [], greeting: "" },
    });
    await api.removeMaterial(CONV, "m1");
    expect(fetch).toHaveBeenCalledWith(
      `/api/sources/${CONV}/m1`,
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("surfaces the limit refusal from the server", async () => {
    mockFetchResponse({
      ok: false,
      status: 409,
      text: JSON.stringify({ error: "Uma conversa comporta no máximo 6 materiais." }),
    });
    await expect(api.addMaterial(CONV, { kind: "machine" })).rejects.toMatchObject({
      status: 409,
    });
  });
});

describe("browse", () => {
  it("walks a path when given one", async () => {
    mockFetchResponse({
      ok: true,
      status: 200,
      json: { path: "/home/x/Projects", parent: null, roots: [], entries: [] },
    });
    await api.browse("/home/x/Projects");
    expect(fetch).toHaveBeenCalledWith(
      "/api/browse?path=%2Fhome%2Fx%2FProjects",
    );
  });

  it("asks for the roots when given nothing", async () => {
    mockFetchResponse({
      ok: true,
      status: 200,
      json: { path: null, parent: null, roots: ["/home/x/Projects"], entries: [] },
    });
    const result = await api.browse();
    expect(fetch).toHaveBeenCalledWith("/api/browse");
    expect(result.roots).toContain("/home/x/Projects");
  });
});

describe("runTool", () => {
  it("forwards call_id, name and arguments to the backend", async () => {
    mockFetchResponse({
      ok: true,
      status: 200,
      json: { call_id: "call_1", name: "web_search", output: "ok", meta: null },
    });

    const result = await api.runTool(CONV, {
      call_id: "call_1",
      name: "web_search",
      arguments: '{"query":"oi"}',
    });

    expect(result.output).toBe("ok");
    const mock = fetch as unknown as { mock: { calls: unknown[][] } };
    const body = JSON.parse((mock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toMatchObject({
      conversation_id: CONV,
      call_id: "call_1",
      name: "web_search",
    });
  });

  it("carries meta back untouched — it is the only path a diagram has", async () => {
    // `generate_diagram` puts the mermaid source in `meta` precisely because
    // anything in `output` gets read out loud. Dropping `meta` anywhere between
    // here and the hook means the drawing never reaches the screen.
    const diagram = {
      id: "d1",
      kind: "flowchart",
      title: "Fluxo do login",
      source: "flowchart TD\n  A --> B",
      caption: "Desenhei o fluxo do login.",
      created_at: "2026-08-08T12:00:00.000Z",
    };
    mockFetchResponse({
      ok: true,
      status: 200,
      json: {
        call_id: "call_2",
        name: "generate_diagram",
        output: "Desenhei o fluxo do login.",
        meta: { diagram },
      },
    });

    const result = await api.runTool(CONV, {
      call_id: "call_2",
      name: "generate_diagram",
      arguments: '{"instructions":"o login"}',
    });

    expect(result.meta).toEqual({ diagram });
    expect(result.output).not.toContain("flowchart");
  });

  it("keeps the deep_think job id in meta and out of the spoken output", async () => {
    mockFetchResponse({
      ok: true,
      status: 200,
      json: {
        call_id: "call_3",
        name: "deep_think",
        output: "Disparei os pensadores.",
        meta: {
          job_id: "job_9",
          status: "running",
          activity: "preparando os angulos",
          angles: ["riscos", "custo"],
        },
      },
    });

    const result = await api.runTool(CONV, {
      call_id: "call_3",
      name: "deep_think",
      arguments: "{}",
    });

    expect(result.meta).toMatchObject({ job_id: "job_9", angles: ["riscos", "custo"] });
    expect(result.output).not.toContain("job_9");
  });
});

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

const MEMORY_FILE = {
  version: 1 as const,
  conversation_id: CONV,
  title: "Conversa",
  created_at: "2026-08-08T10:00:00.000Z",
  updated_at: "2026-08-08T11:00:00.000Z",
  materials: ["explainer"],
  events: [{ id: "e1", kind: "user" as const, at: "2026-08-08T10:00:00.000Z", text: "oi" }],
};

describe("getMemory", () => {
  it("returns the whole file when the conversation has a past", async () => {
    mockFetchResponse({ ok: true, status: 200, json: MEMORY_FILE });

    const file = await api.getMemory(CONV);
    expect(file?.events).toHaveLength(1);
    expect(fetch).toHaveBeenCalledWith(`/api/conversations/${CONV}/memory`);
  });

  it("answers null on 404 — a new conversation is an empty state, not a failure", async () => {
    mockFetchResponse({
      ok: false,
      status: 404,
      text: JSON.stringify({ error: "Esta conversa ainda não tem memória gravada." }),
    });

    await expect(api.getMemory(CONV)).resolves.toBeNull();
  });

  it("still throws when the server is actually broken", async () => {
    mockFetchResponse({ ok: false, status: 500, text: JSON.stringify({ error: "boom" }) });

    await expect(api.getMemory(CONV)).rejects.toMatchObject({ status: 500 });
  });
});

describe("memoryDownloadUrl", () => {
  it("points at the route that sets Content-Disposition, without fetching it", () => {
    expect(api.memoryDownloadUrl(CONV)).toBe(`/api/conversations/${CONV}/memory?download`);
  });
});

describe("importMemory", () => {
  it("posts the file to the import route", async () => {
    mockFetchResponse({ ok: true, status: 201, json: MEMORY_FILE });

    await api.importMemory(CONV, MEMORY_FILE);
    expect(fetch).toHaveBeenCalledWith(
      `/api/conversations/${CONV}/memory/import`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("asks for the overwrite only when the caller said so", async () => {
    mockFetchResponse({ ok: true, status: 201, json: MEMORY_FILE });

    await api.importMemory(CONV, MEMORY_FILE, { overwrite: true });
    expect(fetch).toHaveBeenCalledWith(
      `/api/conversations/${CONV}/memory/import?overwrite=true`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("propagates the 409 verbatim — it is a decision to offer, not an error to hide", async () => {
    // The server already wrote the sentence, in Portuguese, naming both ways
    // out. Replacing it with "falha ao importar" would delete the only
    // instruction the user has for a file that cannot be recovered.
    const refusal =
      "Esta conversa já tem memória gravada (12 eventos, 3 reflexões). Importar por cima " +
      "apaga tudo isso e não há como desfazer. Repita com ?overwrite=true, ou apague " +
      "a memória atual antes (DELETE /api/conversations/:id/memory).";
    mockFetchResponse({ ok: false, status: 409, text: JSON.stringify({ error: refusal }) });

    await expect(api.importMemory(CONV, MEMORY_FILE)).rejects.toMatchObject({
      status: 409,
      message: refusal,
    });
    await expect(api.importMemory(CONV, MEMORY_FILE)).rejects.toBeInstanceOf(api.ApiError);
  });

  it("propagates the 400 the format check writes", async () => {
    mockFetchResponse({
      ok: false,
      status: 400,
      text: JSON.stringify({ error: "Arquivo de memória inválido: evento 2 sem kind." }),
    });

    await expect(api.importMemory(CONV, MEMORY_FILE)).rejects.toMatchObject({
      status: 400,
      message: "Arquivo de memória inválido: evento 2 sem kind.",
    });
  });
});

describe("getMemoryResume", () => {
  it("returns the compressed form", async () => {
    mockFetchResponse({
      ok: true,
      status: 200,
      json: {
        conversation_id: CONV,
        summary: "Falamos do gate de acks.",
        reflections: ["o replay nao pode falar"],
        tool_findings: [],
        materials: ["explainer"],
        event_count: 12,
      },
    });

    const resume = await api.getMemoryResume(CONV);
    expect(resume?.event_count).toBe(12);
    expect(fetch).toHaveBeenCalledWith(`/api/conversations/${CONV}/memory/resume`);
  });

  it("answers null on 404 rather than throwing", async () => {
    mockFetchResponse({ ok: false, status: 404, text: "" });
    await expect(api.getMemoryResume(CONV)).resolves.toBeNull();
  });
});

describe("clearMemory", () => {
  it("resolves on 204", async () => {
    mockFetchResponse({ ok: true, status: 204 });

    await expect(api.clearMemory(CONV)).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledWith(
      `/api/conversations/${CONV}/memory`,
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});

// ---------------------------------------------------------------------------
// The mint cannot hang forever
// ---------------------------------------------------------------------------

describe("createRealtimeSession timeout", () => {
  /** A fetch that only ever settles when its signal is aborted. */
  function mockHangingFetch() {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_path: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new Error("The operation was aborted.")),
            );
          }),
      ),
    );
  }

  it("gives up with a sentence the user can act on", async () => {
    mockHangingFetch();

    await expect(
      api.createRealtimeSession(CONV, { timeoutMs: 10 }),
    ).rejects.toThrow(/demorou demais/);
  });

  it("passes a signal to fetch so the request is really dropped", async () => {
    mockHangingFetch();

    await expect(api.createRealtimeSession(CONV, { timeoutMs: 10 })).rejects.toThrow();
    const mock = fetch as unknown as { mock: { calls: unknown[][] } };
    const init = mock.mock.calls[0]![1] as RequestInit;
    expect(init.signal?.aborted).toBe(true);
  });

  it("disarms its own deadline as soon as the mint has answered", async () => {
    // Without the `clearTimeout`, the deadline stays armed after the token is
    // already in hand and fires into a session that is being connected: the
    // controller aborts, and the signal `fetch` was handed — the same one the
    // caller may still be watching — flips to aborted for no reason at all.
    vi.useFakeTimers();
    try {
      let init: RequestInit | undefined;
      vi.stubGlobal(
        "fetch",
        vi.fn((_path: string, options?: RequestInit) => {
          init = options;
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ value: "ek_test", model: "gpt-realtime-2.1" }),
          });
        }),
      );

      await api.createRealtimeSession(CONV, { timeoutMs: 10 });
      vi.advanceTimersByTime(1_000);

      expect(init?.signal?.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets the caller's own abort through as itself, not as a timeout", async () => {
    mockHangingFetch();
    const controller = new AbortController();
    const pending = api.createRealtimeSession(CONV, {
      signal: controller.signal,
      timeoutMs: 60_000,
    });
    controller.abort();

    await expect(pending).rejects.toThrow(/aborted/i);
  });
});

describe("appendMessages", () => {
  it("does not touch the network for an empty batch", async () => {
    mockFetchResponse({ ok: true, status: 201, json: {} });
    await api.appendMessages(CONV, []);
    expect(fetch).not.toHaveBeenCalled();
  });
});
