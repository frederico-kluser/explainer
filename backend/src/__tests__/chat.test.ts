import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";

// ---------------------------------------------------------------------------
// Mock setup — vi.mock is hoisted, so vars must go through vi.hoisted
// ---------------------------------------------------------------------------

// DeepSeekError needs to be a proper class for instanceof checks.
const { mockDeepseekChat, mockDeepseekReasoner, MockDeepSeekError } =
  vi.hoisted(() => {
    class MockDeepSeekError extends Error {
      declare status: number;
      constructor(status: number, message: string) {
        super(message);
        this.status = status;
        this.name = "DeepSeekError";
      }
    }
    return {
      mockDeepseekChat: vi.fn(),
      mockDeepseekReasoner: vi.fn(),
      MockDeepSeekError,
    };
  });

vi.mock("../services/deepseek.js", () => ({
  deepseekChat: mockDeepseekChat,
  deepseekReasoner: mockDeepseekReasoner,
  DeepSeekError: MockDeepSeekError,
}));

const mockExecuteTool = vi.hoisted(() => vi.fn());
vi.mock("../services/tool-executor.js", () => ({
  executeTool: mockExecuteTool,
}));

const mockListSources = vi.hoisted(() => vi.fn());
vi.mock("../services/source-store.js", () => ({
  listSources: mockListSources,
  pickSource: vi.fn(),
  forgetSources: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Dynamic import after mocks are configured
// ---------------------------------------------------------------------------

const chatRouter = await import("../routes/chat.js");
const { errorHandler } = await import("../middleware/error-handler.js");

// ---------------------------------------------------------------------------
// Helper types for mock returns
// ---------------------------------------------------------------------------

function makeChatResult(content: string) {
  return {
    message: { role: "assistant" as const, content },
    usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
    finishReason: "stop",
    model: "deepseek-chat",
    id: "mock-id",
  };
}

function makeReasonerResult(opts: {
  content?: string;
  toolCalls?: Array<{
    id: string;
    function: { name: string; arguments: string };
  }>;
  finishReason?: string;
}) {
  return {
    message: {
      role: "assistant" as const,
      content: opts.content ?? null,
      tool_calls: opts.toolCalls,
    },
    usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    finishReason: opts.finishReason ?? (opts.toolCalls ? "tool_calls" : "stop"),
    model: "deepseek-reasoner",
    id: "mock-reasoner-id",
  };
}

// ---------------------------------------------------------------------------
// Test app
// ---------------------------------------------------------------------------

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/chat", chatRouter.default);
  app.use(errorHandler);

  await new Promise<void>((resolve) => {
    server = createServer(app);
    server.listen(0, () => {
      const addr = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  mockListSources.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function postJSON(body: unknown) {
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body: json };
}

/**
 * Read a streaming SSE response line by line and collect parsed events.
 * Returns the collected events and the raw text for debugging.
 */
async function readSSEStream(response: Response) {
  const body = response.body;
  if (!body) throw new Error("No response body");

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: Array<Record<string, unknown>> = [];
  let rawText = "";
  let sawDone = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    rawText += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data:")) continue;

      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") {
        sawDone = true;
        break;
      }

      try {
        events.push(JSON.parse(data) as Record<string, unknown>);
      } catch {
        // skip unparseable
      }
    }

    if (sawDone) break;
  }

  reader.releaseLock();
  return { events, rawText, sawDone };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/chat — classification → conversation", () => {
  it("returns { mode: conversation } for a casual greeting", async () => {
    mockDeepseekChat.mockResolvedValueOnce(makeChatResult("conversation"));

    const { status, body } = await postJSON({ message: "Oi, tudo bem?" });

    expect(status).toBe(200);
    expect(body).toEqual({ mode: "conversation" });
  });

  it("returns { mode: conversation } even with surrounding whitespace in label", async () => {
    mockDeepseekChat.mockResolvedValueOnce(makeChatResult("  conversation  "));

    const { status, body } = await postJSON({ message: "E ai!" });

    expect(status).toBe(200);
    expect(body).toEqual({ mode: "conversation" });
  });
});

describe("POST /api/chat — classification → direct task", () => {
  it("returns { mode: task, type: direct, answer } for a code generation request", async () => {
    // First call: classification
    mockDeepseekChat.mockResolvedValueOnce(
      makeChatResult("task_without_reading"),
    );
    // Second call: direct answer
    mockDeepseekChat.mockResolvedValueOnce(
      makeChatResult("Aqui esta o codigo que voce pediu..."),
    );

    const { status, body } = await postJSON({
      message: "Escreva uma funcao que calcula fibonacci",
    });

    expect(status).toBe(200);
    expect(body.mode).toBe("task");
    expect(body.type).toBe("direct");
    expect(body.answer).toBe("Aqui esta o codigo que voce pediu...");
  });

  it("returns { mode: task, type: direct, answer } for a factual question", async () => {
    mockDeepseekChat.mockResolvedValueOnce(
      makeChatResult("task_without_reading"),
    );
    mockDeepseekChat.mockResolvedValueOnce(
      makeChatResult("A capital da Franca e Paris."),
    );

    const { status, body } = await postJSON({
      message: "Qual e a capital da Franca?",
    });

    expect(status).toBe(200);
    expect(body.mode).toBe("task");
    expect(body.type).toBe("direct");
    expect(body.answer).toBe("A capital da Franca e Paris.");
  });
});

describe("POST /api/chat — classification → ReAct SSE stream", () => {
  it("streams tool_call and answer events when the reasoner uses tools", async () => {
    // Classification
    mockDeepseekChat.mockResolvedValueOnce(
      makeChatResult("task_with_reading"),
    );

    // First reasoner call: tool call
    mockDeepseekReasoner.mockResolvedValueOnce(
      makeReasonerResult({
        toolCalls: [
          {
            id: "call-1",
            function: {
              name: "search_source",
              arguments: JSON.stringify({ query: "fibonacci" }),
            },
          },
        ],
      }),
    );

    // Tool execution
    mockExecuteTool.mockResolvedValueOnce({
      output: "src/utils.ts:10: export function fibonacci(n: number) { ... }",
    });

    // Second reasoner call: final answer
    mockDeepseekReasoner.mockResolvedValueOnce(
      makeReasonerResult({
        content: "O projeto implementa fibonacci em src/utils.ts.",
        finishReason: "stop",
      }),
    );

    const response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Como fibonacci funciona aqui?" }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const { events, sawDone } = await readSSEStream(response);

    expect(sawDone).toBe(true);
    expect(events.length).toBeGreaterThanOrEqual(3);

    // First event: tool_call
    expect(events[0]).toMatchObject({
      type: "tool_call",
      tool: "search_source",
    });

    // Second event: tool_result
    expect(events[1]).toMatchObject({
      type: "tool_result",
      tool: "search_source",
    });

    // Last event: answer
    const answerEvent = events[events.length - 1];
    expect(answerEvent).toMatchObject({ type: "answer" });
    expect((answerEvent as Record<string, unknown>).content).toContain(
      "src/utils.ts",
    );
  });

  it("streams answer directly when no tools are needed", async () => {
    mockDeepseekChat.mockResolvedValueOnce(
      makeChatResult("task_with_reading"),
    );

    mockDeepseekReasoner.mockResolvedValueOnce(
      makeReasonerResult({
        content: "Nao encontrei nada relevante no projeto.",
        finishReason: "stop",
      }),
    );

    const response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "O que esse projeto faz?" }),
    });

    expect(response.status).toBe(200);

    const { events, sawDone } = await readSSEStream(response);

    expect(sawDone).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "answer" });
  });

  it("streams error event when reasoner stalls", async () => {
    mockDeepseekChat.mockResolvedValueOnce(
      makeChatResult("task_with_reading"),
    );

    // Reasoner returns no content and no tool calls
    mockDeepseekReasoner.mockResolvedValueOnce(
      makeReasonerResult({ content: undefined, finishReason: "length" }),
    );

    const response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Explique o codigo." }),
    });

    const { events, sawDone } = await readSSEStream(response);

    expect(sawDone).toBe(true);
    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
  });
});

