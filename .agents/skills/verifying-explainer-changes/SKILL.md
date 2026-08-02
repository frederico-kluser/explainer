---
name: verifying-explainer-changes
description: Verifies a change with the signal that actually proves it, and records the gate's own blind spot plus the four testing techniques this repo uses. Use before declaring any task finished, before any skill is updated, and whenever choosing which command to run to prove a change works — the answer is not always the gate.
metadata:
  type: task
  verification_signal: npm run validate, plus evals.json asserting the current shape of validate.sh
---
# Verifying Explainer changes

## When to use

Before calling any task done, and before any skill is updated — the evolution
step refuses to persist anything without a signal, and this is where the signal
comes from.

## Injected knowledge

### The gate has a hole, and it is load-bearing

`validate.sh` runs the frontend suite as `npm --prefix frontend test || true` —
`validate.sh:20@4c2c46c8`. A failing frontend test **cannot** fail the gate. So
"validate passed" is evidence about lint, types, the backend suite and both
builds, and evidence about nothing on the frontend.

When a change touches `frontend/src`, run `npm --prefix frontend test`
separately and report that result on its own. This is the single most likely way
to believe a change is verified when it is not.

### Which signal proves what

| Change touches | Run |
|---|---|
| anything | `npm run validate` |
| `frontend/src` | `npm --prefix frontend test` as well, separately |
| one backend module | `npm --prefix backend test -- src/__tests__/<file>.test.ts` |
| one behaviour | `npm --prefix backend test -- -t "<test name>"` |
| a skill's claims | `node .agents/skills/scripts/run-evals.mjs <skill>` |

There is no CI. The gate is manual, so nothing runs these unless someone does.

### The four techniques this suite uses

Reach for the existing one rather than inventing a fifth:

- **Subprocess fake.** Write a small executable script that emits the real
  output shape, point the binary env var at it, then `await import()` the module
  — because it reads the binary at spawn time. This is how the pi agent is
  tested without spending credit.
- **`HOME` before import.** `sandbox.ts` freezes `homedir()`-derived roots at
  module load, so a test that needs a temp data root sets `process.env.HOME`
  first and imports dynamically — `backend/src/__tests__/storage.test.ts:8@d2ffb47c`.
- **Partial mock with `vi.importActual`.** Stub only the disk half and let the
  real resolution logic run, so the test exercises the logic it claims to.
- **`vi.stubGlobal("fetch", …)`** with `vi.unstubAllGlobals()` in `afterEach`,
  for the frontend API client.

### What cannot be tested here yet

There is no jsdom and no testing-library, so React components cannot be rendered
in the suite. Component behaviour is proven by a headless browser run against a
live app, not by a unit test — and `data-role` on `ChatBubble`
(`frontend/src/components/ui/ChatBubble.tsx:41@cbcd8183`) exists so such a run
can assert the model actually spoke rather than that some text appeared.

Two lessons from that harness, both learned by getting them wrong:

- Assert on the element that carries the meaning, not on page text. Matching a
  word anywhere on the page passed while the model had said nothing.
- Text streams in. Wait for the content to arrive rather than reading whatever
  is rendered the instant an element appears.

## Procedure

1. Pick the narrowest signal that covers the change, from the table above.
2. Run it. If it is red, fix and re-run; a red signal is the loop closing, not a
   failure of the task.
3. If the change touched `frontend/src`, run the frontend suite separately.
4. Report the actual result, including what was not covered. "Tests pass" without
   naming which suite is the shape of a false claim.

## References

- `.agents/artifacts/project-analysis.md` §4 — the full signal inventory.

## <evolution>

On completion, run the memory pipeline in `meta-skill-evolution`. This skill's
own eval asserts the current shape of `validate.sh`: if someone removes the
`|| true`, that case fails and forces this passage to be rewritten rather than
quietly going stale. That is the intended behaviour — the eval is the staleness
detector for the claim.

Update directly only for something important and externally verified: a new
technique the suite adopts, or a signal that turned out not to prove what it
claimed. Otherwise write nothing.
