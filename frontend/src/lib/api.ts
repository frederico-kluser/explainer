import type {
  AgentJob,
  Conversation,
  ConversationSettings,
  CostSummary,
  MemoryFile,
  MemoryResume,
  Message,
  ProviderCredit,
  RealtimeSessionToken,
  BrowseResult,
  MaterialsEnvelope,
  SourceSpec,
} from "@/types";

// ----- Helpers -----

/**
 * A refusal the server wrote, carried with the status that classifies it.
 *
 * Exported because some statuses are not failures: a 409 from the memory import
 * is the backend protecting a file the user cannot get back, and its message —
 * already in Portuguese, already naming both ways out — is what the UI must
 * show. Callers tell that apart with `instanceof ApiError && err.status === 409`.
 */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function readError(response: Response): Promise<ApiError> {
  const body = await response.text().catch(() => "");
  let errorMsg = `HTTP ${response.status}`;
  try {
    const parsed = JSON.parse(body);
    errorMsg = parsed?.error ?? errorMsg;
  } catch {
    // body is not JSON — keep the status code
  }
  return new ApiError(response.status, errorMsg);
}

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) throw await readError(response);
  return response.json() as Promise<T>;
}

async function handleEmpty(response: Response): Promise<void> {
  if (!response.ok) throw await readError(response);
}

/**
 * Like `handleResponse`, except a 404 is an answer.
 *
 * The memory routes 404 a conversation nobody has said anything in yet. That is
 * the ordinary state of every new conversation, so turning it into a thrown
 * error would make the empty case indistinguishable from a broken server.
 */
async function handleMissingAsNull<T>(response: Response): Promise<T | null> {
  if (response.status === 404) return null;
  return handleResponse<T>(response);
}

function postJSON(path: string, body: unknown, init?: RequestInit): Promise<Response> {
  return fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    ...init,
  });
}

// ----- Sources -----

/** Add a material to a conversation. Returns the whole list back. */
export async function addMaterial(
  conversationId: string,
  source: SourceSpec,
): Promise<MaterialsEnvelope> {
  const response = await postJSON("/api/sources", {
    conversation_id: conversationId,
    source,
  });
  return handleResponse<MaterialsEnvelope>(response);
}

export async function listMaterials(
  conversationId: string,
): Promise<MaterialsEnvelope> {
  const response = await fetch(`/api/sources/${encodeURIComponent(conversationId)}`);
  return handleResponse<MaterialsEnvelope>(response);
}

export async function removeMaterial(
  conversationId: string,
  materialId: string,
): Promise<MaterialsEnvelope> {
  const response = await fetch(
    `/api/sources/${encodeURIComponent(conversationId)}/${encodeURIComponent(materialId)}`,
    { method: "DELETE" },
  );
  return handleResponse<MaterialsEnvelope>(response);
}

/**
 * Walk the machine for a local repository.
 *
 * Confined server-side to the same roots a local material may live under —
 * this is a picker, not a filesystem explorer.
 */
export async function browse(path?: string): Promise<BrowseResult> {
  const query = path ? `?path=${encodeURIComponent(path)}` : "";
  const response = await fetch(`/api/browse${query}`);
  return handleResponse<BrowseResult>(response);
}

// ----- Realtime -----

/**
 * How long the mint may hang before the UI gives up on it, in ms.
 *
 * The mint is not a plain lookup: for a conversation with memory it asks the
 * summariser to compress the file before it answers. That call has its own
 * server-side budget, but a stalled socket has none — and this request sits
 * between the user pressing "Conectar" and anything at all happening, with no
 * `AbortSignal` anywhere in `fetch`'s defaults to end it.
 */
export const REALTIME_MINT_TIMEOUT_MS = 20_000;

/**
 * Mint the ephemeral token for a WebRTC session.
 *
 * The standard API key never reaches the browser: the backend configures the
 * whole session (model, voice, instructions, tools) and hands back a token that
 * is only good for that one session.
 *
 * `signal` lets a caller drop the mint when the user navigates away; the
 * timeout is the floor under that, so no caller can forget it.
 */
