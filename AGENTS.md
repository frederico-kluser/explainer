# AGENTS.md

Explainer — a realtime voice app: the browser holds a WebRTC session with an
OpenAI realtime model, and every tool the model calls runs on the Express
backend.

## Commands

- setup: `npm run setup` — `backend` and `frontend` only. The root install
  (Electron, electron-vite, vitest) is a separate `npm install`, and the gate
  needs it.
- dev (web): `npm run dev` — `bash dev.sh`, backend 3001 + frontend 5173, and it
  opens the frontend itself once that port identifies itself as ours. Both ports
  move when a stranger holds them: the frontend walks 5173→5177, the backend
  3001→3005, and Vite's `/api` proxy follows through `EXPLAINER_API_PORT`.
  `PORT=` pins the backend port and disables that move. A port is probed on
  **both** loopback stacks — a listener on `::1` alone is invisible to an IPv4
  probe, which is how a stranger's Vite once killed the run. `BROWSER=none`,
  `NO_OPEN=1` or `bash dev.sh --no-open` suppress the browser. `npm start` is
  the same script.
- dev (desktop): `npm run dev:desktop` (alias `dev:electron`) — `electron-vite dev`.
  The main process probes 3001 first and reuses a backend already answering
  there instead of spawning a second one, so it can run alongside `npm run dev`.
- build (web): `npm run build` — `backend build && frontend build`. That is what
  this document means by build; `validate.sh` runs it and the desktop build too.
- build (desktop): `npm run build:desktop` (`electron-vite build`).
  `npm run dist` / `npm run dist:win` run it and then package with
  electron-builder; the packaged app does not reach the backend yet — see the
  known limitation in `README.md`.
- lint: `npm run lint`
- typecheck: `npm run typecheck` — four projects: backend, frontend,
  `tsconfig.node.json` (Electron main + preload) and `tsconfig.web.json`.
- test (backend): `npm --prefix backend test`
- test (single file): `npm --prefix backend test -- src/__tests__/pricing.test.ts`
- test (single case): `npm --prefix backend test -- -t "clamps speed into the range the API accepts"`
- test (frontend): `npm --prefix frontend test`
- test (desktop): `npx vitest run --root . electron/main/services/__tests__/backend-process.test.ts`
  — no package script wraps it; the gate runs this exact line.
- gate: `npm run validate`

`npm run validate` runs the frontend suite with `|| true`, so a failing frontend
test cannot fail the gate. Any change touching `frontend/src` needs
`npm --prefix frontend test` run separately, and its result reported separately.

The gate's other blind spot is lint: nothing lints `electron/` or `src/shared/`.
`validate.sh` has no lint section for the desktop, `npm run lint` is the two
package scripts, and the only ESLint configs are `backend/eslint.config.js` and
`frontend/eslint.config.js` — there is none at the root. ~2,900 lines of main
process, preload and shared types that no linter has read.

Reach is covered. `validate.sh` typechecks all four projects (`TypeCheck Root`,
which is what reaches `tsconfig.node.json` and `tsconfig.web.json`), runs the
main-process suite (`Test Desktop`) and builds the desktop bundle
(`Build Desktop`). Neither desktop step carries `|| true`. Both resolve their
binary from the root install, which `npm run setup` does not do, so
`npm run validate` needs a root `npm install` first.

There is no CI. These commands run only when someone runs them.

## Rules

Only what differs from language defaults and is not already enforced by lint or
tsc. Everything else — `any`, unused vars, strict null checks, case-correct
imports — is a tooling error, not a convention to remember.

- Backend imports carry the `.js` extension (`./services/openai.js`) because
  Node's ESM loader needs it at runtime; the bundler-mode compiler will not
  catch a missing one.
- `import "./load-env.js"` stays first in `backend/src/index.ts` — `sandbox.ts`
  freezes `homedir()`-derived roots at module load.
- Express 5 handlers on routes containing `:` are left unannotated. Adding
  `(req: Request, res: Response)` discards route-param inference and widens
  `req.params.x` to `string | string[]`.
- Code, comments and commits are English. Strings the user sees or hears — UI
  copy, `prompts.ts`, spoken tool output — are Brazilian Portuguese.
- Comments record why, not what. `git log -p` already covers what changed.
- Animation timings come from `useMotionUITransition(...)`, never literals.
- `frontend/src/components/motion-ui/**` is vendored registry code; wrap it in
  `components/ui/` instead of editing it.

## Skills

Every task goes through `.agents/skills/project-router`.
Catalog: `.agents/skills/catalog.md`.

`.claude/skills` is a symlink to `.agents/skills`, so the same library works
across tools. Skill frontmatter carries only `name`, `description` and
`metadata` for the same reason.

A skill is updated only after `node .agents/skills/scripts/run-evals.mjs <skill>`
passes; a hook enforces it. Importance alone does not authorise a write —
relevance is not truth.

## Security

- Never read or commit `.env` or `secrets/**`.
- Paths supplied by the model are contained by `middleware/sandbox.ts`. Widening
  `allowedSourceRoots()` is a decision to confirm with the user, not a fix.
- The `pi` agent runs read-only (`-t read,glob,grep,find,ls --no-approve`)
  because it is pointed at repositories the user did not write.

## Stale documents

`PLAYBOOK.md` and `SMOKE_TEST.md` both describe the pre-realtime architecture
and carry banners saying so. `README.md` is the current one.
