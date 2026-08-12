import type {
  AgentJob,
  Conversation,
  ConversationSettings,
  CostSummary,
  FloorRequest,
  FloorSnapshot,
  MemoryFile,
  MemoryResume,
  Message,
  ProviderCredit,
  ProviderKeyStatus,
  ProviderName,
  RealtimeSessionToken,
  BrowseResult,
  MaterialsEnvelope,
  ModesEnvelope,
  SourceSpec,
  RosterEnvelope,
  ThinkerRoster,
  ConfigTestEnvelope,
  ModelChoice,
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
    /**
     * The refusal's whole body, when it parsed as JSON.
     *
     * Some refusals carry more than a sentence: the mint's floor 409 names the
     * holder *and* hands over the `floor` snapshot, which is what lets the UI
     * offer "pedir o microfone" rather than "tentar de novo". Without this the
     * caller would be parsing a Portuguese sentence to find a client id.
     */
    public body: unknown = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function readError(response: Response): Promise<ApiError> {
  const body = await response.text().catch(() => "");
  let errorMsg = `HTTP ${response.status}`;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(body);
    errorMsg = (parsed as { error?: string } | null)?.error ?? errorMsg;
  } catch {
    // body is not JSON — keep the status code
  }
  return new ApiError(response.status, errorMsg, parsed);
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

// ----- Access -----

/**
 * Trade the key from the shared link for the cookie every later request carries.
 *
 * A cookie and not an `Authorization` header because `new EventSource(url)`
 * takes no headers — a bearer scheme would put the secret in the query string
 * of every SSE stream, where it survives in logs and history. The cookie is
 * sent by `fetch` (default `credentials: "same-origin"`) and by `EventSource`
 * alike, so nothing below this line has to know the key exists.
 *
 * Throws `ApiError` with `status: 401` when the key is refused.
 */
export async function claimAccessKey(key: string): Promise<void> {
  const response = await postJSON("/api/pair", { key });
  await handleEmpty(response);
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
 *
 * `clientId` is what makes this the hard gate on the microphone: the mint is the
 * only step of the WebRTC handshake that passes through our server, so it is the
 * only refusal a second tab cannot route around. Identifying yourself here takes
 * the floor when it is free and earns a 409 naming the holder when it is not — a
 * caller that stays anonymous is refused too, once somebody holds it.
 */
export async function createRealtimeSession(
  conversationId: string,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    clientId?: string;
    clientName?: string;
  } = {},
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
      {
        conversation_id: conversationId,
        ...(options.clientId ? { client_id: options.clientId } : {}),
        ...(options.clientName ? { client_name: options.clientName } : {}),
      },
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

// ----- The shared conversation, and the one microphone in it -----

/**
 * The SSE endpoint for one conversation, as `EventSource` wants it.
 *
 * The access key is deliberately absent. It is a cookie, `EventSource` sends
 * cookies by itself on a same-origin request, and repeating the key in the query
 * string of a connection that stays open for the whole call would put it in
 * every proxy log and in the browser's history.
 *
 * No `since` either: on its own reconnect the browser resends the last `id:` it
 * saw as `Last-Event-ID`, which is the entire reason the server numbers frames.
 * Passing one by hand would only ever be a worse guess than the browser's.
 */
export function conversationStreamUrl(
  conversationId: string,
  clientId: string,
): string {
  return (
    `/api/conversations/${encodeURIComponent(conversationId)}/live` +
    `?client_id=${encodeURIComponent(clientId)}`
  );
}

function floorPath(conversationId: string, suffix = ""): string {
  return `/api/conversations/${encodeURIComponent(conversationId)}/floor${suffix}`;
}

export interface FloorState {
  floor: FloorSnapshot | null;
  request: FloorRequest | null;
  viewers: number;
}

/**
 * Who has the microphone and who asked for it.
 *
 * `presence.changed` already carries the holder to everyone on the stream, but
 * not the pending request — so a client that joins after somebody asked would
 * otherwise never learn there is a question waiting. This is the one read that
 * closes that gap, and it is why the hook does it once on open.
 */
export async function getFloor(conversationId: string): Promise<FloorState> {
  const response = await fetch(floorPath(conversationId));
  return handleResponse<FloorState>(response);
}

/** Take the microphone. Throws `ApiError` 409 naming the holder when it is taken. */
export async function claimFloor(
  conversationId: string,
  clientId: string,
  name: string,
): Promise<{ floor: FloorSnapshot; already_mine: boolean }> {
  const response = await postJSON(floorPath(conversationId), {
    client_id: clientId,
    name,
  });
  return handleResponse<{ floor: FloorSnapshot; already_mine: boolean }>(response);
}

/**
 * Hand it back.
 *
 * `client_id` travels in the query string rather than a body: a DELETE with a
 * body is honoured by this server but not by every proxy between a phone and it,
 * and the route reads either.
 */
export async function releaseFloor(
  conversationId: string,
  clientId: string,
): Promise<{ released: boolean; floor: FloorSnapshot | null }> {
  const response = await fetch(
    floorPath(conversationId, `?client_id=${encodeURIComponent(clientId)}`),
    { method: "DELETE" },
  );
  return handleResponse<{ released: boolean; floor: FloorSnapshot | null }>(response);
}

/**
 * Ask the holder for it. Answers 202 — a request, not a take-over.
 *
 * There is no forced hand-over anywhere in this feature: this posts a card on
 * the holder's screen and stops. Cutting somebody off mid-sentence is a worse
 * outcome than waiting. A 409 comes back when there is nobody to ask.
 */
export async function requestFloor(
  conversationId: string,
  clientId: string,
  name: string,
): Promise<{ requested: FloorRequest | null; floor: FloorSnapshot | null }> {
  const response = await postJSON(floorPath(conversationId, "/request"), {
    client_id: clientId,
    name,
  });
  return handleResponse<{ requested: FloorRequest | null; floor: FloorSnapshot | null }>(
    response,
  );
}

// ----- Conversations CRUD -----

export async function listConversations(): Promise<Conversation[]> {
  const response = await fetch("/api/conversations", { method: "GET" });
  return handleResponse<Conversation[]>(response);
}

/**
 * Create a conversation in a mode.
 *
 * The mode is only ever sent here: it is frozen into the session token at mint
 * time along with the instructions and the tool list, so there is no second
 * call that changes it. An id the server does not know falls back to the
 * default rather than failing the create.
 */
export async function createConversation(
  title: string,
  mode?: string,
): Promise<Conversation> {
  const response = await postJSON("/api/conversations", {
    title,
    ...(mode ? { mode } : {}),
  });
  return handleResponse<Conversation>(response);
}

// ----- Modes -----

/**
 * The kinds of conversation this server offers.
 *
 * Fetched rather than hard-coded so a mode added in `backend/src/modes/` shows
 * up on the picker without a change here.
 */
export async function listModes(): Promise<ModesEnvelope> {
  const response = await fetch("/api/modes");
  return handleResponse<ModesEnvelope>(response);
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


// ----- Document -----

/** The conversation's collaborative document, or null when none exists yet. */
export async function getDocument(conversationId: string): Promise<string | null> {
  const response = await fetch(
    `/api/conversations/${encodeURIComponent(conversationId)}/document`,
  );
  return handleMissingAsNull<{ content: string }>(response).then(
    (body) => body?.content ?? null,
  );
}

/**
 * Replace the whole document and answer with the stored (server-normalised)
 * content, so the panel can adopt the truncated truth.
 */
export async function updateDocument(
  conversationId: string,
  content: string,
): Promise<string> {
  const response = await fetch(
    `/api/conversations/${encodeURIComponent(conversationId)}/document`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    },
  );
  return (await handleResponse<{ content: string }>(response)).content;
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

// ----- Provider keys -----

/**
 * Whether each provider can be called, as the backend sees it.
 *
 * The one source of truth for "is a key configured": the backend masks every
 * >= 500 error as `{"error":"Internal server error"}`, so a missing key is
 * never visible as an HTTP message — only as `present: false` here.
 */
export async function getProviderKeys(): Promise<ProviderKeyStatus[]> {
  const response = await fetch("/api/provider-keys");
  const body = await handleResponse<{ providers: ProviderKeyStatus[] }>(response);
  return body.providers;
}

/**
 * Hand a provider a key, for the rest of the backend's life.
 *
 * Runtime only — never disk, never logs. A rejected key answers 400 naming
 * the problem in Portuguese; the provider's own 401 is the final judge of a
 * key that is well-formed but wrong.
 */
export async function setProviderKey(
  provider: ProviderName,
  key: string,
): Promise<ProviderKeyStatus> {
  // A bare `fetch` and not `postJSON`: the route answers PUT, and the helper
  // is POST-shaped by name.
  const response = await fetch(
    `/api/provider-keys/${encodeURIComponent(provider)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    },
  );
  return handleResponse<ProviderKeyStatus>(response);
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

// ----- Thinker roster -----

/**
 * The roster in force, plus the key statuses and warnings that render with it.
 *
 * One call, because the panel cannot render a roster without the other two:
 * a roster pointing slot 3 at OpenRouter is fine right up until OpenRouter has
 * no key.
 */
export async function getRoster(): Promise<RosterEnvelope> {
  const response = await fetch("/api/thinkers");
  return handleResponse<RosterEnvelope>(response);
}

/**
 * Write the roster. Answers with the whole normalised envelope.
 *
 * A bare `fetch` and not `postJSON` — the route answers PUT, and the helper is
 * POST-shaped by name (the same comment `setProviderKey` carries). The backend
 * treats the body as a partial patch and normalises every field it reads, so
 * the caller re-renders from the RESPONSE rather than trusting its own draft.
 */
export async function putRoster(roster: ThinkerRoster): Promise<RosterEnvelope> {
  const response = await fetch("/api/thinkers", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(roster),
  });
  return handleResponse<RosterEnvelope>(response);
}

/**
 * Back to the defaults — for whoever tied a knot.
 *
 * `POST` because that is the route; the reset writes the defaults into a file
 * and answers with the envelope for what was written, so the caller renders
 * that and never its own guess at the defaults.
 */
export async function resetRoster(): Promise<RosterEnvelope> {
  const response = await fetch("/api/thinkers/reset", { method: "POST" });
  return handleResponse<RosterEnvelope>(response);
}

/**
 * Ping every unique config of the draft before it is saved, and report which
 * answered.
 *
 * The backend dedupes under the same `${provider}::${model}::${effort}` key
 * the UI keys rows with, so identical choices — master and slot 3 pointed at
 * the same model — cost one provider call. A 400 names a config the server
 * refuses to even try; the caller aborts the save on that, and treats every
 * other failure as a diagnostic that does not block saving.
 */
export async function testConfigs(
  configs: ModelChoice[],
): Promise<ConfigTestEnvelope> {
  const response = await postJSON("/api/thinkers/test", { configs });
  return handleResponse<ConfigTestEnvelope>(response);
}
