import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ResolvedSource } from "../types/index.js";

// The store reads and writes conversation JSON on disk; the executor's job is
// routing, so the source is injected instead of persisted.
const currentSource = { value: null as ResolvedSource | null };

vi.mock("../services/source-store.js", async () => {
  // pickSource is pure resolution logic worth exercising for real; only the
  // storage half is stubbed.
  const actual = await vi.importActual<typeof import("../services/source-store.js")>(
    "../services/source-store.js",
  );
  return {
    ...actual,
    listSources: async () =>
      currentSource.value ? [currentSource.value] : [],
    addSource: async () => [],
    removeSource: async () => [],
    forgetSources: () => {},
  };
});

const { parseToolArguments, executeTool, ToolValidationError } = await import(
  "../services/tool-executor.js"
);

const CONV = "550e8400-e29b-41d4-a716-446655440000";

function markdownSource(): ResolvedSource {
  return {
    id: "mat-1",
    kind: "markdown",
    label: "Um documento",
    primary_doc: "# Um documento\n\nConteudo de teste.",
    resolved_at: new Date().toISOString(),
  };
}

beforeEach(() => {
  currentSource.value = null;
});

describe("parseToolArguments", () => {
  it("parses valid JSON object", () => {
    expect(parseToolArguments('{"key": "value"}')).toEqual({ key: "value" });
  });

  it("returns empty object for empty and whitespace-only strings", () => {
    expect(parseToolArguments("")).toEqual({});
    expect(parseToolArguments("   ")).toEqual({});
  });

  it("throws ToolValidationError for invalid JSON", () => {
    expect(() => parseToolArguments("not json")).toThrow(ToolValidationError);
    expect(() => parseToolArguments("not json")).toThrow(/not valid JSON/);
  });

  it("throws ToolValidationError for arrays and null", () => {
    expect(() => parseToolArguments("[1, 2, 3]")).toThrow(/must be a JSON object/);
    expect(() => parseToolArguments("null")).toThrow(ToolValidationError);
  });
});

describe("executeTool", () => {
  it("tells the model to add a material when the conversation has none", async () => {
    const result = await executeTool("web_search", '{"query":"oi"}', CONV);
    expect(result.output).toMatch(/Nenhum material/i);
  });

  it("refuses a tool the current source does not grant", async () => {
    currentSource.value = markdownSource();

    // A free markdown document has no tree behind it, so grepping it is not on
    // the menu — and the model has to be told that in words it can act on.
    const result = await executeTool("search_source", '{"query":"foo"}', CONV);
    expect(result.output).toMatch(/nao esta disponivel/i);
    expect(result.output).toContain("web_search");
  });

  it("reads the anchor document of a markdown source", async () => {
    currentSource.value = markdownSource();

    const result = await executeTool("read_source_doc", "", CONV);
    expect(result.output).toContain("Conteudo de teste");
  });

  it("rejects arguments of the wrong shape", async () => {
    currentSource.value = markdownSource();

    await expect(executeTool("read_source_doc", "[]", CONV)).rejects.toThrow(
      ToolValidationError,
    );
  });

  it("throws for an unknown tool name", async () => {
    currentSource.value = { ...markdownSource(), kind: "repo", root: "/tmp" };

    // Unknown names are filtered by the per-source allowlist before they reach
    // the switch, so this surfaces as a refusal rather than a throw.
    const result = await executeTool("rm_rf", "{}", CONV);
    expect(result.output).toMatch(/nao esta disponivel/i);
  });
});
