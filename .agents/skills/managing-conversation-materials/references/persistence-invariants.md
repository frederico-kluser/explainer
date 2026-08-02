# Persistence invariants — `backend/src/services/storage.ts`

Loaded on demand. Read this before editing `storage.ts`; the failure modes here
are silent data loss and permanent deadlock, neither of which any test in the
suite will catch if the invariant is removed rather than broken.

## The per-conversation write queue chains on both settle paths

`const result = previous.then(operation, operation);` —
`backend/src/services/storage.ts:56@041efa7a`

The same `operation` is passed as both the fulfil and the reject handler. That
is deliberate. Chain on success only — `previous.then(operation)` — and a single
failed write leaves the chain permanently rejected, so every later write to that
conversation is dropped for the lifetime of the process. The conversation
appears to accept messages and silently persists none of them.

## `appendMessages` re-reads inside the lock

The array read at the start of a turn is stale by the time the write runs.
`appendMessages` re-reads the conversation inside the lock and appends to what
is on disk. Handing back the array captured earlier erases whatever a concurrent
turn wrote in between — with two quick turns, the slower one wipes the faster one
off disk.

This is why routes call `appendMessages` rather than mutating `conv.messages`
and calling `updateConversation`.

## Writes are atomic

Content goes to a temporary file and is renamed into place, so a crash mid-write
cannot leave a truncated JSON file that fails to parse on the next boot.

## Fields the outside cannot set

`id` and `created_at` are immutable on update. `summary` and `summarized_count`
are rejected by `PATCH /api/conversations/:id` and stripped even when nested
inside `metadata`, because they are managed internally.

## Caches that are never cleared

`forgetSources` — `backend/src/services/source-store.ts:78@df7d4e4c` — and
`forgetCosts` both exist and neither is called anywhere in production. Deleting a
conversation removes its files but leaves both in-memory caches populated. This
is a known latent leak, recorded rather than fixed: it is bounded by process
lifetime and by the retention caps, so it has not been worth a change. If a task
touches conversation deletion, wiring these in is the obvious adjacent fix.

## The cost ledger is monotonic on purpose

`total_usd` is `max(inMemory, persisted)` so the number never appears to go
backwards after a restart. The consequence is that `by_source` — which is
in-memory only — will not sum to `total_usd` once the process has restarted. Any
reconciliation that assumes they agree is wrong.
