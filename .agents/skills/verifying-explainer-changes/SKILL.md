---
name: verifying-explainer-changes
description: Verifies a change with the signal that actually proves it, and records the gate's two blind spots plus the five testing techniques this repo uses. Use before declaring any task finished, before any skill is updated, and whenever choosing which command to run to prove a change works — the answer is not always the gate.
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

### The gate has holes, and they are load-bearing

`validate.sh` runs the frontend suite as `npm --prefix frontend test || true` —
`validate.sh:28@4c2c46c8`. A failing frontend test **cannot** fail the gate. So
"validate passed" is evidence about lint, types, the backend suite, the desktop
suite and all three builds, and evidence about nothing on the frontend.

When a change touches `frontend/src`, run `npm --prefix frontend test`
separately and report that result on its own. This is the single most likely way
to believe a change is verified when it is not.

The second hole is quieter, because it is an omission rather than a `|| true`:
nothing lints `electron/` or `src/shared/`. `validate.sh` has no lint section for
the desktop, the root script is
`"lint": "npm --prefix backend run lint && npm --prefix frontend run lint"` —
`package.json:22@2a5ff98b` — and the only ESLint configs in the repository are
`backend/eslint.config.js` and `frontend/eslint.config.js`; there is none at the
root. That leaves ~2,900 lines of main process, preload and shared types no
linter has ever read, so a green gate says nothing about style, unused bindings
or the rules the two packages take for granted.

Reach is no longer the hole it once was. The gate typechecks all four projects
(`validate.sh:22@982c1455` — that step is where `tsconfig.node.json` and
`tsconfig.web.json` are compiled), runs the main-process suite
(`validate.sh:37@c4a6db1b`) and builds the desktop bundle
(`validate.sh:49@9e9d8691`). Neither desktop step carries `|| true`, so both can
fail the gate. Both resolve their binary from the root install while
`npm run setup` installs only `backend` and `frontend` —
`package.json:23@5ded0fd1` — so a root `npm install` is now a prerequisite of
the gate itself; without one `npx` fetches whatever major version it likes and
the run dies in the transform rather than in a test.

### Which signal proves what

| Change touches | Run |
|---|---|
| anything | `npm run validate` |
| `frontend/src` | `npm --prefix frontend test` as well, separately |
| `electron/` or `src/shared/` | `npm run validate` covers types, tests and build; read the diff for what a linter would have caught, because nothing lints these |
| the desktop suite on its own, while iterating | `npx vitest run --root . electron/main/services/__tests__/backend-process.test.ts` |
| one backend module | `npm --prefix backend test -- src/__tests__/<file>.test.ts` |
| one behaviour | `npm --prefix backend test -- -t "<test name>"` |
| a skill's claims | `node .agents/skills/scripts/run-evals.mjs <skill>` |

There is no CI. The gate is manual, so nothing runs these unless someone does.

### The five techniques this suite uses

Reach for the existing one rather than inventing a sixth:

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
- **React through `act`, opted into per file.** `happy-dom` is a frontend
  devDependency and `frontend/vitest.config.ts` sets no environment, so a
  rendering test opts in with `/** @vitest-environment happy-dom */` as its
  first line — `frontend/src/__tests__/setup-gate.test.tsx:1@5b310af9` — and
  every other file in the suite keeps running in Node. There is no
  `@testing-library`: the harness is `createRoot` from `react-dom/client`
  driven by `act` imported from `react`, with
  `globalThis.IS_REACT_ACT_ENVIRONMENT = true`. `app-setup-gate.test.tsx` mounts
  the whole `App` that way and substitutes only `useRealtimeSession` — it would
  open an `RTCPeerConnection` and an `EventSource` — and `fetch`.

Two things travel with that last technique. First, a test that reads source off
disk stays in the Node environment, because `import.meta.url` is a `file://` URL
only there — `frontend/src/__tests__/setup-gate-caller.test.ts:13@e5313820`; give
it its own file rather than moving the rendering cases out of happy-dom. Second,
mounting is what separates proving a branch from describing it: a suite that
never renders the branch stays green when the branch is inverted, which is why
`app-setup-gate.test.tsx` mounts the real `App` and asserts both directions —
`frontend/src/__tests__/app-setup-gate.test.tsx:15@1fa938a8`.

### What a mount still cannot reach

A `happy-dom` mount has no audio, no WebRTC and no backend, so whether the model
actually spoke is proven by a headless browser run against a live app, not by a
unit test — and `data-role` on `ChatBubble`
(`frontend/src/components/ui/ChatBubble.tsx:42@cbcd8183`) exists so such a run
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
3. If the change touched `frontend/src`, run that suite separately — the gate
   cannot fail on it. A change under `electron/` or `src/shared/` needs no extra
   command, but it does need the diff read for what a linter would have caught.
4. Report the actual result, including what was not covered. "Tests pass" without
   naming which suite is the shape of a false claim.

## References

- `.agents/artifacts/project-analysis.md` §4 — the full signal inventory.

## <evolution>

On completion, run the memory pipeline in `meta-skill-evolution`. This skill's
own eval asserts the current shape of `validate.sh` in both directions: remove
the `|| true` and the first blind spot's passage is forced open; remove the
`TypeCheck Root`, `Test Desktop` or `Build Desktop` section and the paragraph
claiming the gate reaches the desktop fails with it; add a lint step for
`electron/` — in `validate.sh`, in the root `lint` script, or as the first
root-level ESLint config — and the second blind spot's passage is forced open in
turn. That is the intended behaviour: the eval is the staleness detector for
each claim, in whichever direction the repository moves. Sibling cases pin
`happy-dom`, the absent `@testing-library` and the environment-free
`frontend/vitest.config.ts`, because the day any of those moves the rendering
technique above becomes advice to write a test that cannot run.

Update directly only for something important and externally verified: a new
technique the suite adopts, or a signal that turned out not to prove what it
claimed. Otherwise write nothing.