export async function createRealtimeSession(
  conversationId: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<RealtimeSessionToken> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? REALTIME_MINT_TIMEOUT_MS);

  const caller = options.signal;
  const forwardAbort = () => controller.abort();
  if (caller) {
    if (caller.aborted) controller.abort();
    else caller.addEventListener("abort", forwardAbort, { once: true });
  }

  try {
    const response = await postJSON(
      "/api/realtime/session",
      { conversation_id: conversationId },
      { signal: controller.signal },
    );
    return await handleResponse<RealtimeSessionToken>(response);
  } catch (err) {
    // Our own deadline, not the caller's: say so in words the user can act on
    // instead of surfacing a bare AbortError.
    if (timedOut) {
      throw new Error(
        "O servidor demorou demais para preparar a sessao. Tente conectar de novo.",
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
    caller?.removeEventListener("abort", forwardAbort);
  }
}

/**
 * The side channel of a tool result.
 *
 * Everything the model must not read out loud travels here instead of in
 * `output`: `generate_diagram` puts the whole mermaid source in `meta.diagram`
 * and leaves only the spoken caption in `output`, and `deep_think` puts the job
 * id here so the model never recites a uuid digit by digit.
 */
export type ToolMeta = Record<string, unknown>;

export interface ToolResult {
  call_id: string | null;
  name: string;
  output: string;
  meta: ToolMeta | null;
}

/** Run one of the model's function calls on the server. */
export async function runTool(
  conversationId: string,
  call: { call_id: string; name: string; arguments: string },
): Promise<ToolResult> {
  const response = await postJSON("/api/realtime/tool", {
    conversation_id: conversationId,
    ...call,
  });
  return handleResponse<ToolResult>(response);
}

// ----- Agent jobs -----

export async function listAgentJobs(conversationId: string): Promise<AgentJob[]> {
  const response = await fetch(
    `/api/agents?conversation_id=${encodeURIComponent(conversationId)}`,
  );
  return handleResponse<AgentJob[]>(response);
}

export async function cancelAgentJob(jobId: string): Promise<void> {
  const response = await postJSON(`/api/agents/${encodeURIComponent(jobId)}/cancel`, {});
  await handleEmpty(response);
}

export function agentEventsUrl(conversationId: string): string {
  return `/api/agents/events?conversation_id=${encodeURIComponent(conversationId)}`;
}

// ----- Conversations CRUD -----

export async function listConversations(): Promise<Conversation[]> {
  const response = await fetch("/api/conversations", { method: "GET" });
  return handleResponse<Conversation[]>(response);
}

export async function createConversation(title: string): Promise<Conversation> {
  const response = await postJSON("/api/conversations", { title });
  return handleResponse<Conversation>(response);
}

export async function getConversation(id: string): Promise<Conversation> {
  const response = await fetch(`/api/conversations/${encodeURIComponent(id)}`, {
    method: "GET",
  });
  return handleResponse<Conversation>(response);
}

export async function deleteConversation(id: string): Promise<void> {
  const response = await fetch(`/api/conversations/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  await handleEmpty(response);
}

/** Persist finished turns from the live session. Best-effort by design. */
export async function appendMessages(
  conversationId: string,
  messages: Array<Pick<Message, "role" | "content"> & Partial<Message>>,
): Promise<void> {
  if (messages.length === 0) return;
  const response = await postJSON(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
    { messages },
  );
  await handleEmpty(response);
}

// ----- Memory -----
//
// The conversation as a file the user owns: readable, downloadable, importable
// somewhere else, and deletable without deleting the conversation.

function memoryPath(conversationId: string, suffix = ""): string {
  return `/api/conversations/${encodeURIComponent(conversationId)}/memory${suffix}`;
}

/**
 * The whole memory file, or `null` when the conversation has no past yet.
 *
 * `null` is not an error path. Every conversation starts here, and the caller
 * that shows "nada gravado ainda" needs to tell that apart from a server that
 * is down — which still throws.
 */
export async function getMemory(conversationId: string): Promise<MemoryFile | null> {
  const response = await fetch(memoryPath(conversationId));
  return handleMissingAsNull<MemoryFile>(response);
}

/**
 * The URL that makes the browser save the file instead of parsing it.
 *
 * Handed to an `<a download>` rather than fetched: `Content-Disposition` is
 * instruction for the browser's own downloader, and reading the body through
 * `fetch` would throw it away.
 */
export function memoryDownloadUrl(conversationId: string): string {
  return memoryPath(conversationId, "?download");
}

/**
 * Take a memory file back in, against the conversation in the URL.
 *
 * An import *replaces*. Without `overwrite`, a conversation that already
 * remembers something is answered with 409 and a message that names both ways
 * out — that message is the product, so it is propagated untouched rather than
 * flattened into "falha ao importar".
 *
 * `file` is `unknown` and not `MemoryFile` because the only caller holds a
 * `JSON.parse` of a file the user picked off their disk. The shape check belongs
 * to the server, which answers 400 naming the offending event; a `MemoryFile`
 * parameter could only be satisfied with a cast, and a cast here would be the
 * browser asserting something it never looked at.
 */
export async function importMemory(
  conversationId: string,
  file: unknown,
  options: { overwrite?: boolean } = {},
): Promise<MemoryFile> {
  const query = options.overwrite ? "/import?overwrite=true" : "/import";
  const response = await postJSON(memoryPath(conversationId, query), file);
  return handleResponse<MemoryFile>(response);
}

/**
 * The compressed form a resumed session would be seeded with.
 *
 * This one costs money — it pays the summariser to compress the file — so it is
 * a deliberate request, never a poll.
 */
export async function getMemoryResume(
  conversationId: string,
): Promise<MemoryResume | null> {
  const response = await fetch(memoryPath(conversationId, "/resume"));
  return handleMissingAsNull<MemoryResume>(response);
}

/** Forget, without deleting the conversation. */
export async function clearMemory(conversationId: string): Promise<void> {
  const response = await fetch(memoryPath(conversationId), { method: "DELETE" });
  await handleEmpty(response);
}

// ----- Costs and credits -----

/**
 * Report what a realtime response consumed.
 *
 * The `usage` object lives on the data channel, which only the browser holds —
 * so the browser reports the raw counts and the server prices them.
 */
export async function reportRealtimeUsage(
  conversationId: string,
  usage: unknown,
  model: string,
): Promise<{ usd: number } | null> {
  try {
    const response = await postJSON("/api/costs/realtime", {
      conversation_id: conversationId,
      usage,
      model,
    });
    if (!response.ok) return null;
    return (await response.json()) as { usd: number };
  } catch {
    return null; // bookkeeping must never break a call
  }
}

export async function getCosts(conversationId: string): Promise<CostSummary> {
  const response = await fetch(`/api/costs/${encodeURIComponent(conversationId)}`);
  return handleResponse<CostSummary>(response);
}

export async function getCredits(): Promise<ProviderCredit[]> {
  const response = await fetch("/api/credits");
  const body = await handleResponse<{ providers: ProviderCredit[] }>(response);
  return body.providers;
}

// ----- Settings -----

export async function getSettings(
  conversationId: string,
): Promise<ConversationSettings> {
  const response = await fetch(
    `/api/conversations/${encodeURIComponent(conversationId)}/settings`,
  );
  return handleResponse<ConversationSettings>(response);
}

export async function updateSettings(
  conversationId: string,
  patch: { voice?: string; speed?: number },
): Promise<ConversationSettings> {
  const response = await fetch(
    `/api/conversations/${encodeURIComponent(conversationId)}/settings`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    },
  );
  return handleResponse<ConversationSettings>(response);
}

export async function renameConversation(
  id: string,
  title: string,
): Promise<Conversation> {
  const response = await fetch(`/api/conversations/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  return handleResponse<Conversation>(response);
}
