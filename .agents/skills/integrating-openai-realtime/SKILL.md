---
name: integrating-openai-realtime
description: Encodes the OpenAI Realtime protocol contract this app depends on — the flat schema whose nested variant silently exposes zero tools, the ack gate before response.create, barge-in, and the session limits. Use whenever touching routes/realtime.ts, useRealtimeSession or lib/realtime.ts, and whenever the protocol itself misbehaves: a voice turn is lost, an active-response error appears, the assistant talks over the user, or an existing tool stopped being invoked, even if the user never mentions the Realtime API.
metadata:
  type: knowledge
  verification_signal: npm --prefix frontend test -- src/__tests__/realtime.test.ts (named directly; validate.sh cannot fail on frontend tests)
---
# Integrating the OpenAI Realtime API

## When to use

Editing the tool definitions, the session mint, or the browser session hook —
and any time a turn disappears, a tool is defined but never called, or the model
talks over the user.

Nearly everything below fails **silently**. The API returns 200, the session
opens, and the behaviour is simply wrong. That is why this knowledge is written
down instead of left to be rediscovered.

## Injected knowledge

### The tool schema is flat

`type`, `name`, `description`, `parameters` sit at the top level. This is not
the Chat Completions shape, where everything but `type` nests under `function`.
Sending the nested shape is accepted and gives the model **zero tools** — no
error, just an assistant that can never search anything —
`backend/src/tools/index.ts:10@cdb48364`.

### Never ask for a response while one is running

`response.create` on top of an active response returns
*"Conversation already has an active response"* and the turn is lost. The hook
tracks `activeResponseRef` and defers the request into `wantResponseRef`, which
is drained on the next `response.done` —
`frontend/src/hooks/useRealtimeSession.ts:1362@491de366`.

### The tool-output loop stays synchronous

Register each `call_id` in `pendingAcks` **before** sending its
`functionOutputEvent`, and emit every output in one synchronous pass —
`frontend/src/hooks/useRealtimeSession.ts:1460@42b3788c`. Insert an `await`
inside that loop and the first acknowledgement drains the pending set to zero
while later outputs are still unsent, so `flushAcks()` requests a response the
model cannot yet answer. Run the tools in parallel first, then emit.

This exact mistake was made in a test harness before the invariant was written
down: the model answered from one tool result while a second was still in
flight.

### Accept both acknowledgement event names

`conversation.item.added` and `conversation.item.created` are the new and old
names for the same event — `frontend/src/lib/realtime.ts:95@2623ae7a`. Gating on
only one still works, because the 2.5 s timeout eventually fires, but every tool
call then pays that timeout. The symptom is a conversation that feels sluggish
only after tool use.

### Barge-in needs the buffer cleared

WebRTC buffers ahead, so when the user interrupts, the model can be seconds
ahead of what was actually heard. On `input_audio_buffer.speech_started` while
the assistant is speaking, the hook sends `output_audio_buffer.clear`. The
speaking flag is read from a ref rather than state because the data-channel
handler is installed once and a state read there would be a stale closure.

### Session facts that shape design

- Model, voice, instructions and the tool list are fixed server-side at mint
  time, so a tampered browser can waste its own session and nothing more —
  `backend/src/routes/realtime.ts:216@5926f442`.
- The ephemeral token lives ~10 minutes; the session itself is capped at 60.
- The voice freezes once the session has emitted audio, so changing it needs a
  reconnect. `speed` can move mid-call via `session.update`.
- Turn detection is `semantic_vad`: turns end on meaning, not on a silence
  window.
- The Realtime API has **no hosted web search** — its only tool types are
  `function` and `mcp`, so search runs through the Responses API and comes back
  as a function result — `backend/src/tools/web-search.ts:17@048ec308`.

### A slow tool must not block the conversation

Return something immediately and inject the real answer later as a new
conversation item plus a `response.create`. `dispatch_pi_agent` is the worked
example; see `dispatching-pi-agents`.

## References

- `frontend/src/lib/realtime.ts` — the protocol constants and helpers, small
  enough to read whole before changing anything here.

## Escape hatch

If the API changes shape, the eval `flat-tool-shape` fails first. Update the
code, then this skill, in that order — the skill is downstream of the code.
