import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { ToolOutcome } from "../services/tool-executor.js";
import type {
  ClientSecret,
  RealtimeSessionConfig,
  TextCompletion,
} from "../services/openai.js";
import type { ResolvedSource } from "../types/index.js";

const tmpHome = mkdtempSync(join(tmpdir(), "explainer-realtime-tool-"));
process.env.HOME = tmpHome;
delete process.env.OPENAI_API_KEY;

// Only the executor is replaced — `ToolValidationError` stays real, because the
// route branches on `instanceof` and a stubbed class would never match.
let outcome: () => Promise<ToolOutcome> = async () => ({ output: "ok" });

vi.mock("../services/tool-executor.js", async () => {
  const actual = await vi.importActual<typeof import("../services/tool-executor.js")>(
    "../services/tool-executor.js",
  );
  return {
    ...actual,
    executeTool: () => outcome(),
  };
});

// The session config the route handed to OpenAI, and the summariser it paid for
// on the way. Both are stubs so this file never opens a socket: the mint is the
// one route here that talks to two remote services.
let minted: RealtimeSessionConfig | null = null;

/** A stub answer in the shape `completeText` returns — prose plus its usage. */
function completion(text: string): TextCompletion {
  return {
    text,
    usage: { input_tokens: 10, output_tokens: 5 },
    model: "gpt-5.2-mini",
    status: "completed",
    truncated: false,
  };
}

let completeTextImpl: () => Promise<TextCompletion> = async () =>
  completion("resumo escrito pelo modelo");

vi.mock("../services/openai.js", async () => {
  const actual = await vi.importActual<typeof import("../services/openai.js")>(
    "../services/openai.js",
  );
  return {
    ...actual,
    mintRealtimeClientSecret: async (
      session: RealtimeSessionConfig,
    ): Promise<ClientSecret> => {
      minted = session;
      return { value: "ek_test", expires_at: 0, session: {} };
    },
    completeText: () => completeTextImpl(),
  };
});

const material: ResolvedSource = {
  id: "src-1",
  kind: "repo",
  label: "explainer",
  root: "/srv/explainer",
  origin: "/srv/explainer",
  resolved_at: new Date().toISOString(),
};

vi.mock("../services/source-store.js", async () => {
  const actual = await vi.importActual<typeof import("../services/source-store.js")>(
    "../services/source-store.js",
  );
  return {
    ...actual,
    listSources: async () => [material],
  };
});

const express = (await import("express")).default;
const realtimeRouter = (await import("../routes/realtime.js")).default;
const { errorHandler } = await import("../middleware/error-handler.js");
const memory = await import("../services/memory.js");
const { ToolValidationError } = await import("../services/tool-executor.js");
const { ALL_TOOLS } = await import("../tools/index.js");

const app = express();
app.use(express.json());
app.use("/api/realtime", realtimeRouter);
app.use(errorHandler);

const server: Server = app.listen(0);
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}/api/realtime`;

afterAll(() => {
  server.close();
  rmSync(tmpHome, { recursive: true, force: true });
});

let conversationId = randomUUID();

beforeEach(() => {
  conversationId = randomUUID();
  outcome = async () => ({ output: "ok" });
});

async function callTool(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${base}/tool`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversation_id: conversationId, ...body }),
  });
}

/**
 * The route records with `void`, so the write is queued but not awaited before
 * the response. `appendMemoryEvents` serialises per conversation, so a read that
 * queues behind it sees the event.
 */
async function settled(id: string): ReturnType<typeof memory.readMemory> {
  await memory.setMemoryMeta(id, {});
  return memory.readMemory(id);
}

