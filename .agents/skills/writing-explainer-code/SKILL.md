---
name: writing-explainer-code
description: Documents the conventions and framework traps of the Explainer codebase — the Express 5 route-param trap, ESM import specifiers, which conventions the tooling already enforces, and the UI vocabulary. Use whenever writing or editing any TypeScript in backend/src or frontend/src, before the first line is changed, even if the user only asks for a small fix and never mentions style.
metadata:
  type: knowledge
  verification_signal: npm run lint && npm run typecheck, plus evals.json (no annotated handler on a parameterised route)
---
# Writing Explainer code

## When to use

Any task that edits `backend/src/**` or `frontend/src/**`. This is the one skill
loaded on every implementation task, because two of the items below fail
silently rather than loudly.

## Injected knowledge

### Do not restate what the tooling already guarantees

`npm run lint && npm run typecheck` already enforce: no implicit or explicit
`any`, strict null checks, `noUncheckedIndexedAccess`, erasable type-only
imports, case-correct import paths, unused variables (unless `_`-prefixed), no
`require()`, no bare `@ts-ignore`. Writing prose about those adds tokens and
rots on its own schedule, so point at the check instead.

Because `noUncheckedIndexedAccess` is on, `array[0]` is `T | undefined`. The
established idiom here is a non-null assertion after a guard — `no-non-null-assertion`
is deliberately not enabled, so `sources[0]!` is house style rather than a smell.

What the tooling does **not** cover, so judgement is still required: there is no
type-aware lint, no `react-hooks` plugin (stale closures and dependency arrays
are caught by nobody), no formatter, and no import-order rule.
`frontend/src/components/motion-ui/**` is excluded from lint entirely —
`frontend/eslint.config.js:14@1904982d`.

### Express 5 loses route params when you annotate the handler

Annotating a handler as `(req: Request, res: Response)` discards the
route-string inference, so `req.params.jobId` widens to `string | string[]` and
type-checking fails on every use. Leave handlers unannotated on any route whose
path contains `:` and Express infers the params correctly. The surviving
annotations in this repo sit only on parameterless routes such as `/session` and
`/tool`, which is why they still compile.

### Runtime imports carry the `.js` extension

Backend imports use `./middleware/error-handler.js` even though the source is
`.ts` — `backend/src/index.ts:5@f9df7485`. `moduleResolution` is `bundler`, so
the compiler would accept a bare specifier; Node's ESM loader at runtime would
not. The extension is a runtime requirement that the type-checker cannot catch,
which is why it is written down here rather than left to the build.

`import "./load-env.js"` stays the first import in `backend/src/index.ts`,
because `sandbox.ts` freezes `homedir()`-derived roots at module load and
anything imported earlier would read an unpopulated environment.

### Language split

Code, comments, commit messages and skill bodies are English. Strings the end
user sees or hears — UI copy, model instructions in `prompts.ts`, tool output
that gets spoken — are Brazilian Portuguese, because the product speaks
Portuguese. Mixing the two inside one string is the common mistake.

### Comments explain why, not what

The comment density in this repo is low and every comment earns its place by
recording a reason a reader could not recover from the code: a guard that looks
redundant, an ordering constraint, a workaround. `git log -p` covers what
changed; a comment that narrates the next line is noise.

### UI vocabulary (the three non-obvious ones)

- Animation timings are never literals. Components call
  `useMotionUITransition("gentle" | "snap" | …)`, and the vocabulary lives in
  `frontend/motion.theme.ts:5@d5d0ddc7`. A hand-written `duration: 0.3` bypasses
  the shared feel and the reduced-motion handling.
- `frontend/src/components/motion-ui/**` is vendored registry code, not app
  code. Edits there are overwritten by the next registry pull; wrap it in
  `components/ui/` instead.
- Dark mode is fixed, not toggleable: `frontend/index.html:2@a45196b2` sets
  `class="dark"` and both App root elements repeat it. There is no theme
  switcher to keep in sync.
- `data-role` on `ChatBubble` exists purely so a test can assert the model
  actually spoke, rather than that some text appeared on the page —
  `frontend/src/components/ui/ChatBubble.tsx:41@cbcd8183`. Keep it when editing
  that component.

### The error handler branches on headersSent

Streaming routes have already flushed headers, so `res.status().json()` throws
`ERR_HTTP_HEADERS_SENT` and kills the socket mid-stream. The handler checks
`res.headersSent` first — `backend/src/middleware/error-handler.ts:25@a596c454`.
Any new SSE route reports failures in-band for the same reason.

## References

- `.agents/artifacts/project-analysis.md` — the full tooling-guarantee table and
  the coverage holes.

## Escape hatch

These are defaults, not laws. Diverging is fine when the reason is written down
in a comment at the point of divergence — that is exactly the kind of comment
this codebase wants.
