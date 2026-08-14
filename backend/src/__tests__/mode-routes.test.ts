import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { ClientSecret, RealtimeSessionConfig } from "../services/openai.js";
import type { ResolvedSource } from "../types/index.js";

// `sandbox.ts` freezes its roots from `homedir()` at module load, so the temp
// HOME has to be in place before the first app import below.
const tmpHome = mkdtempSync(join(tmpdir(), "explainer-modes-"));
process.env.HOME = tmpHome;
delete process.env.OPENAI_API_KEY;

let minted: RealtimeSessionConfig | null = null;

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
  };
});

// What the conversation is pointed at, swapped per case. The store itself is
// not under test here.
const materials: { value: ResolvedSource[] } = { value: [] };

vi.mock("../services/source-store.js", async () => {
  const actual = await vi.importActual<typeof import("../services/source-store.js")>(
    "../services/source-store.js",
  );
  return { ...actual, listSources: async () => materials.value };
});

const express = (await import("express")).default;
const conversationsRouter = (await import("../routes/conversations.js")).default;
const documentRouter = (await import("../routes/document.js")).default;
const modesRouter = (await import("../routes/modes.js")).default;
const realtimeRouter = (await import("../routes/realtime.js")).default;
const { errorHandler } = await import("../middleware/error-handler.js");
const { getConversationMode } = await import("../services/conversation-mode.js");

const app = express();
app.use(express.json());
app.use("/api/conversations", conversationsRouter);
app.use("/api/conversations", documentRouter);
app.use("/api/modes", modesRouter);
app.use("/api/realtime", realtimeRouter);
app.use(errorHandler);

const server: Server = app.listen(0);
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}/api`;

afterAll(() => {
  server.close();
  rmSync(tmpHome, { recursive: true, force: true });
});

beforeEach(() => {
  materials.value = [];
  minted = null;
});

async function createConversation(mode?: string): Promise<{ id: string; metadata?: Record<string, unknown> }> {
  const response = await fetch(`${base}/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Nova conversa", ...(mode ? { mode } : {}) }),
  });
  expect(response.status).toBe(201);
  return response.json() as Promise<{ id: string; metadata?: Record<string, unknown> }>;
}

describe("GET /api/modes", () => {
  it("lists the modes and names the default", async () => {
    const response = await fetch(`${base}/modes`);
    const body = (await response.json()) as {
      modes: Array<{ id: string; document: unknown }>;
      default: string;
    };

    expect(response.status).toBe(200);
    expect(body.modes.map((mode) => mode.id)).toContain("presentation");
    expect(body.modes.map((mode) => mode.id)).toContain("research");
    expect(body.modes.some((mode) => mode.id === body.default)).toBe(true);
    expect(body.default).toBe("conversation");
  });
});

describe("the mode of a conversation", () => {
  it("is recorded at creation and laid down as a document", async () => {
    const created = await createConversation("presentation");
    expect(created.metadata?.mode).toBe("presentation");
    expect((await getConversationMode(created.id)).id).toBe("presentation");

    // The skeleton is on disk before a word is spoken: an empty pane on a
    // presentation conversation reads as the feature being missing.
    const document = await fetch(`${base}/conversations/${created.id}/document`);
    expect(document.status).toBe(200);
    const body = (await document.json()) as { content: string };
    expect(body.content).toContain("# Roteiro da apresentação");
    expect(body.content).toContain("A ideia única");
  });

  it("falls back to the default instead of failing the create", async () => {
    const created = await createConversation("modo-que-nao-existe");
    expect((await getConversationMode(created.id)).id).toBe("conversation");
  });

  it("cannot be changed by a PATCH", async () => {
    // The mode is frozen into the session token along with the instructions and
    // the tool list, so a conversation that changed it mid-call would be a
    // screen and a model disagreeing about what the call is for.
    const created = await createConversation("presentation");

    const response = await fetch(`${base}/conversations/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ metadata: { mode: "conversation" } }),
    });

    expect(response.status).toBe(200);
    expect((await getConversationMode(created.id)).id).toBe("presentation");
  });
});

describe("POST /api/realtime/session and the material gate", () => {
  it("refuses a mode that needs a material and has none", async () => {
    const created = await createConversation("conversation");

    const response = await fetch(`${base}/realtime/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversation_id: created.id }),
    });

    expect(response.status).toBe(409);
    expect(minted).toBeNull();
  });

  it("opens a presentation on an empty conversation", async () => {
    const created = await createConversation("presentation");

    const response = await fetch(`${base}/realtime/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversation_id: created.id }),
    });

    expect(response.status).toBe(200);
    expect(minted).not.toBeNull();

    // Minted with the mode's own instructions and its own tools, not with the
    // default ones.
    expect(minted!.instructions).toContain("diretor de apresentacoes");
    expect(minted!.instructions).not.toContain("Nenhum material foi adicionado ainda");

    // `RealtimeSessionConfig.tools` is `unknown[]` — the wire shape is the
    // Realtime API's, not ours — so the names are read back deliberately rather
    // than assumed.
    const offered = (minted!.tools ?? []).map(
      (tool) => (tool as { name?: string }).name,
    );
    expect(offered).toContain("edit_document_section");
  });
});

describe("the research conversation", () => {
  it("lays the html-explainer shell down as its document", async () => {
    const created = await createConversation("research");

    const document = await fetch(`${base}/conversations/${created.id}/document`);
    expect(document.status).toBe(200);
    const body = (await document.json()) as { content: string };

    // The document is born as the html-explainer shell, not as markdown: the
    // sidebar has to render the tabbed file the model is told to preserve.
    expect(body.content).toContain("<!doctype html>");
    expect(body.content).toContain('data-bs-theme="dark"');
    expect(body.content).toContain('id="tab-resumo"');
    expect(body.content).toContain('id="pane-resumo"');
  });

  it("opens the microphone with nothing attached", async () => {
    const created = await createConversation("research");

    const response = await fetch(`${base}/realtime/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversation_id: created.id }),
    });

    // The 409 gate is per-mode: research starts at a topic, so the empty
    // conversation mints like the presentation one does.
    expect(response.status).toBe(200);
    expect(minted).not.toBeNull();
    expect(minted!.instructions).toContain("pesquisador de voz");
    expect(minted!.instructions).toContain("PARALELIZE");
    expect(minted!.instructions).not.toContain("Nenhum material foi adicionado ainda");

    // Minted with the mode's own tools, not with the default ones.
    const offered = (minted!.tools ?? []).map(
      (tool) => (tool as { name?: string }).name,
    );
    expect(offered).toContain("web_search");
    expect(offered).toContain("check_web_search");
    expect(offered).toContain("write_document");
  });
});
