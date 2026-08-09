# AGENTS.md

Explainer — a realtime voice app: the browser holds a WebRTC session with an
OpenAI realtime model, and every tool the model calls runs on the Express
backend.

## Commands

- setup: `npm run setup`
- dev (web): `npm run dev` — `bash dev.sh`, backend 3001 + frontend 5173, and it
  opens http://localhost:5173 itself once 5173 accepts a socket. `BROWSER=none`,
  `NO_OPEN=1` or `bash dev.sh --no-open` suppress that. `npm start` is the same
  script.
- dev (desktop): `npm run dev:desktop` (alias `dev:electron`) — `electron-vite dev`.
  The main process probes 3001 first and reuses a backend already answering
  there instead of spawning a second one, so it can run alongside `npm run dev`.
- build (web): `npm run build` — `backend build && frontend build`. That is what
  `validate.sh` and this document mean by build.
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
- gate: `npm run validate`

`npm run validate` runs the frontend suite with `|| true`, so a failing frontend
test cannot fail the gate. Any change touching `frontend/src` needs
`npm --prefix frontend test` run separately, and its result reported separately.

The gate's other blind spot is reach: every step in `validate.sh` is
`npm --prefix backend …` or `npm --prefix frontend …`, so nothing under
`electron/` or `src/shared/` is linted, typechecked, tested or built by
`npm run validate`. Root `npm run typecheck` is the only script that covers the
Electron main process, and no script in `package.json` runs the tests under
`electron/main/services/__tests__/`.

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
