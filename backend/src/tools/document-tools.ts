// === Document tool implementations ===
//
// The three tools that let the model read and write the conversation's
// collaborative markdown document. Every `output` returned here is read aloud,
// so content goes through `spoken()`-like guards: write/append return short
// pt-BR confirmations; only read carries the actual text.

import {
  readDocument,
  writeDocument,
  appendDocument,
  updateDocument,
} from "../services/document-store.js";
import { noteDocumentChanged } from "../services/conversation-bus.js";
import type { ToolOutcome } from "../services/tool-executor.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export class DocumentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentValidationError";
  }
}

function requireString(
  args: Record<string, unknown>,
  key: string,
  tool = "write_document",
): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DocumentValidationError(
      `${tool}: "${key}" must be a non-empty string`,
    );
  }
  return value;
}

function optionalString(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  return value;
}

/** How much of the document read_document may return in `output`. */
const READ_BUDGET = 40_000;

function truncateForReading(text: string): string {
  if (text.length <= READ_BUDGET) return text;
  return (
    text.slice(0, READ_BUDGET) +
    `\n\n… [documento truncado em ${READ_BUDGET.toLocaleString("pt-BR")} caracteres; use read_document com section para ler partes especificas]`
  );
}

/**
 * Where a section starts and ends, in lines.
 *
 * A section runs from its heading to the next heading of the same or higher
 * rank — so replacing "## Slides" also replaces every `### Slide N` under it,
 * which is what a caller asking for "the slides section" means. Matching is
 * case-insensitive and level-agnostic on purpose: the model writes the heading
 * back from memory and gets the `#` count wrong long before it gets the words
 * wrong.
 */
function sectionBounds(
  document: string,
  heading: string,
): { start: number; end: number } | null {
  const lines = document.split("\n");
  const target = heading.trim().replace(/^#+\s*/, "").toLowerCase();
  const headingRegex = /^(#{1,6})\s+(.+)$/;

  let foundLevel = 0;
  let start = -1;

  for (let i = 0; i < lines.length; i++) {
    const match = headingRegex.exec(lines[i] ?? "");
    if (!match) continue;

    const level = (match[1] ?? "").length;
    const title = match[2]!.trim().toLowerCase();

    if (start === -1) {
      if (title === target) {
        foundLevel = level;
        start = i;
      }
    } else if (level <= foundLevel) {
      return { start, end: i };
    }
  }

  return start === -1 ? null : { start, end: lines.length };
}

/** Find a section by heading. Returns null when not found. */
function findSection(document: string, heading: string): string | null {
  const bounds = sectionBounds(document, heading);
  if (!bounds) return null;
  return document.split("\n").slice(bounds.start, bounds.end).join("\n");
}

// ---------------------------------------------------------------------------
// Tool runners
// ---------------------------------------------------------------------------

export async function runWriteDocument(
  args: Record<string, unknown>,
  conversationId: string,
): Promise<ToolOutcome> {
  const content = requireString(args, "content");
  const stored = await writeDocument(conversationId, content);

  noteDocumentChanged(conversationId, stored, "assistant");

  return { output: "Documento atualizado." };
}

export async function runReadDocument(
  args: Record<string, unknown>,
  conversationId: string,
): Promise<ToolOutcome> {
  const section = optionalString(args, "section");
  const doc = await readDocument(conversationId);

  if (!doc) {
    return { output: "Ainda nao existe documento nesta conversa." };
  }

  if (section) {
    const found = findSection(doc, section);
    if (!found) {
      return {
        output: `Nao achei uma secao "${section}" no documento. Use read_document sem section para ver o documento inteiro e confirmar o nome da secao.`,
      };
    }
    return { output: truncateForReading(found) };
  }

  return { output: truncateForReading(doc) };
}

export async function runAppendDocument(
  args: Record<string, unknown>,
  conversationId: string,
): Promise<ToolOutcome> {
  const content = requireString(args, "content", "append_document");
  const stored = await appendDocument(conversationId, content);

  noteDocumentChanged(conversationId, stored, "assistant");

  return { output: "Trecho adicionado ao documento." };
}

/**
 * Replace one section, leaving the rest of the document exactly as it was.
 *
 * This is the tool the model should reach for on almost every edit, and the
 * reason it exists is that the two it replaces are both wrong for the job:
 * `write_document` resends the whole file — expensive on every turn, and it
 * silently overwrites whatever the user typed in the meantime — while
 * `append_document` can only ever add at the end.
 *
 * A section that is not there is created rather than refused. The model gets
 * headings slightly wrong (a dash instead of an em dash, a renumbered slide),
 * and answering "não achei" to that is how a refinement turn ends with nothing
 * written at all; an extra section at the end is visible on screen and the user
 * or the next edit fixes it.
 */
export async function runEditDocumentSection(
  args: Record<string, unknown>,
  conversationId: string,
): Promise<ToolOutcome> {
  const heading = requireString(args, "section", "edit_document_section");
  const content = requireString(args, "content", "edit_document_section");

  // What happened is decided inside the transform and read after it, because the
  // transform is the only place that sees the document this write is based on.
  // Reading it again out here would be a second read of a file the user may have
  // changed in between, and the sentence spoken out loud would describe the
  // wrong edit.
  let outcome: "created" | "replaced" | "appended" = "created";

  const stored = await updateDocument(conversationId, (current) => {
    if (current === null) {
      outcome = "created";
      return content;
    }

    const bounds = sectionBounds(current, heading);
    const lines = current.split("\n");
    const replacement = content.replace(/\s+$/, "").split("\n");

    if (bounds) {
      outcome = "replaced";
      return [
        ...lines.slice(0, bounds.start),
        ...replacement,
        ...lines.slice(bounds.end),
      ].join("\n");
    }

    outcome = "appended";
    return [...lines, "", ...replacement].join("\n");
  });

  noteDocumentChanged(conversationId, stored, "assistant");

  if (outcome === "created") return { output: "Documento criado com essa secao." };
  if (outcome === "replaced") return { output: `Secao "${heading}" atualizada.` };
  return {
    output: `Nao existia uma secao "${heading}", entao ela foi criada no fim do documento.`,
  };
}
