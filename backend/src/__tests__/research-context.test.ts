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

// A spy, so a test can prove the optional-sources path never re-reads the store.
const listSourcesMock = vi.fn(async () => sources.value);

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
  return { ...actual, listSources: listSourcesMock };
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

  it("does not re-read the materials when the caller passes them", async () => {
    sources.value = [];
    conversation.value = conversationWith([]);
    listSourcesMock.mockClear();

    const block = await buildResearchContext(CONV, [repoSource()]);

    expect(block).toContain("1. Um repo (repo — https://exemplo.test/repo)");
    expect(listSourcesMock).not.toHaveBeenCalled();
  });

  it("lays the sections out in order: title, materials, latest turns", async () => {
    sources.value = [repoSource()];
    conversation.value = conversationWith([message("user", "oi", 1)]);

    const block = await buildResearchContext(CONV);

    const title = block.indexOf("# Contexto da conversa");
    const materials = block.indexOf("## Materiais");
    const turns = block.indexOf("## Ultimos momentos da conversa (mais recentes primeiro)");
    expect(title).toBe(0);
    expect(materials).toBeGreaterThan(title);
    expect(turns).toBeGreaterThan(materials);
  });

  it("labels a tool turn with content as ferramenta, like the user sees it", async () => {
    sources.value = [];
    conversation.value = conversationWith([
      message("user", "leia o arquivo", 1),
      { id: "m2", role: "tool", content: "resultado da leitura: 42", timestamp: "2026-01-01T00:00:02.000Z" },
      message("assistant", "encontrei 42", 3),
    ]);

    const block = await buildResearchContext(CONV);

    expect(block).toContain("ferramenta: resultado da leitura: 42");
    expect(block).toContain("assistente: encontrei 42");
    // Newest first still holds across roles.
    expect(block.indexOf("assistente: encontrei 42")).toBeLessThan(
      block.indexOf("ferramenta: resultado da leitura: 42"),
    );
  });

  it("labels every material kind, and drops the origin when a source has none", async () => {
    sources.value = [
      {
        id: "mat-1",
        kind: "repo",
        label: "Repo local",
        root: "/srv/repo",
        resolved_at: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "mat-2",
        kind: "machine",
        label: "Docs da maquina",
        root: "/srv/machine",
        resolved_at: "2026-01-01T00:00:00.000Z",
      },
    ];
    conversation.value = conversationWith([]);

    const block = await buildResearchContext(CONV);

    // No origin segment on either line — the ` — <origin>` part only exists
    // when the source carries one.
    expect(block).toContain("1. Repo local (repo) — posso ler, procurar e mandar agente");
    expect(block).toContain("2. Docs da maquina (machine) — posso ler, procurar e mandar agente");
    expect(block).not.toContain("— https://");
  });

  it("clips a turn only once it passes 500 characters", async () => {
    sources.value = [];
    conversation.value = conversationWith([
      message("user", "a".repeat(500), 2),
      message("assistant", "b".repeat(501), 1),
    ]);

    const block = await buildResearchContext(CONV);

    // Exactly at the clip limit the turn stays whole; one character past it,
    // the last character gives way to the ellipsis.
    expect(block).toContain(`usuario: ${"a".repeat(500)}`);
    expect(block).toContain(`assistente: ${"b".repeat(499)}…`);
    expect(block).not.toContain(`assistente: ${"b".repeat(500)}`);
  });

  it("treats a transcript of empty turns as having no history", async () => {
    sources.value = [];
    conversation.value = conversationWith([
      { id: "m1", role: "user", content: "", timestamp: "2026-01-01T00:00:01.000Z" },
      { id: "m2", role: "tool", content: null, timestamp: "2026-01-01T00:00:02.000Z" },
    ]);

    const block = await buildResearchContext(CONV);

    expect(block).toContain("A conversa ainda nao tem historico registrado.");
  });

  it("keeps the whole block under the cap when materials eat the transcript budget", async () => {
    sources.value = [repoSource(), markdownSource()];
    // The material lines shrink the transcript's share of the 3 000-character
    // budget; the invariant must hold with the fixed sections in place too.
    const many = Array.from({ length: 80 }, (_, i) =>
      message("user", `turno ${i} ` + "y".repeat(40), i),
    );
    conversation.value = conversationWith(many);

    const block = await buildResearchContext(CONV);

    expect(block.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS);
    expect(block).toContain("[...conversa anterior truncada...]");
    expect(block).toContain("1. Um repo (repo");
  });

  it("lands exactly on the cap when a turn is clipped at the boundary", async () => {
    sources.value = [];
    // No materials, so the fixed sections cost 80 characters and the transcript
    // budget is 2 884. Seven turns of 450 characters each: six fit whole
    // (6 × 460 with their separators), the seventh is clipped to the remaining
    // 124 characters and the marker then fills the budget exactly. Before the
    // separator accounting in `transcript`, the join overflowed the cap by
    // roughly twenty characters — this pins the boundary with zero slack.
    const many = Array.from({ length: 7 }, (_, i) => message("user", "x".repeat(450), i));
    conversation.value = conversationWith(many);

    const block = await buildResearchContext(CONV);

    expect(block.length).toBe(MAX_CONTEXT_CHARS);
    expect(block).toContain("[...conversa anterior truncada...]");
    // The marker is the last thing in the block — the cut happened here.
    expect(block.endsWith("[...conversa anterior truncada...]")).toBe(true);
    // The newest turn survived whole; the oldest was clipped mid-word.
    expect(block).toContain(`usuario: ${"x".repeat(450)}`);
    expect(block).toContain(`usuario: ${"x".repeat(113)}…`);
  });

  it("drops the overflowing turn whole when fewer than 41 characters remain", async () => {
    sources.value = [];
    // Twenty-six turns of 100 characters each cost 26 × 110 with their
    // separators = 2 860 against a transcript budget of 2 884. The twenty-
    // seventh overflows with only 24 characters left — too small for the
    // smallest useful clip (41), so no half-line is emitted: the marker follows
    // the last full turn instead.
    const many = Array.from({ length: 27 }, (_, i) => message("user", "u".repeat(100), i));
    conversation.value = conversationWith(many);

    const block = await buildResearchContext(CONV);

    expect(block).toContain("[...conversa anterior truncada...]");
    expect(block).not.toContain("…");
    expect((block.match(/usuario: /g) ?? []).length).toBe(26);
    expect(block.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS);
    expect(block.length).toBeGreaterThan(MAX_CONTEXT_CHARS - 100);
  });
});
