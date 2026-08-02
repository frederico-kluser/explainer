# Validation report — knowledge skills system

Phase 5 artifact. Every number below came from running the command named beside
it, not from inspection.

## Reproduce the whole thing

```bash
node .agents/skills/scripts/lint-skills.mjs          # 10/10 skills
node .agents/skills/scripts/provenance.mjs check     # 46 citations verified
node .agents/skills/scripts/run-evals.mjs --all      # 60 cases, 10 skills GREEN
node .agents/skills/scripts/run-routing-evals.mjs    # 17/17 routing cases
node .agents/skills/scripts/test-hooks.mjs           # 14/14 hook scenarios
node .agents/skills/scripts/test-evolution.mjs       # 10/10 pipeline scenarios
```

## Results

| Check | Result |
|---|---|
| skill linter | 10/10 |
| skill body size | min 71, median 83, max 100 lines (~800–1000 tokens) |
| provenance | 46/46 citations resolve to the line they claim |
| per-skill evals | 60 cases across 10 skills, all green |
| routing evals | 17/17, including 2 near-misses that must not surface |
| hook scenarios | 14/14 |
| pipeline scenarios | 10/10 |

## Routing evals

15 must-trigger cases and 2 near-misses. The near-misses ("rename a css
variable", "bump a dependency") assert that the realtime, materials and cost
skills do **not** surface — a skill that fires on everything is as useless as
one that never fires.

**What this measures, precisely:** lexical discrimination between descriptions,
scored with IDF weighting so a term shared by six skills counts for almost
nothing. **What it does not measure:** the model's own semantic and cross-lingual
selection, which is stronger. The cases therefore lean on identifiers and file
names that read the same in both languages.

Two cases failed on the first run, and the difference between them is the point:

- *"the model never calls the tool I defined in tools/index.ts"* routed to
  `adding-realtime-tools` instead of `integrating-openai-realtime`. On
  re-examination **the expectation was wrong**: a tool the user just defined and
  that is not invoked is a wiring question, and that skill loads the protocol one
  itself. The test was corrected.
- *"tool parameters nested under a function key and the session exposes zero
  tools"* also routed away from the protocol skill. Here **the description was
  wrong**: the single most important fact in that skill — the nested schema that
  silently yields zero tools — was not stated in words a user would use for the
  symptom. The description was sharpened.

Fixing the test and fixing the artifact are not interchangeable, and a run that
only ever produces the first kind of fix is not validating anything.

## Evolution pipeline, end to end

`test-evolution.mjs` builds a throwaway skill, exercises the pipeline, and
deletes it.

| Scenario | Expected | Result |
|---|---|---|
| A — learning with a green signal | promotable; token minted; gate allows | pass |
| B — a claim that used to hold no longer does | `REGRESSION` reported, run red, **standing token revoked**, gate refuses | pass |
| C — learning with no signal at all | gate refuses | pass |
| D — the claim is fixed | promotable again; the discard was not permanent | pass |

Scenario B is the important one. The simulated learning stays *important*, stays
*well-cited*, and becomes *false* — the failure mode that hygiene alone cannot
catch, because nothing about its form changed.

**A hole found and closed during this phase:** the first version left the
previous green token valid for its full 20 minutes after a red run, so failing
the evals and editing the skill immediately afterwards would have sailed past the
gate — the check would have run, said no, and been ignored. A red run now revokes
the token (`run-evals.mjs`), and scenario B asserts it.

## Hooks

14/14 scenarios, and the allow cases carry as much weight as the blocks: a
guardrail that fires on ordinary work gets switched off, and a switched-off
guardrail protects nothing.

Blocks: reading `.env`, `cat`-ing a secret through the shell, `rm -rf /`, a force
push without `--force-with-lease`, editing a skill with no token / an expired
token / a red last run.
Allows: `.env.example`, `npm run validate`, `--force-with-lease`, creating a new
skill, editing a non-skill file, and a stop the stop-hook itself caused.

**Limitation, stated plainly: the hooks did not enforce anything during this
bootstrap run.** Hook configuration written mid-session is not loaded by the
running session. This was verified rather than assumed — a harmless probe file
was created under `secrets/`, read successfully (the guard would have refused
it), and removed. So:

- the hooks are correct **when invoked**, which `test-hooks.mjs` demonstrates;
- they are wired into `.claude/settings.json`;
- they take effect in a **new session**, after the user reviews them, which is
  also the point at which the user gets to approve running these commands.

Anything in this report phrased as "the gate refuses" is a statement about the
hook's behaviour under test, not a claim that it policed this run.

## Router

Its runtime behaviour — asking in Portuguese, writing `TASK_PLAN.md`, deleting it
at the end — is **contract-checked, not executed**: no real task went through the
router in this session, so there is nothing to report about how it behaved. Six
cases assert the protocol says what it must, including that the Portuguese
question examples are present verbatim, that the plan is created and deleted, and
that the bootstrap artifacts are explicitly excluded from that deletion. One case
asserts no `TASK_PLAN.md` is sitting in the repo right now, which would mean a
previous run did not finish.

## Success criteria

| # | Criterion | Status |
|---|---|---|
| 1 | lean skills, valid frontmatter | met — linter enforces every clause |
| 2 | exactly one router | met |
| 3 | `<evolution>` in every task skill, no learnings files | met — linter enforces; no `LEARNINGS.md` anywhere |
| 4 | evolution + consolidation meta-skills with safeguards | met |
| 5 | rules a–g respected | met, with the caveat on (e) below |
| 6 | drafts for review, no unexplained caps imperatives | met — linter rejects a caps imperative with no rationale on the line |
| 7 | portable structure, documented symlinks | met — the seven skills appeared in this session's catalog through the symlink |
| 8 | per-phase artifact, committed | met — five commits on `skills/knowledge-system` |
| 9 | router asks in Portuguese, creates and deletes the plan | specified and contract-checked, not executed |
| 10 | first action was repo-docs discovery | met |
| 11 | deterministic enforcement where possible | met — linter, provenance, evals, three hooks |
| 12 | five phases autonomously; clean-but-wrong blocked | met under test; see the hook limitation |

Caveat on (e): during this bootstrap the external signal for each skill was the
eval suite plus entailment against cited source, not a hook stopping a bad write
in flight. The enforcement becomes live for the next session.

## Gaps

1. **Hooks unproven in a live session.** Fix: start a new session, approve the
   hooks, and repeat the `secrets/` probe — it should be refused.
2. **The router has never run.** Its first real task is its first real test.
   Worth watching: whether it actually asks several questions instead of one, and
   whether it deletes the plan.
3. **Routing is scored lexically.** A description can read well to a model and
   still score poorly here, and the reverse. Treat a failure as a prompt to look,
   not as proof.
4. **`SMOKE_TEST.md` is bannered, not rewritten.** The banner stops it misleading
   a reader; the checklist inside is still for an architecture that no longer
   exists.
5. **`by_source` versus `total_usd` after a restart**, and the never-called
   `forgetSources`/`forgetCosts`, are recorded in the skills as known latent
   issues rather than fixed. That was deliberate — they are application bugs, not
   skills-system work — but they are now written down where the next task in that
   area will find them.

## Method note

The four Phase 1 subagents corrected two beliefs that would otherwise have been
written into skills as fact: that `validate.sh` gates the frontend suite (it does
not), and the semantics of the storage write queue. Phase 5 then corrected two
more of my own artifacts. That ratio is the argument for the whole design: the
parts of this system that check the model are the parts that found the errors.
