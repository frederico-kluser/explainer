# Skill map — Explainer

Phase 2 artifact. Nothing is generated yet; this is the proposal that Phase 3
implements. Grounded in `.agents/artifacts/project-analysis.md`.

## Granularity rule used

A skill is the unit that gets **retrieved together**. Split two bodies of
knowledge when disjoint tasks need them; merge them when one is never needed
without the other. Against that, every extra skill degrades routing — selection
happens on descriptions alone, among all of them — so a candidate must earn its
slot by being both high-consequence and hard to infer from a neighbouring file.

Candidates were ranked by *consequence of getting it wrong* × *non-inferability
from the code*. Three did not survive:

- **A frontend/UI skill.** Most of it (dark mode forced, token set, component
  layout) is inferable by reading any neighbouring component. Only three facts
  are genuinely non-obvious — motion timings come from `useMotionUITransition`
  rather than literals, `motion-ui/**` is vendored and lint-ignored, and
  `data-role` exists purely as a test hook. Those are code style, so they were
  **folded into `writing-explainer-code`** rather than given a routing slot.
- **A persistence skill.** The storage invariants are sharp and catastrophic
  (a broken write queue deadlocks a conversation forever) but the surface is one
  file and the retrieval frequency is low. **Demoted to
  `managing-conversation-materials/references/persistence-invariants.md`** —
  progressive disclosure gives the knowledge without spending a routing slot.
- **A separate API-contract skill.** The route shapes are readable from
  `routes/*.ts` in seconds. Documenting them would be a generic overview, which
  the mission explicitly rejects.

Result: router + style + 4 domains + 2 task + 2 meta = **10 skills**.

## Catalog

### Router

| | |
|---|---|
| **name** | `project-router` |
| **type** | router |
| **description (draft)** | Routes every implementation task in this codebase to the correct skills before any step is taken. Use whenever the user asks for any change, fix, feature, analysis or refactor, even if they never mention skills. |
| **why it exists** | One dispatch point; without it each skill competes for attention and the composition order is left to chance. |
| **verification signal** | none — it writes no knowledge of its own. |

### Knowledge skills (semantic memory)

| name | why it exists | verification signal |
|---|---|---|
| `writing-explainer-code` | The Express 5 route-param trap, the `.js` specifier requirement, what tooling already guarantees (so nobody re-documents it), and the three non-obvious UI conventions. Loaded on essentially every task. | `npm run lint && npm run typecheck`, plus an eval asserting no handler on a parameterised route carries `(req: Request, res: Response)` |
| `integrating-openai-realtime` | The protocol fails **silently**: a nested tool schema yields zero tools with no error, and a mistimed `response.create` loses the turn. Highest consequence, lowest discoverability. | `npm --prefix frontend test -- src/__tests__/realtime.test.ts` — named directly, because `validate.sh` cannot fail on frontend tests |
| `managing-conversation-materials` | The security boundary (path containment) and the fact that `pickSource` never fails, so a bad material reference produces a confident answer about the wrong repository. | `npm --prefix backend test -- src/__tests__/sandbox.test.ts src/__tests__/sources.test.ts src/__tests__/source-store.test.ts` |
| `dispatching-pi-agents` | Spawns an external process with the user's own API credit, and carries the replay rule that stops the model re-narrating hour-old answers. | `npm --prefix backend test -- src/__tests__/agent-jobs.test.ts` |
| `tracking-costs-and-credits` | Two silent-money failures: cached tokens double-billed if not subtracted, and an unrecognised model reporting `usd: 0` while still burning credit. | `npm --prefix backend test -- src/__tests__/pricing.test.ts` |

### Task skills (procedural memory)

| name | why it exists | verification signal |
|---|---|---|
| `adding-realtime-tools` | The most common change in this repo, and it spans six files across both packages. Missing the executor gate or the frontend bridge produces a tool the model can see but never successfully call. | `npm run validate` **and** `npm --prefix frontend test` |
| `verifying-explainer-changes` | Encodes which command proves what, the established test techniques, and the gate's two blind spots — the `\|\| true` on the frontend suite, and the fact that nothing lints `electron/` or `src/shared/`. Its eval pins each blind spot in whichever direction the repo moves, so a change to the gate forces the skill to be revalidated rather than silently going stale. | `npm run validate`, plus cases asserting the current shape of `validate.sh` |

