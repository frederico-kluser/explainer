---
name: building-conversation-modes
description: Explains what a conversation mode owns and what it may never touch, how a mode is chosen once and frozen, and the traps in the collaborative document a mode keeps on screen — the non-reentrant write lock and the tool gate that now has two axes. Use whenever adding or editing anything under backend/src/modes, whenever a conversation behaves as the wrong kind, and before touching document-store or the markdown sidebar.
metadata:
  type: knowledge
  verification_signal: npm --prefix backend test -- src/__tests__/{modes,mode-routes,document-store,document-tools}.test.ts
---
# Building conversation modes

## When to use

Adding a mode, editing one, or touching the document a mode keeps beside the
conversation. Also when a conversation opens as the wrong kind, when the
sidebar shows nothing, or when a document write never answers.

## Injected knowledge

### A mode is data, and the registry is the only list

A mode is one file under `backend/src/modes/` plus one line in the registry —
`backend/src/modes/registry.ts:16@2f2d9006`. Nothing else enumerates modes:
`GET /api/modes` serves that map, the browser renders whatever it gets, and
`prompts.ts` asks the mode for its sections instead of branching on its id. A
hard-coded copy of the list in `frontend/` is the drift this design exists to
prevent, and the picker test is what holds the line — it renders a mode the
build has never heard of, with an icon it cannot resolve.

The registry key **is** the id, and `ModeId` is derived from the map rather than
declared next to it, so adding a mode cannot leave the two disagreeing.

### What a mode owns, and what it must not

It owns the Role, the Conversation Flow, extra prompt sections, whether the
conversation needs a material, which document it keeps, and which tools it adds.

It owns none of the rest, and that boundary is the point: speech format,
language, the unclear-audio rule and the tool preamble stay shared in
`prompts.ts`, because a mode that could rewrite them would be a second
application rather than a mode.

Modes name tools; they never define them —
`backend/src/modes/types.ts:86@5b8aad11`. The schema stays in `tools/index.ts`,
so the flat-shape trap has one place to be got wrong instead of one per mode.

### Chosen once, frozen for the life of the conversation

The mode is recorded at creation into `Conversation.metadata.mode` —
`backend/src/services/conversation-mode.ts:52@eba0a315` — and `PATCH` strips the
key rather than refusing it, so an existing client that echoes the whole
conversation back on a rename does not start failing —
`backend/src/routes/conversations.ts:89@16cf1acb`.

Immutability is not tidiness. Instructions and the tool list are frozen into the
ephemeral token at mint time, so a conversation that changed mode mid-call would
be a screen and a model disagreeing about what the call is for.

A conversation with no `metadata.mode` — every conversation older than this
feature — resolves to the first entry in the registry, which is why that entry
has to be the one carrying the pre-modes behaviour.

### `requiresMaterial: false` reaches further than it looks

`routes/realtime.ts` answers 409 on a conversation with no sources, and
`tool-executor.ts` answers "add a material" out loud for any tool outside
`MATERIAL_FREE_TOOLS`. A mode that opens the microphone on an empty
conversation has to clear both, and the frontend's own `disabled` on the
microphone as well. Miss the third and the server would mint a session the
button never lets anyone start.

### The document lock is not reentrant, and cannot be

`withDocumentLock` chains each operation onto the previous one's completion, so
a holder that calls a second locked function waits on a promise that only
resolves when the holder returns. That is a deadlock with no timeout and no
error — the request simply never answers.

Every locked entry point therefore wraps `writeLocked`, never another entry
point — `backend/src/services/document-store.ts:110@a73ce797`. A partial edit
goes through `updateDocument`, which does the read, the transform and the write
inside one lock — `backend/src/services/document-store.ts:164@232aa190`. Three
writers reach this file (the model, this browser, any other screen on the same
conversation), so a read followed by a separate write silently loses whichever
landed in between.

### Prose that names a tool has to be gated like the tool

A mode's `sections(context)` receives the tool list the session is actually
being minted with. A section that names `edit_document_section` regardless
contradicts the preamble forbidding the model to mention tools it does not
hold — on every single turn. Gate on `context.toolNames`, the way
`TOOL_GUIDANCE` gates on the minted list.

### Instructions are re-billed on every response

A mode carrying a knowledge base is the most expensive string in the app: the
presentation mode's instructions run about five thousand tokens against one
thousand for the plain conversation. `modes.test.ts` pins a ceiling so that
number cannot double without somebody choosing to, and the rule that keeps it
affordable is that a knowledge section states verdicts, never the arguments
behind them.

## References

- `backend/src/modes/presentation-craft.ts` — the worked example of a knowledge
  base as prompt, including how it labels which claims are evidence and which
  are convention.
