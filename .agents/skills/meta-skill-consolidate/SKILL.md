---
name: meta-skill-consolidate
description: Consolidates the skill library and garbage-collects it — deduplicates overlapping passages, resolves contradictions, revalidates citations whose source has changed, and enforces the per-skill token budget. Use periodically, after a burst of skill updates, whenever the provenance checker reports STALE, and before trusting the library after a large refactor.
metadata:
  type: meta
  verification_signal: node .agents/skills/scripts/lint-skills.mjs && node .agents/skills/scripts/provenance.mjs check && node .agents/skills/scripts/run-evals.mjs --all
---
# Skill consolidation

## When to use

Periodically, after several skills have been updated in a short window, when
`provenance.mjs check` reports STALE, and after any refactor large enough that
the code a skill describes may have moved out from under it.

Unrestricted growth degrades a memory system: more entries mean more chances
that a similar-looking wrong one is the one retrieved. Deletion is as much a
part of keeping it useful as addition.

## Procedure

### 1. Staleness by provenance

```bash
node .agents/skills/scripts/provenance.mjs check
node .agents/skills/scripts/provenance.mjs check --fix   # relocate MOVED only
```

`MOVED` means the cited line still exists elsewhere — the claim is intact and
`--fix` renumbers it. `STALE` means the cited line's content changed, so the
claim may no longer be true: read the source, then either rewrite the passage or
retire it. Do not re-stamp a stale citation to make the check pass; that
launders a possibly-false claim into a verified-looking one.

### 2. Deduplication

Two passages saying the same thing in different skills will drift apart, and
then the library contradicts itself. Keep the one in the more specific skill and
replace the other with a pointer to it.

### 3. Conflict resolution

Contradictions that survived the per-update check: decide which is current from
the code, replace the loser, and add an eval case that would have caught the
contradiction.

### 4. Token budget

```bash
node .agents/skills/scripts/lint-skills.mjs
```

Bodies over ~350 lines get a warning and over 500 an error. The fix is
progressive disclosure — move detail into `references/*.md` and leave a one-line
pointer — not compression, because the first thing compression removes is the
scope condition that makes a rule true.

### 5. Regression gate before promoting anything

```bash
node .agents/skills/scripts/run-evals.mjs --all
```

Consolidation is an edit like any other. If a case that used to pass now fails,
discard that part of the consolidation.

### 6. Emit a diff, not a fait accompli

Consolidation touches many files at once, which is exactly when a silent change
is hardest to review. Leave it as a diff and say what was removed and why.

## Deleting a skill

Deletion is the one irreversible-feeling step here, so it takes two things:

- a second-opinion review from a subagent with fresh context, asked whether the
  content is genuinely covered elsewhere — not asked to find problems in
  general, which produces over-reporting and needless complexity;
- the user's confirmation.

Git makes a deletion recoverable, which is why deleting is allowed at all. That
is not a reason to do it casually: a deleted skill is knowledge nobody will
think to look for again.

## References

- `.agents/skills/scripts/provenance.mjs` — read the header for why the hash is
  taken over the cited line rather than over the file or the commit.