describe("POST /api/chat — error handling", () => {
  it("returns 400 when message is missing", async () => {
    const { status, body } = await postJSON({});

    expect(status).toBe(400);
    expect(body.error).toBeDefined();
    expect(typeof body.error).toBe("string");
    expect((body.error as string).length).toBeGreaterThan(0);
  });

  it("returns 400 when message is an empty string", async () => {
    const { status, body } = await postJSON({ message: "" });

    expect(status).toBe(400);
    expect(body.error).toBeDefined();
  });

  it("returns 400 when message is only whitespace", async () => {
    const { status, body } = await postJSON({ message: "   " });

    expect(status).toBe(400);
    expect(body.error).toBeDefined();
  });

  it("returns 502 when classification fails (DeepSeek API error)", async () => {
    mockDeepseekChat.mockRejectedValueOnce(
      new MockDeepSeekError(500, "Internal server error"),
    );

    const { status, body } = await postJSON({ message: "Teste" });

    expect(status).toBe(502);
    expect(body.error).toBeDefined();
    expect((body.error as string)).toContain("classificar");
  });

  it("returns error when the direct task DeepSeek call fails", async () => {
    // Classification succeeds
    mockDeepseekChat.mockResolvedValueOnce(
      makeChatResult("task_without_reading"),
    );
    // Direct answer fails
    mockDeepseekChat.mockRejectedValueOnce(
      new MockDeepSeekError(429, "Rate limit exceeded"),
    );

    const { status, body } = await postJSON({
      message: "Gere um codigo complexo",
    });

    expect(status).toBe(429);
    expect(body.error).toBeDefined();
    expect((body.error as string)).toContain("Rate limit exceeded");
  });

  it("streams an error event when the ReAct loop encounters a DeepSeek error mid-stream", async () => {
    mockDeepseekChat.mockResolvedValueOnce(
      makeChatResult("task_with_reading"),
    );

    // Reasoner throws
    mockDeepseekReasoner.mockRejectedValueOnce(
      new MockDeepSeekError(503, "Service unavailable"),
    );

    const response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Investigue o bug." }),
    });

    const { events, sawDone } = await readSSEStream(response);

    expect(sawDone).toBe(true);

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    expect((errorEvent as Record<string, unknown>).message).toContain(
      "Service unavailable",
    );
  });
});

describe("POST /api/chat — classification fallback", () => {
  it("falls back to task_without_reading for ambiguous labels", async () => {
    // Classification returns an unexpected label
    mockDeepseekChat.mockResolvedValueOnce(
      makeChatResult("  some weird label "),
    );
    // Direct answer
    mockDeepseekChat.mockResolvedValueOnce(
      makeChatResult("Resposta para o label ambiguo."),
    );

    const { status, body } = await postJSON({
      message: "Algo inesperado acontece",
    });

    expect(status).toBe(200);
    expect(body.mode).toBe("task");
    expect(body.type).toBe("direct");
    expect(body.answer).toBe("Resposta para o label ambiguo.");
  });
});
