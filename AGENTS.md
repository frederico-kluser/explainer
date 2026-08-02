# AGENTS.md

Explainer — a realtime voice app: the browser holds a WebRTC session with an
OpenAI realtime model, and every tool the model calls runs on the Express
backend.

## Commands

- setup: `npm run setup`
- dev: `npm run dev` (backend 3001 + frontend 5173)
- build: `npm run build`
- lint: `npm run lint`
- typecheck: `npm run typecheck`
- test (backend): `npm --prefix backend test`
- test (single file): `npm --prefix backend test -- src/__tests__/pricing.test.ts`
- test (single case): `npm --prefix backend test -- -t "clamps speed into the range the API accepts"`
- test (frontend): `npm --prefix frontend test`
- gate: `npm run validate`

`npm run validate` runs the frontend suite with `|| true`, so a failing frontend
test cannot fail the gate. Any change touching `frontend/src` needs
`npm --prefix frontend test` run separately, and its result reported separately.

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
