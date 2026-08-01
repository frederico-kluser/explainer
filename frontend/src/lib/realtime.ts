// Types and helpers for the OpenAI Realtime data channel.
//
// The browser talks to the model over a WebRTC peer connection: audio rides the
// media tracks (so the model's voice starts playing before it has finished
// thinking), and everything else — transcripts, tool calls, session config —
// rides a single ordered data channel named `oai-events`.

/** The SDP exchange endpoint. The ephemeral token is the bearer. */
export const REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";

export const DATA_CHANNEL_NAME = "oai-events";

/** A function call the model wants us to run. */
export interface RealtimeFunctionCall {
  name: string;
  call_id: string;
  arguments: string;
}

interface ResponseDoneEvent {
  type: "response.done";
  response?: {
    output?: Array<{
      type?: string;
      name?: string;
      call_id?: string;
      arguments?: string;
    }>;
  };
}

export interface RealtimeServerEvent {
  type: string;
  [key: string]: unknown;
}

/** Pull the function calls out of a `response.done` payload. */
export function functionCallsFrom(event: RealtimeServerEvent): RealtimeFunctionCall[] {
  const output = (event as ResponseDoneEvent).response?.output ?? [];
  const calls: RealtimeFunctionCall[] = [];

  for (const item of output) {
    if (item?.type !== "function_call") continue;
    if (!item.name || !item.call_id) continue;
    calls.push({
      name: item.name,
      call_id: item.call_id,
      arguments: item.arguments ?? "{}",
    });
  }

  return calls;
}

/** The client event that returns a tool result to the model. */
export function functionOutputEvent(callId: string, output: string) {
  return {
    type: "conversation.item.create",
    item: {
      type: "function_call_output",
      call_id: callId,
      output,
    },
  } as const;
}

/** The client event that puts plain text into the conversation as the user. */
export function userTextEvent(text: string) {
  return {
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
    },
  } as const;
}

export const RESPONSE_CREATE = { type: "response.create" } as const;

/**
 * Stop the audio the peer connection is still playing.
 *
 * WebRTC buffers ahead, so when the user barges in the model can be several
 * seconds "ahead" of what was actually heard. This drops that tail.
 */
export const CLEAR_OUTPUT_AUDIO = { type: "output_audio_buffer.clear" } as const;

/**
 * Server events that acknowledge an item we created. The name changed between
 * API generations (`conversation.item.created` → `conversation.item.added`), so
 * both are accepted — the point is only to know the item landed before asking
 * for a response.
 */
export const ITEM_ACK_EVENTS = new Set([
  "conversation.item.added",
  "conversation.item.created",
  "conversation.item.done",
]);
