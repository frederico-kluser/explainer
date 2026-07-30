import type { ToolCall } from "../types/index.js";
import { executeWebResearch } from "../tools/web-research.js";
import { executeSearchFiles } from "../tools/search-files.js";
import { executeReadFile } from "../tools/read-file.js";
import { executeListAttachments } from "../tools/list-files.js";

export interface ToolResult {
  tool_call_id: string;
  role: "tool";
  content: string;
}

/**
 * Error raised when the model sends a tool call we refuse to run: unknown name,
 * unparseable arguments, or arguments of the wrong type. The caller turns this
 * into a tool result so the model can correct itself instead of the turn dying.
 */
export class ToolValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolValidationError";
  }
}

/**
 * Parse the JSON argument blob the model produced.
 * Models emit `""` for zero-argument tools and occasionally emit invalid JSON.
 */
export function parseToolArguments(raw: string): Record<string, unknown> {
  if (!raw || raw.trim().length === 0) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ToolValidationError(
      `Arguments are not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ToolValidationError("Arguments must be a JSON object");
  }

  return parsed as Record<string, unknown>;
}

function requireString(
  args: Record<string, unknown>,
  key: string,
  tool: string,
): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ToolValidationError(
      `${tool}: "${key}" must be a non-empty string`,
    );
  }
  return value;
}

function optionalString(
  args: Record<string, unknown>,
  key: string,
  tool: string,
): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new ToolValidationError(`${tool}: "${key}" must be a string`);
  }
  return value.trim().length === 0 ? undefined : value;
}

function optionalNumber(
  args: Record<string, unknown>,
  key: string,
  tool: string,
): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  // Models frequently send numbers as strings.
  const num = typeof value === "string" ? Number(value) : value;
  if (typeof num !== "number" || !Number.isFinite(num)) {
    throw new ToolValidationError(`${tool}: "${key}" must be a number`);
  }
  return num;
}

/**
 * Map a validated tool call onto its executor.
 * Nothing from the model reaches the filesystem or a shell without passing
 * through here first: the name must be known, the arguments must typecheck, and
 * every path is resolved by the sandbox helpers inside each executor.
 */
export async function executeToolCall(
  toolCall: ToolCall,
  conversationId: string,
): Promise<ToolResult> {
  const name = toolCall.function.name;
  const args = parseToolArguments(toolCall.function.arguments);

  let content: string;

  switch (name) {
    case "web_research":
      content = await executeWebResearch(
        requireString(args, "query", name),
        optionalNumber(args, "max_results", name),
      );
      break;

    case "search_project_files":
      content = await executeSearchFiles(
        requireString(args, "pattern", name),
        conversationId,
        optionalString(args, "path", name),
      );
      break;

    case "read_file":
      content = await executeReadFile(
        requireString(args, "filename", name),
        conversationId,
      );
      break;

    case "list_attachments":
      content = await executeListAttachments(conversationId);
      break;

    default: {
      // `name` is typed as the closed union, so this is unreachable at compile
      // time — but the value comes off the wire, so handle it at runtime too.
      const unknownName: string = name;
      throw new ToolValidationError(`Unknown tool: ${unknownName}`);
    }
  }

  return {
    tool_call_id: toolCall.id,
    role: "tool",
    content,
  };
}
