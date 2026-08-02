---
name: project-router
description: Routes every implementation task in this codebase to the correct skills before any step is taken, after refining the request with the user in Portuguese. Use whenever the user asks for any change, fix, feature, analysis or refactor in this repository, even if they never mention skills and even if the request looks small enough to just do.
metadata:
  type: router
---
# Project Router

Every interaction with the user in this skill happens in Brazilian Portuguese —
the developer who uses it is a Portuguese speaker, so a question in English
costs them a translation before they can answer it. Everything else — the code,
the commits, the skill bodies — stays in English.

## When to use

Any request that touches this repository: a change, a fix, a feature, an
analysis, a refactor. Including the ones that look small. "Small" is usually an
estimate made before reading the code, and the traps in this codebase are
concentrated exactly where a change looks trivial.

## Protocol

Run steps 1 and 2 before touching anything.

### 1. Ask, in Portuguese, until the ambiguity is gone

Several questions, not one. Underspecified work gets built twice. Cover scope,
inputs and outputs, constraints, edge cases, acceptance criteria, and what
explicitly should not change. Examples of the register to use:

- "Qual é exatamente o comportamento esperado no final? Me descreve como você
  vai saber que ficou certo."
- "Isso deve valer para todos os materiais da conversa ou só para repositórios?"
- "O que NÃO pode mudar nessa tarefa? Tem alguma parte que você prefere que eu
  nem encoste?"
- "Quando dá errado, o que você quer que aconteça: falhar visível, ou seguir em
  silêncio com um valor padrão?"
- "Isso precisa funcionar durante uma chamada ao vivo, ou só fora dela?"
- "Tem algum caso de borda que você já viu quebrar aqui antes?"

Keep asking while an answer would still change what gets built. The rule of
thumb: if two competent people could read the request and build different
things, there is at least one more question to ask.

### 2. Write `TASK_PLAN.md`, in Portuguese

At the repository root, containing the agreed scope, the numbered steps, the
acceptance criteria, and what is explicitly out of scope. It is the shared
artifact the user can correct before any code moves. It is disposable and gets
deleted in step 8.

### 3. Classify

Which domains the task touches, its type (bug, feature, refactor, analysis) and
its complexity.

### 4. Select from the catalog

Read `.agents/skills/catalog.md`. Load `writing-explainer-code` on anything that
edits code. Add the domain skills whose triggers match. On ambiguity, prefer the
more specific skill — a generic one that half-covers the area is how a
domain-specific trap gets missed.

### 5. Assemble the chain

Decide the order and what can run in parallel. The four domain skills are
independent of one another and can be loaded by isolated-context subagents at
the same time. `writing-explainer-code` comes before implementation;
`verifying-explainer-changes` comes before anything is declared done.

### 6. Load the knowledge before implementing

Reading the skills after writing the code turns them into a review checklist,
which is a worse use of them and usually means rework.

### 7. Execute the chain against `TASK_PLAN.md`

### 8. On completion

- Run the `<evolution>` step of every task skill that was involved, which
  applies the pipeline in `meta-skill-evolution`. Usually it writes nothing;
  that is the healthy outcome.
- Delete `TASK_PLAN.md`. It is scaffolding, and leaving it behind turns a
  finished task into repository noise.

## Rules

- When no skill covers the task, invoke `meta-skill-evolution` to propose a new
  one as a draft for review, rather than publishing it directly.
- Skills with broad side effects — deploys, structural rewrites, widening the
  sandbox — are not auto-invoked; they need the user to say yes first, because
  the cost of being wrong is not recoverable by an edit.
- `TASK_PLAN.md` is the only file this protocol deletes. The bootstrap artifacts
  (`.agents/artifacts/*`, `catalog.md`, `.bootstrap-state.json`) are permanent
  and deleting one loses the reasoning behind the whole library.

## References

- `.agents/skills/catalog.md` — the index this protocol selects from.
