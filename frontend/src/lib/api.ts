import type {
  AgentJob,
  Conversation,
  ConversationSettings,
  CostSummary,
  Message,
  ProviderCredit,
  RealtimeSessionToken,
  BrowseResult,
  MaterialsEnvelope,
  SourceSpec,
} from "@/types";

// ----- Helpers -----

class ApiError extends Error {
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

function postJSON(path: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
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
 * Mint the ephemeral token for a WebRTC session.
 *
 * The standard API key never reaches the browser: the backend configures the
 * whole session (model, voice, instructions, tools) and hands back a token that
 * is only good for that one session.
 */
export async function createRealtimeSession(
  conversationId: string,
): Promise<RealtimeSessionToken> {
  const response = await postJSON("/api/realtime/session", {
    conversation_id: conversationId,
  });
  return handleResponse<RealtimeSessionToken>(response);
}

export interface ToolResult {
  call_id: string | null;
  name: string;
  output: string;
  meta: Record<string, unknown> | null;
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
