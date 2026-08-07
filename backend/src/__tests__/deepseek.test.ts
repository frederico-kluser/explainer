import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  deepseekChat,
  deepseekChatStream,
  deepseekReasoner,
  DeepSeekError,
} from "../services/deepseek.js";
import { addCost } from "../services/costs.js";
import { priceTextResponse, ratesFor } from "../services/pricing.js";

// Mock addCost so tests don't touch the storage layer.
vi.mock("../services/costs.js", () => ({
  addCost: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  process.env.DEEPSEEK_API_KEY = "sk-test-key";
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockFetch(status: number, body: unknown) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as Response);
}

function makeChatResponse(overrides?: Partial<{
  content: string;
  prompt_tokens: number;
  completion_tokens: number;
}>) {
  return {
    id: "chatcmpl-abc123",
    object: "chat.completion",
    created: Date.now(),
    model: "deepseek-chat",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: overrides?.content ?? "Olá! Como posso ajudar?",
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: overrides?.prompt_tokens ?? 100,
      completion_tokens: overrides?.completion_tokens ?? 50,
      total_tokens: (overrides?.prompt_tokens ?? 100) + (overrides?.completion_tokens ?? 50),
    },
  };
}

function makeReasonerResponse(overrides?: Partial<{
  content: string;
  reasoning: string;
  toolCalls: Array<{
    id: string;
    name: string;
    arguments: string;
  }>;
}>) {
  const message: Record<string, unknown> = {
    role: "assistant",
    content: overrides?.content ?? "Resposta após raciocínio.",
  };
  if (overrides?.reasoning) {
    message.reasoning_content = overrides.reasoning;
  }
  if (overrides?.toolCalls) {
    message.tool_calls = overrides.toolCalls.map((tc) => ({
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: tc.arguments },
    }));
  }

  return {
    id: "chatcmpl-def456",
    object: "chat.completion",
    created: Date.now(),
    model: "deepseek-reasoner",
    choices: [{ index: 0, message, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 200,
      completion_tokens: 300,
      total_tokens: 500,
    },
  };
}

// ---------------------------------------------------------------------------
// deepseekChat
// ---------------------------------------------------------------------------

describe("deepseekChat", () => {
  it("returns the assistant message on success", async () => {
    mockFetch(200, makeChatResponse({ content: "Olá!" }));

    const result = await deepseekChat([
      { role: "user", content: "Oi" },
    ]);

    expect(result.message.content).toBe("Olá!");
    expect(result.finishReason).toBe("stop");
    expect(result.model).toBe("deepseek-chat");
  });

  it("sends the configured model and options", async () => {
    const fetchSpy = mockFetch(200, makeChatResponse());

    await deepseekChat(
      [{ role: "user", content: "Oi" }],
      { model: "deepseek-chat", max_tokens: 512, temperature: 0.3 },
    );

    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
    expect(body.model).toBe("deepseek-chat");
    expect(body.max_tokens).toBe(512);
    expect(body.temperature).toBe(0.3);
  });

  it("throws DeepSeekError on a non-2xx response", async () => {
    mockFetch(400, { error: { message: "Invalid request" } });

    await expect(
      deepseekChat([{ role: "user", content: "Oi" }]),
    ).rejects.toThrow(DeepSeekError);
  });

  it("retries once on a 5xx error then succeeds", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => JSON.stringify({ error: { message: "Service Unavailable" } }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(makeChatResponse({ content: "Retry worked" })),
      } as Response);

    const result = await deepseekChat([{ role: "user", content: "Oi" }]);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.message.content).toBe("Retry worked");
  });

  it("throws after exhausting the retry on 5xx", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => JSON.stringify({ error: { message: "Fail 1" } }),
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => JSON.stringify({ error: { message: "Fail 2" } }),
      } as Response);

    await expect(
      deepseekChat([{ role: "user", content: "Oi" }]),
    ).rejects.toThrow(DeepSeekError);
  });

  it("does not retry on 4xx errors", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ error: { message: "Unauthorized" } }),
      } as Response)
      .mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(makeChatResponse()),
      } as Response);

    await expect(
      deepseekChat([{ role: "user", content: "Oi" }]),
    ).rejects.toThrow(DeepSeekError);

    // Only one attempt — no retry for 4xx.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("throws when DEEPSEEK_API_KEY is not set", async () => {
    delete process.env.DEEPSEEK_API_KEY;

    await expect(
      deepseekChat([{ role: "user", content: "Oi" }]),
    ).rejects.toThrow(DeepSeekError);
  });
});

// ---------------------------------------------------------------------------
// deepseekChatStream
// ---------------------------------------------------------------------------

