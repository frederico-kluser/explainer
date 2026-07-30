import type { Attachment, ChatEvent, Conversation } from "@/types"

// ----- Helpers -----

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
    this.name = "ApiError"
  }
}

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new ApiError(response.status, body || response.statusText)
  }
  return response.json() as Promise<T>
}

async function handleEmpty(response: Response): Promise<void> {
  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new ApiError(response.status, body || response.statusText)
  }
}

// ----- SSE streaming parser -----

async function* parseSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<ChatEvent> {
  const decoder = new TextDecoder()
  let buffer = ""

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })

    // Split on double newline (SSE event boundary)
    const parts = buffer.split("\n\n")
    // The last part may be incomplete; keep it in buffer
    buffer = parts.pop() ?? ""

    for (const part of parts) {
      const lines = part.split("\n")
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || !trimmed.startsWith("data:")) continue

        const data = trimmed.slice(5).trim()
        if (!data) continue

        // OpenRouter-style [DONE] signal
        if (data === "[DONE]") {
          yield { type: "done" as const }
          return
        }

        try {
          const parsed = JSON.parse(data) as ChatEvent
          yield parsed
        } catch {
          // Skip unparseable lines
        }
      }
    }
  }

  // Flush remaining buffer
  if (buffer.trim()) {
    const lines = buffer.split("\n")
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || !trimmed.startsWith("data:")) continue

      const data = trimmed.slice(5).trim()
      if (!data || data === "[DONE]") continue

      try {
        const parsed = JSON.parse(data) as ChatEvent
        yield parsed
      } catch {
        // Skip unparseable lines
      }
    }
  }
}

// ----- STT -----

export async function transcribe(audio: Blob): Promise<{ text: string }> {
  const form = new FormData()
  form.append("audio", audio, "recording.webm")

  const response = await fetch("/api/stt", {
    method: "POST",
    body: form,
  })

  return handleResponse<{ text: string }>(response)
}

// ----- Chat (SSE stream) -----

export async function* chat(
  conversationId: string,
  message?: string,
  signal?: AbortSignal,
): AsyncGenerator<ChatEvent> {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      conversation_id: conversationId,
      ...(message !== undefined ? { message } : {}),
    }),
    signal,
  })

  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new ApiError(response.status, body || response.statusText)
  }

  if (!response.body) {
    throw new Error("Response body is not readable")
  }

  const reader = response.body.getReader()

  try {
    for await (const event of parseSSEStream(reader)) {
      yield event
    }
  } finally {
    // Abort tears the stream down; cancel() is what releases the connection
    // when the consumer stops early (component unmount, conversation switch).
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

// ----- TTS -----

export async function synthesize(text: string): Promise<Blob> {
  const response = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  })

  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new ApiError(response.status, body || response.statusText)
  }

  return response.blob()
}

// ----- Conversations CRUD -----

export async function listConversations(): Promise<Conversation[]> {
  const response = await fetch("/api/conversations", { method: "GET" })
  return handleResponse<Conversation[]>(response)
}

export async function createConversation(title: string): Promise<Conversation> {
  const response = await fetch("/api/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  })
  return handleResponse<Conversation>(response)
}

export async function getConversation(id: string): Promise<Conversation> {
  const response = await fetch(`/api/conversations/${encodeURIComponent(id)}`, {
    method: "GET",
  })
  return handleResponse<Conversation>(response)
}

export async function deleteConversation(id: string): Promise<void> {
  const response = await fetch(`/api/conversations/${encodeURIComponent(id)}`, {
    method: "DELETE",
  })
  await handleEmpty(response)
}

// ----- Files -----

export async function uploadFiles(
  convId: string,
  files: File[],
): Promise<Attachment[]> {
  const form = new FormData()
  for (const file of files) {
    form.append("files", file)
  }

  const response = await fetch(`/api/files/${encodeURIComponent(convId)}`, {
    method: "POST",
    body: form,
  })

  return handleResponse<Attachment[]>(response)
}

export async function listFiles(convId: string): Promise<Attachment[]> {
  const response = await fetch(`/api/files/${encodeURIComponent(convId)}`, {
    method: "GET",
  })
  return handleResponse<Attachment[]>(response)
}

export async function readFile(
  convId: string,
  filename: string,
): Promise<string> {
  const response = await fetch(
    `/api/files/${encodeURIComponent(convId)}/${encodeURIComponent(filename)}`,
    { method: "GET" },
  )

  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new ApiError(response.status, body || response.statusText)
  }

  return response.text()
}