describe("POST /api/realtime/tool", () => {
  it("records the call and its result as one exchange", async () => {
    outcome = async () => ({ output: "O README descreve a arquitetura realtime." });

    const res = await callTool({
      call_id: "call_1",
      name: "read_source_doc",
      arguments: '{"material":"explainer"}',
    });
    expect(res.status).toBe(200);

    const file = await settled(conversationId);
    const [call, result] = file!.events;

    expect(call).toMatchObject({
      kind: "tool_call",
      tool: "read_source_doc",
      arguments: '{"material":"explainer"}',
    });
    expect(result).toMatchObject({
      kind: "tool_result",
      tool: "read_source_doc",
      output: "O README descreve a arquitetura realtime.",
    });
  });

  it("hands the arguments and the output over whole", async () => {
    // The ceilings live in memory.ts (2 000 arguments / 8 000 output). Clipping
    // in the route would lower them for `buildResume` without saying so, so what
    // arrives here has to be the full value up to those ceilings.
    const query = "q".repeat(1_900);
    const long = "o".repeat(7_900);
    outcome = async () => ({ output: long });

    await callTool({
      name: "web_search",
      arguments: JSON.stringify({ query }),
    });

    const file = await settled(conversationId);
    expect(file!.events[0]?.arguments).toContain(query);
    expect(file!.events[1]?.output).toBe(long);
  });

  it("records a failure as what the model was told", async () => {
    outcome = async () => {
      throw new Error("o repositorio sumiu");
    };

    const res = await callTool({ name: "search_source", arguments: "{}" });
    const body = (await res.json()) as { output: string };
    expect(body.output).toContain("A ferramenta falhou");

    // A resumed session has to know the tool failed; recording only successes
    // would leave it believing an answer arrived.
    const file = await settled(conversationId);
    expect(file!.events[1]?.output).toBe(body.output);
  });

  it("records a rejected argument the same way", async () => {
    outcome = async () => {
      throw new ToolValidationError("material precisa ser texto");
    };

    const res = await callTool({ name: "read_source_doc", arguments: "{}" });
    const body = (await res.json()) as { output: string };
    expect(body.output).toContain("Erro de argumentos");

    const file = await settled(conversationId);
    expect(file!.events[1]?.output).toBe(body.output);
  });

  it("normalises non-string arguments before recording them", async () => {
    await callTool({ name: "web_search", arguments: { query: "sandbox" } });

    const file = await settled(conversationId);
    expect(file!.events[0]?.arguments).toBe('{"query":"sandbox"}');
  });

  it("writes nothing when the request never reaches a tool", async () => {
    const res = await fetch(`${base}/tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversation_id: conversationId }),
    });

    expect(res.status).toBe(400);
    expect(await memory.readMemory(conversationId)).toBeNull();
  });
});

describe("POST /api/realtime/session", () => {
  beforeEach(() => {
    minted = null;
    completeTextImpl = async () => completion("resumo escrito pelo modelo");
    // The summariser only runs with a key; nothing here reaches the network,
    // `completeText` is the stub above.
    process.env.OPENAI_API_KEY = "sk-test";
    delete process.env.EXPLAINER_MEMORY_SUMMARY_TIMEOUT_MS;
  });

  afterEach(async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.EXPLAINER_MEMORY_SUMMARY_TIMEOUT_MS;
    // The meta stamp is fired with `void`; letting it land keeps it from
    // arriving after the temp home has been removed.
    await drain();
  });

  async function mint(): Promise<Response> {
    return fetch(`${base}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversation_id: conversationId }),
    });
  }

  /** Let anything the route fired with `void` reach the disk. */
  async function drain(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  it("leaves no memory file behind for a conversation nobody spoke in", async () => {
    const res = await mint();
    expect(res.status).toBe(200);
    expect(((await res.json()) as { resumed: boolean }).resumed).toBe(false);

    await drain();
    // `setMemoryMeta` goes through `mutate`, which creates the file. Stamping it
    // unconditionally gave every conversation that ever connected a memory file
    // with a title, materials and not one event.
    expect(await memory.readMemory(conversationId)).toBeNull();
  });

  it("seeds the instructions from the memory, and stamps the file it found", async () => {
    await memory.appendMemoryEvents(conversationId, [
      { kind: "user", text: "Como o sandbox contem os caminhos?" },
      { kind: "assistant", text: "Ele resolve dentro da raiz." },
    ]);

    const res = await mint();
    const body = (await res.json()) as { resumed: boolean; memory_events: number };

    expect(body.resumed).toBe(true);
    expect(body.memory_events).toBe(2);
    expect(minted?.instructions).toContain("# Memoria desta conversa");
    expect(minted?.instructions).toContain("resumo escrito pelo modelo");

    await drain();
    expect((await memory.readMemory(conversationId))?.materials).toEqual([
      "explainer",
    ]);
  });

  it("does not wait on a slow summariser to open the session", async () => {
    await memory.appendMemoryEvents(conversationId, [
      { kind: "user", text: "primeira pergunta" },
      { kind: "assistant", text: "primeira resposta" },
    ]);

    // A summariser that never answers. `completeText` defaults to a 30 s
    // timeout with no retry, and this is the last thing between "Conectar" and
    // the WebRTC session starting.
    completeTextImpl = () => new Promise<TextCompletion>(() => {});
    process.env.EXPLAINER_MEMORY_SUMMARY_TIMEOUT_MS = "300";

    const started = Date.now();
    const res = await mint();
    const elapsed = Date.now() - started;

    expect(res.status).toBe(200);
    expect(elapsed).toBeLessThan(3_000);
    // The deterministic resume is what seeded the session: free, already built,
    // and the reason the budget costs nothing to spend.
    expect(minted?.instructions).toContain("Últimos turnos da conversa");
    expect(minted?.instructions).toContain("primeira resposta");
    expect(((await res.json()) as { resumed: boolean }).resumed).toBe(true);
  });

  it("still opens the session when the summariser fails outright", async () => {
    await memory.appendMemoryEvents(conversationId, [
      { kind: "user", text: "algo dito" },
    ]);
    completeTextImpl = async () => {
      throw new Error("502 do gateway");
    };

    const res = await mint();
    expect(res.status).toBe(200);
    expect(minted?.instructions).toContain("# Memoria desta conversa");
  });

  it("describes in the instructions only the tools it minted the session with", async () => {
    const res = await mint();
    const body = (await res.json()) as { tools: string[] };

    expect(minted?.tools).toHaveLength(body.tools.length);
    for (const tool of ALL_TOOLS) {
      if (body.tools.includes(tool.name)) continue;
      expect(
        new RegExp(`(?<!\\w)${tool.name}(?!\\w)`).test(minted?.instructions ?? ""),
        `${tool.name} described but not offered`,
      ).toBe(false);
    }
  });
});
