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
): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DocumentValidationError(
      `write_document: "${key}" must be a non-empty string`,
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

/** Find a section by heading. Returns null when not found. */
function findSection(document: string, heading: string): string | null {
  const lines = document.split("\n");
  // Build a regex that matches the heading at any level (1-6 #).
  const target = heading.trim().toLowerCase();
  const headingRegex = /^(#{1,6})\s+(.+)$/;

  let foundLevel = 0;
  let start = -1;

  for (let i = 0; i < lines.length; i++) {
    const match = headingRegex.exec(lines[i] ?? "");
    if (!match) continue;

    const level = (match[1] ?? "").length;
    const title = match[2]!.trim().toLowerCase();

    if (start === -1) {
      // Looking for the target heading.
      if (title === target) {
        foundLevel = level;
        start = i;
      }
    } else {
      // We are inside the section; stop at a heading of equal or higher rank.
      if (level <= foundLevel) {
        return lines.slice(start, i).join("\n");
      }
    }
  }

  if (start !== -1) {
    // Hit end of document.
    return lines.slice(start).join("\n");
  }

  return null;
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
  const content = requireString(args, "content");
  const stored = await appendDocument(conversationId, content);

  noteDocumentChanged(conversationId, stored, "assistant");

  return { output: "Trecho adicionado ao documento." };
}
