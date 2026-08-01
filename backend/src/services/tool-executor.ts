import { AgentJobError, dispatchAgentJob, getJob } from "./agent-jobs.js";
import { listSources, pickSource } from "./source-store.js";
import {
  listSourceFiles,
  readSourceDoc,
  readSourceFile,
  searchSource,
} from "../tools/source-tools.js";
import { executeWebSearch } from "../tools/web-search.js";
import { toolsForSources } from "../tools/index.js";
import type { ResolvedSource, ToolName } from "../types/index.js";

export interface ToolOutcome {
  /** What goes back to the model as the `function_call_output`. */
  output: string;
  /** Extra payload the browser uses for its own UI (job cards, traces). */
  meta?: Record<string, unknown>;
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
    throw new ToolValidationError(`${tool}: "${key}" must be a non-empty string`);
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
  // Models sometimes send a material by position as a number.
  if (typeof value === "number") return String(value);
  if (typeof value !== "string") {
    throw new ToolValidationError(`${tool}: "${key}" must be a string`);
  }
  return value.trim().length === 0 ? undefined : value;
}

/** One line per material, for the model to choose from. */
function describeMaterials(sources: ResolvedSource[]): string {
  return sources
    .map((source, index) => {
      const capability = source.root
        ? "posso ler, procurar e mandar agente"
        : "posso ler o documento";
      const where = source.origin ? ` — ${source.origin}` : "";
      return `${index + 1}. ${source.label} (${source.kind}${where}) — ${capability}`;
    })
    .join("\n");
}

/**
 * Run one tool call.
 *
 * Nothing from the model reaches the filesystem or a subprocess without passing
 * through here: the name must be known, it must be a tool the conversation's
 * materials actually grant, the arguments must typecheck, and every path is
 * resolved against that material's root by the sandbox helpers.
 */
export async function executeTool(
  name: string,
  rawArguments: string,
  conversationId: string,
): Promise<ToolOutcome> {
  const args = parseToolArguments(rawArguments);
  const sources = await listSources(conversationId);

  if (sources.length === 0) {
    return {
      output:
        "Nenhum material foi adicionado a esta conversa. Peca ao usuario para " +
        "adicionar um repositorio, colar um markdown ou incluir a documentacao " +
        "do computador.",
    };
  }

  const allowed = new Set(toolsForSources(sources).map((t) => t.name));
  if (!allowed.has(name as ToolName)) {
    return {
      output:
        `A ferramenta "${name}" nao esta disponivel para os materiais desta ` +
        `conversa. Disponiveis: ${[...allowed].join(", ")}.`,
    };
  }

  // Every material-scoped tool resolves the same way, and a reference the model
  // invented falls back to the first material instead of failing the turn.
  const reference = optionalString(args, "material", name);
  const source = pickSource(sources, reference)!;

  switch (name as ToolName) {
    case "list_materials":
      return {
        output: `Materiais desta conversa:\n${describeMaterials(sources)}`,
        meta: { count: sources.length },
      };

    case "web_search":
      return {
        output: await executeWebSearch(
          requireString(args, "query", name),
          conversationId,
        ),
      };

    case "read_source_doc":
      return {
        output: await readSourceDoc(source, optionalString(args, "path", name)),
        meta: { material: source.label },
      };

    case "search_source":
      return {
        output: await searchSource(
          source,
          requireString(args, "query", name),
          optionalString(args, "path", name),
        ),
        meta: { material: source.label },
      };

    case "read_source_file":
      return {
        output: await readSourceFile(source, requireString(args, "path", name)),
        meta: { material: source.label },
      };

    case "list_source_files":
      return {
        output: await listSourceFiles(source, optionalString(args, "path", name)),
        meta: { material: source.label },
      };

    case "dispatch_pi_agent":
      return dispatchAgent(
        conversationId,
        source,
        requireString(args, "question", name),
        optionalString(args, "context", name),
      );

    case "check_pi_agent": {
      const job = getJob(requireString(args, "job_id", name));
      if (!job) return { output: "Nenhum agente com esse identificador." };
      if (job.status === "running") {
        return {
          output: `O agente ainda esta trabalhando (${job.activity}). Continue a conversa; a resposta chega sozinha.`,
          meta: { job_id: job.id, status: job.status },
        };
      }
      return {
        output: job.result ?? job.error ?? "O agente terminou sem resposta.",
        meta: { job_id: job.id, status: job.status },
      };
    }

    default: {
      const unknown: string = name;
      throw new ToolValidationError(`Unknown tool: ${unknown}`);
    }
  }
}

/**
 * Start a `pi` run and answer immediately.
 *
 * The whole point is that the model does not block: it gets a job id in
 * milliseconds and keeps the conversation going, and the real answer is injected
 * as a new conversation item when the agent finishes.
 */
function dispatchAgent(
  conversationId: string,
  source: ResolvedSource,
  question: string,
  context: string | undefined,
): ToolOutcome {
  if (!source.root) {
    return {
      output:
        `O material "${source.label}" nao tem um diretorio em disco, entao nao da ` +
        "para disparar um agente nele. Escolha outro material, use web_search ou " +
        "responda a partir do documento.",
    };
  }

  try {
    const job = dispatchAgentJob({
      conversationId,
      prompt: question,
      cwd: source.root,
      ...(context ? { context } : {}),
    });
    return {
      output:
        `Agente disparado (job ${job.id}) sobre "${source.label}". Ele esta ` +
        "investigando agora. Avise o usuario em voz alta que voce mandou o agente " +
        "e continue a conversa; a resposta vai chegar sozinha em breve.",
      meta: {
        job_id: job.id,
        status: job.status,
        activity: job.activity,
        material: source.label,
      },
    };
  } catch (err) {
    if (err instanceof AgentJobError) return { output: err.message };
    throw err;
  }
}