The design intent behind that last cell has now been exercised, and it is worth
recording what happened, because it cuts against how the mechanism was first
described. This map originally said the eval "asserts the hole still exists" —
as though a case could only ever pin an absence. When the desktop work extended
the gate, the reach hole was **closed**, and the honest response was to invert
the cases rather than delete them: `gate-runs-the-desktop-suite`,
`gate-builds-the-desktop` and `gate-typechecks-the-four-projects` now assert the
gate **does** reach `electron/` and `src/shared/`, so a later change that drops
one of those sections turns the skill red instead of leaving it quietly
over-claiming. The cases that still assert an absence are the two surviving
blind spots: `gate-hole-still-present` for the `|| true`, and
`gate-lints-nothing-desktop` / `root-lint-is-only-the-two-packages` /
`no-root-eslint-config` for the lint gap. The generalisation: an eval pins the
*current* shape of the signal, in whichever direction that shape happens to
point, and closing a hole is a reason to rewrite a case, never to remove one.

### Meta skills

| name | why it exists | verification signal |
|---|---|---|
| `meta-skill-evolution` | Decides update / propose-new / discard for a candidate learning, and owns the five-step memory pipeline. | `node .agents/skills/scripts/lint-skills.mjs` |
| `meta-skill-consolidate` | Scheduled GC: dedup, conflict resolution, provenance staleness, token budget. Deletions need a second-opinion review. | `lint-skills.mjs` + `provenance.mjs check` |

## Composition graph

```
                        project-router
                              │  asks (pt-BR), writes TASK_PLAN.md, classifies
                              ▼
                    writing-explainer-code          ← always, every task
                              │
        ┌─────────────────────┼─────────────────────┬──────────────────┐
        ▼                     ▼                     ▼                  ▼
integrating-          managing-conversation-  dispatching-      tracking-costs-
openai-realtime         materials              pi-agents        and-credits
        │                     │                     │                  │
        └─────────────────────┴──────────┬──────────┴──────────────────┘
                                         ▼
                              adding-realtime-tools     ← task, composes the above
                                         │
                                         ▼
                             verifying-explainer-changes ← task, closes every loop
                                         │
                                         ▼   on completion
                                meta-skill-evolution
                                         │   periodically
                                         ▼
                               meta-skill-consolidate
```

Parallelisable: the four domain skills are independent of one another and can be
loaded by isolated-context subagents in parallel. Strictly ordered:
`writing-explainer-code` before any implementation, and
`verifying-explainer-changes` before the evolution step — nothing may be
persisted before the loop that produces the signal has closed.

Which domain skills a task pulls, by trigger:

- touches `tools/`, `useRealtimeSession`, session config, a lost turn →
  `integrating-openai-realtime`
- touches `sources`, `source-store`, `sandbox`, `browse`, paths →
  `managing-conversation-materials`
- touches `agent-jobs`, `pi`, SSE, a long-running tool → `dispatching-pi-agents`
- touches `pricing`, `costs`, `credits`, a model id → `tracking-costs-and-credits`

## Per-skill eval design

Each skill ships `evals.json` with three kinds of case, all offline and
deterministic:

- `command` — the verification signal itself (a real test run).
- `file_matches` / `file_absent_match` — **entailment**: the source a claim
  cites must actually say it. "The file exists" is not evidence that the claim
  is true, and this is what stops a clean, well-cited, false rule from being
  promoted.
- `citations_fresh` — every `path:line@hash` still resolves.

The runner mints a short-lived validation token on green. The Phase 4 write-gate
hook refuses to edit a SKILL.md without that token, which is what turns "verify
before persisting" from a request into a guarantee.

## What this map deliberately does not do

- No skill documents route shapes, folder layout, or "the project uses
  TypeScript". That is a generic overview and is already in the code.
- No skill restates a convention from the tooling-guaranteed table in the Phase 1
  analysis. Where a check exists, the skill points at the check.
- No `LEARNINGS.md`, no buffers, no per-skill changelog. The SKILL.md body is the
  memory and git is the history.