describe("deepseekChatStream", () => {
  function mockStreamFetch(chunks: string[]) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      body: stream,
    } as Response);
  }

  it("yields chunks as they arrive", async () => {
    mockStreamFetch([
      'data: {"choices":[{"delta":{"content":"Ol"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"content":"á"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"content":"!"},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ]);

    const chunks: string[] = [];
    for await (const chunk of deepseekChatStream([
      { role: "user", content: "Oi" },
    ])) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) chunks.push(content);
    }

    expect(chunks.join("")).toBe("Olá!");
  });

  it("handles a stream that ends without [DONE]", async () => {
    mockStreamFetch([
      'data: {"choices":[{"delta":{"content":"X"},"finish_reason":"stop"}]}\n\n',
    ]);

    const chunks: string[] = [];
    for await (const chunk of deepseekChatStream([
      { role: "user", content: "Oi" },
    ])) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) chunks.push(content);
    }

    expect(chunks.join("")).toBe("X");
  });

  it("records cost when the stream ends with [DONE] and carries usage tokens", async () => {
    vi.mocked(addCost).mockResolvedValue(undefined);
    mockStreamFetch([
      'data: {"choices":[{"delta":{"content":"Ol"},"finish_reason":null}],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n',
      'data: [DONE]\n\n',
    ]);

    const chunks = [];
    for await (const chunk of deepseekChatStream([
      { role: "user", content: "Oi" },
    ])) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) chunks.push(content);
    }

    expect(chunks.join("")).toBe("Ol");
    expect(addCost).toHaveBeenCalled();
  });

  it("throws on a non-ok stream response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => JSON.stringify({ error: { message: "Rate limited" } }),
    } as Response);

    await expect(async () => {
      const gen = deepseekChatStream([
        { role: "user", content: "Oi" },
      ]);
      await gen.next();
    }).rejects.toThrow(DeepSeekError);
  });
});

// ---------------------------------------------------------------------------
// deepseekReasoner
// ---------------------------------------------------------------------------

describe("deepseekReasoner", () => {
  it("returns the message including reasoning_content", async () => {
    mockFetch(
      200,
      makeReasonerResponse({
        content: "Resposta final.",
        reasoning: "Pensando passo a passo...",
      }),
    );

    const result = await deepseekReasoner([
      { role: "user", content: "Quanto é 2+2?" },
    ]);

    expect(result.message.content).toBe("Resposta final.");
    expect(result.message.reasoning_content).toBe("Pensando passo a passo...");
    expect(result.model).toBe("deepseek-reasoner");
  });

  it("includes tools in the request when provided", async () => {
    const fetchSpy = mockFetch(200, makeReasonerResponse());

    await deepseekReasoner(
      [{ role: "user", content: "Busque o clima" }],
      [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get the weather",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
    );

    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].function.name).toBe("get_weather");
  });

  it("returns tool_calls when the model requests them", async () => {
    mockFetch(
      200,
      makeReasonerResponse({
        content: "",
        toolCalls: [
          {
            id: "call_1",
            name: "get_weather",
            arguments: '{"city":"São Paulo"}',
          },
        ],
      }),
    );

    const result = await deepseekReasoner([
      { role: "user", content: "Como está o clima em SP?" },
    ]);

    expect(result.message.tool_calls).toHaveLength(1);
    expect(result.message.tool_calls![0]!.function.name).toBe("get_weather");
  });

  it("uses the reasoner defaults (model, max_tokens)", async () => {
    const fetchSpy = mockFetch(200, makeReasonerResponse());

    await deepseekReasoner([{ role: "user", content: "Oi" }]);

    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
    expect(body.model).toBe("deepseek-reasoner");
    expect(body.max_tokens).toBe(8192);
  });

  it("throws on network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(
      deepseekReasoner([{ role: "user", content: "Oi" }]),
    ).rejects.toThrow(DeepSeekError);
  });
});

// ---------------------------------------------------------------------------
// Pricing integration
// ---------------------------------------------------------------------------

describe("DeepSeek pricing", () => {
  it("ratesFor resolves deepseek-chat", () => {
    const rates = ratesFor("deepseek-chat");
    expect(rates).not.toBeNull();
    expect(rates!.text.input).toBe(0.27);
    expect(rates!.text.output).toBe(1.1);
  });

  it("ratesFor resolves deepseek-reasoner", () => {
    const rates = ratesFor("deepseek-reasoner");
    expect(rates).not.toBeNull();
    expect(rates!.text.input).toBe(0.55);
    expect(rates!.text.output).toBe(2.19);
  });

  it("priceTextResponse calculates deepseek-chat cost correctly", () => {
    // 1M input @ $0.27 + 1M output @ $1.10 = $1.37
    const usd = priceTextResponse("deepseek-chat", {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    });
    expect(usd).toBeCloseTo(1.37, 6);
  });

  it("priceTextResponse calculates deepseek-reasoner cost correctly", () => {
    // 1M input @ $0.55 + 1M output @ $2.19 = $2.74
    const usd = priceTextResponse("deepseek-reasoner", {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    });
    expect(usd).toBeCloseTo(2.74, 6);
  });

  it("priceTextResponse returns 0 for unknown deepseek model", () => {
    const usd = priceTextResponse("deepseek-imaginary", {
      input_tokens: 100,
      output_tokens: 50,
    });
    expect(usd).toBe(0);
  });
});
