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
});

describe("appendMessages", () => {
  it("does not touch the network for an empty batch", async () => {
    mockFetchResponse({ ok: true, status: 201, json: {} });
    await api.appendMessages(CONV, []);
    expect(fetch).not.toHaveBeenCalled();
  });
});
