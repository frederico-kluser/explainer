# Skill catalog — Explainer

The index `project-router` reads before selecting. Source of truth:
`.agents/skills/`, symlinked to `.claude/skills` for tool portability.

Every task in this repo goes through the router. Load
`writing-explainer-code` on any task that edits code; add the domain skills the
triggers below match; finish with `verifying-explainer-changes`.

## Router

| skill | use it |
|---|---|
| `project-router` | Every implementation task, before any step. Asks in Portuguese, writes `TASK_PLAN.md`, selects the chain, deletes the plan at the end. |

## Knowledge

| skill | covers | triggers | verified by |
|---|---|---|---|
| `writing-explainer-code` | Express 5 route-param trap, `.js` runtime specifiers, what lint/tsc already guarantee, motion vocabulary, forced dark mode, vendored `motion-ui` | any edit under `backend/src` or `frontend/src` | `npm run lint && npm run typecheck` |
| `integrating-openai-realtime` | flat tool schema, ack gate before `response.create`, both ack event names, barge-in, session limits, no hosted web search | `tools/`, `routes/realtime.ts`, `useRealtimeSession`, `lib/realtime.ts`; a lost turn; a tool never called | `npm --prefix frontend test -- src/__tests__/realtime.test.ts` |
| `managing-conversation-materials` | material kinds, `pickSource` never failing, sandbox containment, tool gating, doc budget; persistence invariants in `references/` | `sources`, `source-store`, `sandbox`, `browse`, `storage`; a 403; the wrong repo answered | `npm --prefix backend test -- src/__tests__/{sandbox,sources,source-store}.test.ts` |
| `dispatching-pi-agents` | read-only allowlist, `--no-approve`, one job per conversation, 180 s timeout, the `replay: true` rule | `agent-jobs`, `routes/agents.ts`, SSE, `dispatch_pi_agent`; a hung job; an answer spoken twice | `npm --prefix backend test -- src/__tests__/agent-jobs.test.ts` |
| `tracking-costs-and-credits` | rate card, cached-token subtraction, silent `usd: 0` on an unknown model, three provider balance shapes | `pricing`, `costs`, `credits`, or any model id anywhere | `npm --prefix backend test -- src/__tests__/pricing.test.ts` |
| `building-conversation-modes` | what a mode owns and what stays shared, the mode frozen at creation, `requiresMaterial` and the three places it reaches, the non-reentrant document lock, the prompt-section tool gate, the instruction budget | `backend/src/modes/**`, `document-store`, the markdown sidebar; a conversation behaving as the wrong kind; a document write that never answers | `npm --prefix backend test -- src/__tests__/{modes,mode-routes,document-store,document-tools}.test.ts` |

## Task

| skill | covers | triggers | verified by |
|---|---|---|---|
| `adding-realtime-tools` | the six places a tool lives and the distinct silent failure of skipping each | "the assistant should be able to…"; a tool defined but never called | `npm run validate` **and** `npm --prefix frontend test` |
| `verifying-explainer-changes` | which signal proves what, the gate's two holes (`\|\| true` on the frontend, nothing lints `electron/` or `src/shared/`), the five test techniques including per-file happy-dom rendering, what a mount still cannot reach | before declaring anything done; before any skill update | `npm run validate` + an eval asserting the gate's current shape |

## Meta

| skill | covers |
|---|---|
| `meta-skill-evolution` | the five-step memory pipeline; decides update / propose-new / discard for a candidate learning |
| `meta-skill-consolidate` | scheduled GC: dedup, conflict resolution, provenance staleness, token budget, second-opinion review before deletion |

## Running the checks

```bash
node .agents/skills/scripts/lint-skills.mjs          # form of every skill
node .agents/skills/scripts/provenance.mjs check     # every path:line@hash still true
node .agents/skills/scripts/run-evals.mjs <skill>    # a skill's claims + its signal
node .agents/skills/scripts/run-evals.mjs --all
```

`run-evals.mjs` mints the short-lived token that the write-gate hook demands
before any `SKILL.md` may be edited. That is the mechanism behind the one rule
this library will not bend: knowledge is persisted only when something outside
the model says it is true.
