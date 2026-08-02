# Project analysis — Explainer

Phase 1 artifact of the knowledge-skills bootstrap. Everything below was read
from the repository at commit `92a2577`; nothing is carried over from
assumptions about the project. Claims carry `path:line@hash` provenance, where
the hash is sha256 over the normalised content of the cited line
(`.agents/skills/scripts/provenance.mjs`). Where a thing was looked for and does
not exist, it is recorded as **not found** rather than guessed.

## 1. Normative documentation

Discovered docs: `README.md`, `PLAYBOOK.md`, `SMOKE_TEST.md`.
**Not found:** `docs/`, `doc/`, `docs/adr/`, `docs/decisions/`, `CONTRIBUTING*`,
`ARCHITECTURE*`, RFC or design-doc directories, `AGENTS.md`, `CLAUDE.md`, and any
CI configuration (`.github/`, `.gitlab-ci.yml`, Jenkinsfile, husky,
`.pre-commit-config.yaml`; `.git/hooks` holds only unmodified samples).

### README.md — the current normative document

Verbatim excerpts that ground later decisions:

> "Uma conversa segura **vários materiais ao mesmo tempo** (até seis) — você
> adiciona e remove quando quiser, e o modelo escolhe de qual deles tirar cada
> resposta." — `README.md:9`

> "**O áudio não passa pelo backend.** O browser abre a própria conexão WebRTC.
> O backend só cunha um token curto com o modelo, a voz, as instruções e a lista
> de ferramentas já fixados do lado do servidor" — `README.md:105`

> "A `response.create` só é disparada depois que todos os outputs foram
> confirmados — mandar antes é o jeito clássico de perder o turno com
> *\"Conversation already has an active response\"*." — `README.md:113`

> "`dispatch_pi_agent` responde em milissegundos com um id de job; o agente roda
> em background com allowlist somente-leitura e timeout de 180 s" — `README.md:117`

### PLAYBOOK.md — explicitly historical

Carries a self-declared staleness banner at the top:

> "**Histórico — arquitetura substituída em 2026-08-01.** Este playbook descreve
> a construção da versão original: gravar → Whisper → DeepSeek com tool calling
> → TTS, tudo em turnos." — `PLAYBOOK.md:1`

Correctly labelled. No skill should cite it as current.

### SMOKE_TEST.md — STALE AND UNLABELLED (finding)

It describes an architecture that no longer exists and carries no warning:
`OPENROUTER_API_KEY` as the required key, `MediaRecorder`, a `web_research`
tool, file attachments, and `read_file` — none of which survive commit
`92a2577`. Sample: `"- [ ] \`OPENROUTER_API_KEY\` em \`.env\`"` —
`SMOKE_TEST.md:5`.

This matters beyond tidiness. An unlabelled stale doc is a retrieval hazard: an
agent grounding itself in the repo will read it, follow it, and propagate the
error — the exact failure mode this skills system exists to prevent. **Proposed
remedy** (Phase 3): prepend the same one-line staleness banner PLAYBOOK.md
already carries. Rewriting its content is out of scope for this mission.

## 2. Stack and structure

Two npm workspacesless packages under one repo root, Node ≥ 22 (`package.json:6`).

- **backend** — Express 5 + TypeScript ESM. Dependencies are only `cors`,
  `express`, `uuid`. No ORM, no DI container, no logger library. Persistence is
  JSON files under `~/.local/share/voice-assistant`.
- **frontend** — React 19 + Vite 6 + TypeScript, Tailwind v4 (CSS-first, no
  config file), Base UI primitives, `motion` v12 plus the premium
  `motion-plus`.

Backend layering, as actually observed: `routes/` (HTTP shape only) →
`services/` (contracts and state) → `tools/` (what the model may call) →
`middleware/sandbox.ts` (the security boundary). `prompts.ts` builds the session
instructions. `index.ts` mounts seven routers and binds `127.0.0.1` only.

Frontend: all application state lives in `App.tsx`; the entire realtime session
lifecycle lives in one hook, `useRealtimeSession.ts` (613 lines), and
`lib/realtime.ts` holds the protocol constants. Components under
`components/ui/` are hand-written; `components/motion-ui/**` is vendored
registry code.

## 3. Conventions already guaranteed by tooling

These must **not** be restated as prose in any skill — a tool already enforces
them, and prose that duplicates a check only adds tokens and rots
independently.

| Guaranteed | By |
|---|---|
| no implicit `any`, strict null checks | `"strict": true` — `backend/tsconfig.json:7` |
| indexed access yields `\| undefined` | `"noUncheckedIndexedAccess": true` — `backend/tsconfig.json:8@69d8bf24` |
| erasable type-only imports | `"isolatedModules": true` |
| import paths match case on disk | `"forceConsistentCasingInFileNames": true` |
| `@/*` resolves to `frontend/src/*` | a real compiler path, mirrored in vite and vitest config |
| no explicit `any` | `@typescript-eslint/no-explicit-any` via `tseslint.configs.recommended` |
| unused vars are errors unless `_`-prefixed | `backend/eslint.config.js:10` |
| no `require()` in TS, no bare `@ts-ignore` | `no-require-imports`, `ban-ts-comment` |

**Explicitly NOT guaranteed** — so prose or a custom check is legitimate here:
no type-aware lint (`recommended`, not `recommended-type-checked`); **no
`react-hooks` plugin**, so stale-closure and dependency-array bugs are caught by
nobody; no formatter config anywhere; no import-order rule;
`no-non-null-assertion` is off, so `!` is idiomatic in this codebase.

