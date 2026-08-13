import { describe, it, expect, vi, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Conversation, Message, ResolvedSource } from "../types/index.js";

// storage.ts imports sandbox.ts, which freezes homedir()-derived roots at
// module load — HOME first, imports after, the same technique as storage.test.ts.
const tmpHome = mkdtempSync(join(tmpdir(), "explainer-research-context-"));
process.env.HOME = tmpHome;

// Only the disk half is stubbed; the module bodies stay real so the imports
// behave exactly like they do in the executor.
const conversation = { value: null as Conversation | null };
const sources = { value: [] as ResolvedSource[] };

vi.mock("../services/storage.js", async () => {
  const actual = await vi.importActual<typeof import("../services/storage.js")>(
    "../services/storage.js",
  );
  return { ...actual, getConversation: async () => conversation.value };
});

vi.mock("../services/source-store.js", async () => {
  const actual = await vi.importActual<typeof import("../services/source-store.js")>(
    "../services/source-store.js",
  );
  return { ...actual, listSources: async () => sources.value };
});

const { buildResearchContext, MAX_CONTEXT_CHARS } = await import(
  "../services/research-context.js"
);

const CONV = "550e8400-e29b-41d4-a716-446655440000";

function message(role: Message["role"], content: string, index: number): Message {
  return {
    id: `m${index}`,
    role,
    content,
    timestamp: `2026-01-01T00:00:0${index % 10}.000Z`,
  };
}

function conversationWith(messages: Message[]): Conversation {
  return {
    id: CONV,
    title: "Uma conversa",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    messages,
    attachments: [],
  };
}

function repoSource(): ResolvedSource {
  return {
    id: "mat-1",
    kind: "repo",
    label: "Um repo",
    root: "/tmp",
    origin: "https://exemplo.test/repo",
    resolved_at: "2026-01-01T00:00:00.000Z",
  };
}

function markdownSource(): ResolvedSource {
  return {
    id: "mat-2",
    kind: "markdown",
    label: "Notas",
    resolved_at: "2026-01-01T00:00:00.000Z",
  };
}

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("buildResearchContext", () => {
  it("describes the materials the way the model sees them", async () => {
    sources.value = [repoSource(), markdownSource()];
    conversation.value = conversationWith([]);

    const block = await buildResearchContext(CONV);

    expect(block).toContain("# Contexto da conversa");
    expect(block).toContain("1. Um repo (repo — https://exemplo.test/repo) — posso ler, procurar e mandar agente");
    expect(block).toContain("2. Notas (markdown) — posso ler o documento");
  });

  it("lists the turns most recent first", async () => {
    sources.value = [];
    conversation.value = conversationWith([
      message("user", "primeira pergunta", 1),
      message("assistant", "primeira resposta", 2),
      message("user", "pergunta mais recente", 3),
    ]);

    const block = await buildResearchContext(CONV);

    const newest = block.indexOf("pergunta mais recente");
    const older = block.indexOf("primeira pergunta");
    expect(newest).toBeGreaterThan(-1);
    expect(older).toBeGreaterThan(-1);
    expect(newest).toBeLessThan(older);
    expect(block).toContain("usuario: pergunta mais recente");
    expect(block).toContain("assistente: primeira resposta");
  });

  it("skips turns that carry no text", async () => {
    sources.value = [];
    conversation.value = conversationWith([
      message("user", "algo util", 1),
      { id: "m2", role: "tool", content: null, timestamp: "2026-01-01T00:00:02.000Z" },
      { id: "m3", role: "assistant", content: "", timestamp: "2026-01-01T00:00:03.000Z" },
    ]);

    const block = await buildResearchContext(CONV);

    expect(block).toContain("algo util");
    expect(block).not.toContain("ferramenta:");
    expect(block).not.toContain("assistente: ");
  });

  it("truncates the transcript with the marker and keeps the newest turns", async () => {
    sources.value = [];
    // Enough turns to blow well past the budget: ~3 500 characters of turns
    // against a transcript budget of ~2 800.
    const many = Array.from({ length: 60 }, (_, i) =>
      message("user", `turno de teste numero ${i} `.repeat(5).trim(), i),
    );
    conversation.value = conversationWith(many);

    const block = await buildResearchContext(CONV);

    expect(block.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS);
    expect(block).toContain("[...conversa anterior truncada...]");
    // The newest turn survived; an early one was cut.
    expect(block).toContain("turno de teste numero 59");
    expect(block).not.toContain("turno de teste numero 0");
  });

  it("clips one very long turn instead of letting it eat the transcript", async () => {
    sources.value = [];
    conversation.value = conversationWith([
      message("user", "z".repeat(4_000), 1),
      message("assistant", "resposta curta", 2),
    ]);

    const block = await buildResearchContext(CONV);

    expect(block).toContain("resposta curta");
    // The long turn was clipped to a single line's worth, not pasted whole.
    // The transcript is newest first, so the old long turn sits after the
    // short answer, before the truncation marker.
    const start = block.indexOf("usuario: z");
    const end = block.indexOf("[...conversa anterior truncada...]", start);
    const longTurn = end > start ? block.slice(start, end) : block.slice(start);
    expect(longTurn.length).toBeLessThan(1_000);
    expect(longTurn.endsWith("…")).toBe(true);
  });

  it("says there is no history when the conversation has none", async () => {
    sources.value = [];
    conversation.value = conversationWith([]);

    const block = await buildResearchContext(CONV);

    expect(block).toContain("A conversa ainda nao tem historico registrado.");
    expect(block).not.toContain("truncada");
  });

  it("handles a missing conversation like an empty one", async () => {
    sources.value = [];
    conversation.value = null;

    const block = await buildResearchContext(CONV);

    expect(block).toContain("A conversa ainda nao tem historico registrado.");
  });

  it("resolves the materials itself when the caller does not pass them", async () => {
    sources.value = [repoSource()];
    conversation.value = conversationWith([]);

    const block = await buildResearchContext(CONV);

    expect(block).toContain("1. Um repo (repo — https://exemplo.test/repo)");
  });
});
