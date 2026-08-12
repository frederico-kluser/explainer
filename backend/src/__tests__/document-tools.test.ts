import { describe, it, expect, vi, beforeEach } from "vitest";

// The document is one file per conversation on disk. What is under test here is
// the editing, so the file is a string in memory; `document-store.test.ts`
// territory — the lock, the atomic write, the truncation — is untouched.
const disk = { content: null as string | null };
const broadcasts: Array<{ content: string; source: string }> = [];

vi.mock("../services/document-store.js", () => ({
  readDocument: async () => disk.content,
  writeDocument: async (_id: string, content: string) => {
    disk.content = content;
    return content;
  },
  appendDocument: async (_id: string, content: string) => {
    disk.content = disk.content ? `${disk.content}\n\n${content}` : content;
    return disk.content;
  },
  updateDocument: async (
    _id: string,
    transform: (current: string | null) => string,
  ) => {
    disk.content = transform(disk.content);
    return disk.content;
  },
  deleteDocument: async () => {
    disk.content = null;
  },
  DOCUMENT_MAX_CHARS: 100_000,
}));

vi.mock("../services/conversation-bus.js", () => ({
  noteDocumentChanged: (_id: string, content: string, source: string) => {
    broadcasts.push({ content, source });
  },
}));

// The executor reaches for the conversation's materials and its mode; neither
// exists on disk in this suite, and the mode that matters here is the default.
vi.mock("../services/source-store.js", async () => {
  const actual = await vi.importActual<typeof import("../services/source-store.js")>(
    "../services/source-store.js",
  );
  return { ...actual, listSources: async () => [] };
});

vi.mock("../services/storage.js", () => ({
  getConversation: async () => null,
  updateConversation: async () => ({}),
}));

const {
  runAppendDocument,
  runEditDocumentSection,
  runReadDocument,
  runWriteDocument,
} = await import("../tools/document-tools.js");
const { executeTool } = await import("../services/tool-executor.js");

const CONV = "550e8400-e29b-41d4-a716-446655440000";

const GUIDE = `# Roteiro

## O básico

- **Público:** engenheiros

## Slides

### Slide 1 — a abertura

- **Na tela:** o gráfico

### Slide 2 — a demo

- **Na tela:** o terminal

## Ficou de fora

- o comparativo de preços
`;

beforeEach(() => {
  disk.content = GUIDE;
  broadcasts.length = 0;
});

describe("edit_document_section", () => {
  it("replaces one section and leaves every other byte alone", async () => {
    const before = disk.content!;
    await runEditDocumentSection(
      {
        section: "Slide 1 — a abertura",
        content: "### Slide 1 — a abertura\n\n- **Na tela:** uma foto",
      },
      CONV,
    );

    expect(disk.content).toContain("- **Na tela:** uma foto");
    expect(disk.content).not.toContain("- **Na tela:** o gráfico");
    // Its neighbours, its parent and the sections after it are untouched.
    expect(disk.content).toContain("### Slide 2 — a demo");
    expect(disk.content).toContain("- **Público:** engenheiros");
    expect(disk.content).toContain("- o comparativo de preços");
    expect(disk.content).not.toBe(before);
  });

  it("takes the subsections with it when the section owns them", async () => {
    // Replacing "## Slides" means replacing the slides, not orphaning them
    // under a heading that no longer describes them.
    await runEditDocumentSection(
      { section: "Slides", content: "## Slides\n\n_Reescrevendo do zero._" },
      CONV,
    );

    expect(disk.content).toContain("_Reescrevendo do zero._");
    expect(disk.content).not.toContain("Slide 1");
    expect(disk.content).not.toContain("Slide 2");
    expect(disk.content).toContain("## Ficou de fora");
  });

  it("matches the heading the way a model writes it back", async () => {
    // Level and case are what the model gets wrong first, long before it gets
    // the words wrong.
    const outcome = await runEditDocumentSection(
      { section: "## ficou de fora", content: "## Ficou de fora\n\n- nada" },
      CONV,
    );

    expect(outcome.output).toContain("atualizada");
    expect(disk.content).toContain("- nada");
    expect(disk.content).not.toContain("- o comparativo de preços");
  });

  it("creates a section it cannot find instead of refusing the edit", async () => {
    const outcome = await runEditDocumentSection(
      { section: "Slide 9 — o fechamento", content: "### Slide 9 — o fechamento\n\n- **Tempo:** 30s" },
      CONV,
    );

    // A refusal here is how a refinement turn ends with nothing written at all.
    expect(outcome.output).toContain("criada no fim");
    expect(disk.content).toContain("### Slide 9 — o fechamento");
    expect(disk.content).toContain("## Ficou de fora");
  });

  it("creates the document when there is none yet", async () => {
    disk.content = null;
    await runEditDocumentSection(
      { section: "Slides", content: "## Slides\n\n- nenhum ainda" },
      CONV,
    );

    expect(disk.content).toBe("## Slides\n\n- nenhum ainda");
  });

  it("broadcasts the stored text so the other screen follows", async () => {
    await runEditDocumentSection(
      { section: "Slides", content: "## Slides\n\n- um" },
      CONV,
    );

    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]!.source).toBe("assistant");
    expect(broadcasts[0]!.content).toBe(disk.content);
  });
});

describe("the other three", () => {
  it("reads a single section when asked for one", async () => {
    const outcome = await runReadDocument({ section: "Slide 2 — a demo" }, CONV);
    expect(outcome.output).toContain("o terminal");
    expect(outcome.output).not.toContain("o gráfico");
  });

  it("says so rather than guessing when the section is not there", async () => {
    const outcome = await runReadDocument({ section: "Orçamento" }, CONV);
    expect(outcome.output).toContain("Nao achei");
  });

  it("never speaks the document back on a write", async () => {
    // Every `output` is read out loud. A confirmation that echoed the markdown
    // would have the assistant reciting a heading tree.
    const written = await runWriteDocument({ content: GUIDE }, CONV);
    const appended = await runAppendDocument({ content: "## Extra" }, CONV);

    expect(written.output).toBe("Documento atualizado.");
    expect(appended.output).toBe("Trecho adicionado ao documento.");
  });
});

describe("the executor", () => {
  it("runs the document tools on a conversation with no material", async () => {
    // The document belongs to the conversation, not to a material — and a mode
    // that opens the microphone with nothing attached would otherwise be told
    // to go and add a repository, out loud, on its first turn.
    const outcome = await executeTool(
      "edit_document_section",
      JSON.stringify({ section: "Slides", content: "## Slides\n\n- um" }),
      CONV,
    );

    expect(outcome.output).toContain("atualizada");
    expect(disk.content).toContain("- um");
  });

  it("hands a malformed edit back as a sentence, not as a throw", async () => {
    // A throw here derails the spoken turn; a sentence lets the model correct
    // itself and try again.
    const outcome = await executeTool(
      "edit_document_section",
      JSON.stringify({ section: "Slides" }),
      CONV,
    );

    expect(outcome.output).toContain("content");
    expect(disk.content).toBe(GUIDE);
  });
});