**Coverage holes:** lint scope is `src/` only, so `vite.config.ts`,
`vitest.config.ts` and `eslint.config.js` are neither linted nor type-checked.
`frontend/src/components/motion-ui/**` is lint-ignored —
`frontend/eslint.config.js:14@1904982d` — but still type-checked.

## 4. The verification signals this repo actually has

The mission's central rule is that no knowledge is persisted without an external
signal. This is the complete inventory of signals available here.

| Signal | Command | Strength |
|---|---|---|
| full gate | `npm run validate` | strong, but see the hole below |
| backend tests | `npm --prefix backend test` | strong — 82 tests, 8 files |
| single test | `npm --prefix backend test -- -t "<name>"` | strong |
| frontend tests | `npm --prefix frontend test` | strong when run directly |
| lint | `npm run lint` | strong for what it covers |
| type-check | `npm run typecheck` | strong |
| build | `npm run build` | strong |

**Hole, and it is load-bearing:** `validate.sh` runs the frontend suite as
`npm --prefix frontend test || true` — `validate.sh:20@4c2c46c8`. A failing
frontend test **cannot** fail the gate. So "validate.sh passed" is not evidence
about frontend behaviour, and any skill whose verification signal is a frontend
test must name `npm --prefix frontend test` directly rather than the gate. This
correction came from a subagent reading the file; it contradicted what this
analysis would otherwise have asserted, which is precisely why the reading was
delegated instead of recalled.

**No CI exists.** The gate is manual. That raises the value of the local hooks
proposed in Phase 4: they are the only automated enforcement point in the repo.

## 5. Candidate knowledge areas

Ranked by how expensive a mistake in each area is, and by how badly the
knowledge is inferable from the code alone.

1. **Realtime protocol contract** — flat tool schema (nesting silently yields
   zero tools, no error — `backend/src/tools/index.ts:6@cdb48364`); never
   `response.create` while one is active
   (`frontend/src/hooks/useRealtimeSession.ts:100@491de366`); the ack-gate loop
   must stay synchronous with `pendingAcks.add` before the send; both
   `conversation.item.added` and `.created` must be accepted
   (`frontend/src/lib/realtime.ts:95@2623ae7a`); the Realtime API has no hosted
   web search (`backend/src/tools/web-search.ts:17@048ec308`).
2. **Materials and the sandbox** — ≤6 materials
   (`backend/src/services/source-store.ts:16@c3ba297c`); `pickSource` never
   fails and silently falls back to the first material
   (`backend/src/services/source-store.ts:118@870a5860`); `resolveInsideRoot` strips leading slashes
   so an LLM-supplied absolute path cannot escape; `isInsideRoot` blocks the
   sibling-prefix bypass (`backend/src/middleware/sandbox.ts:16@d10b36aa`).
3. **Costs** — `input_token_details` counts cached tokens inside each modality
   total and must be subtracted (`backend/src/services/pricing.ts:117@c165e691`);
   an unrecognised model returns `usd: 0` **silently**, so a model rename makes
   the meter read zero; `DOC_BUDGET` lives in the instructions and is therefore
   re-billed on every response.
4. **pi agent dispatch** — read-only allowlist, `--no-approve`, one job per
   conversation, 180 s timeout; `PI_BIN` deliberately read at call time
   (`backend/src/services/agent-jobs.ts:24@ce8d0ac2`); SSE replays carry
   `replay: true` and must not be spoken again.
5. **Code style and framework traps** — Express 5 loses route-param inference
   when a handler is annotated `(req: Request, res: Response)`, and the
   surviving annotations sit only on parameterless routes; module-load-frozen
   `homedir()` forces tests to set `HOME` before importing; the error handler
   must branch on `res.headersSent` for SSE routes.
6. **Persistence concurrency** — the per-conversation write queue chains on both
   settle paths, and `appendMessages` re-reads inside the lock; breaking either
   loses messages or deadlocks a conversation permanently.
7. **Frontend/UI conventions** — dark mode is forced, not toggleable; motion
   timings are never literals but come from `useMotionUITransition` over
   `frontend/motion.theme.ts:5@d5d0ddc7`; `motion-ui/**` is vendored and must
   not be hand-edited; `data-role` on ChatBubble exists solely so a test can
   assert the model spoke.
8. **Verification practice** — no jsdom and no testing-library, so component
   render tests are not currently possible; the established techniques are
   subprocess fakes (`PI_BIN` pointed at a generated script), `vi.importActual`
   partial mocks, and `HOME`-before-import dynamic imports.

## 6. Latent issues surfaced (not fixed here)

Recorded because a future task may hit them; none is in scope for this mission.

- `forgetSources` and `forgetCosts` exist but are never called in production, so
  deleting a conversation leaves both caches populated.
- `backend/dist/__tests__/transcript.test.js` and `summarizer.test.js` are
  compiled leftovers of deleted sources.
- `validateConversationPath` throws a plain 400 `Error` while its siblings throw
  `SandboxError` (403) — an inconsistency in the sandbox surface.
- `frontend/components.json` names a `tailwind.config.ts` that does not exist,
  because Tailwind v4 is CSS-first here.

## 7. Method note

Four isolated-context subagents mapped the backend, the frontend, the
testing/tooling surface, and the non-obvious invariants, each returning a
condensed summary rather than file contents. Two of their findings contradicted
what would otherwise have been written from recall — the `|| true` gate hole and
the storage write-queue semantics. That is the point of the delegation: a
model's memory of a codebase is not evidence about the codebase.
