---
name: managing-conversation-materials
description: Explains how a conversation's materials are resolved, gated and contained — the repo/markdown/machine kinds, the sandbox roots that bound every path an LLM supplies, and the fallback that makes a bad material reference answer about the wrong repository. Use whenever touching sources, source-store, sandbox, browse, storage or the material tools, or whenever a path is rejected, a repo will not load, or the model answers about the wrong material.
metadata:
  type: knowledge
  verification_signal: npm --prefix backend test -- src/__tests__/sandbox.test.ts src/__tests__/sources.test.ts src/__tests__/source-store.test.ts
---
# Managing conversation materials

## When to use

Editing `services/sources.ts`, `services/source-store.ts`,
`middleware/sandbox.ts`, `routes/browse.ts`, or any tool that reads a file. Also
when a path is refused with a 403, when a local repository will not load, or
when the model confidently answers about a material the user did not ask about.

## Injected knowledge

### The model chooses a material, and that choice never fails

Every material-scoped tool takes an optional `material` argument. `pickSource`
resolves it by id, by 1-based position, by exact label, by kind, then by
substring — and if nothing matches it returns the **first** material rather than
an error — `backend/src/services/source-store.ts:118@870a5860`.

The reason is that a failed tool call derails a spoken conversation, while a
fallback keeps it moving. The cost is the failure mode to watch for: a confident
answer about the wrong repository, with no error anywhere. When a user reports
"it answered about the other repo", this is the first place to look.

A conversation holds at most six materials —
`backend/src/services/source-store.ts:16@c3ba297c`. Re-adding one with the same
origin replaces it, which is how a refresh is expressed. `list_materials` is
only offered to the model when more than one material exists —
`backend/src/tools/index.ts:210@81835297` — so a single-material conversation
never sees a tool it cannot use meaningfully.

### Path containment is the security boundary

Two guards, both easy to remove by accident:

- `resolveInsideRoot` strips leading slashes before resolving —
  `backend/src/middleware/sandbox.ts:99@10b8d2f9`. Without that,
  `resolve(root, "/etc/passwd")` ignores `root` entirely and the containment
  check then validates a path it never constrained. The input comes from a
  language model, so an absolute path is an expected input, not an exotic one.
- `isInsideRoot` requires equality or a `root + separator` prefix —
  `backend/src/middleware/sandbox.ts:84@0a4a8d36` — so `/srv/repo-evil` does not
  pass as inside `/srv/repo`. A plain `startsWith` is the bug this replaces.

The outer boundary is `allowedSourceRoots()`: the clone cache, the machine-docs
root, `~/Projects`, plus anything in `EXPLAINER_REPO_ROOTS`. `/etc` answers 403.
`EXPLAINER_REPO_ROOTS` is read at call time so a test or an operator can widen
it without a restart; the `homedir()`-derived roots are frozen at module load,
which is why tests set `HOME` before importing —
`backend/src/__tests__/storage.test.ts:8@d2ffb47c`.

### Which tools a material unlocks

`toolsForSources` returns the union across materials: file tools appear only if
some material has a root on disk, so a conversation holding only pasted markdown
gets read-plus-web and nothing else. The gate is enforced again in the executor,
because the model can ask for a tool that was never offered.

### Anchor documents are budgeted twice

A material's anchor document is truncated to 24 000 chars at resolve time, then
the whole set shares a 40 000-char budget split evenly when the instructions are
built — `backend/src/prompts.ts:82@46c0f3ba`. That budget lives in the session
instructions, so it is re-billed on **every** response, not once. Raising it
raises the price of the entire call.

### Writes go through a queue

Every material and metadata change is persisted through `services/storage.ts`,
which serialises writes per conversation and writes atomically. Breaking that
loses messages or deadlocks a conversation permanently — read
`references/persistence-invariants.md` before editing that file.

## References

- `references/persistence-invariants.md` — the write queue, the append-inside-lock
  rule, and the caches that are never cleared. Read it before touching
  `services/storage.ts`.

## Escape hatch

Widening the sandbox is a configuration change (`EXPLAINER_REPO_ROOTS`), not a
code change. If a task seems to need `assertAllowedSourceRoot` relaxed, that is
the signal to stop and ask.
