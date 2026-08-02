---
name: dispatching-pi-agents
description: Documents how the pi coding agent is spawned against a material, why it runs read-only, and the replay rule that stops the model narrating an hour-old answer on every reconnect. Use whenever touching agent-jobs, routes/agents.ts, the SSE job stream, dispatch_pi_agent, or whenever an agent job hangs, costs more than expected, or its result is spoken twice.
metadata:
  type: knowledge
  verification_signal: npm --prefix backend test -- src/__tests__/agent-jobs.test.ts
---
# Dispatching pi agents

## When to use

Editing `services/agent-jobs.ts`, `routes/agents.ts`, the job SSE stream, or the
`dispatch_pi_agent` tool. Also when a job hangs, when a conversation costs more
than expected, or when the assistant reads out an answer nobody just asked for.

This is the only place the app spends the user's own coding-agent credit and the
only place it runs an external process, so the guards here are about money and
blast radius rather than correctness alone.

## Injected knowledge

### Why it is asynchronous at all

A real question about a repository takes tens of seconds. A spoken conversation
cannot wait. So the tool returns a job id in milliseconds, the model says out
loud that it dispatched an agent and keeps talking, and the answer is injected
later as a conversation item followed by `response.create`. Removing the
asynchrony to "simplify" reintroduces a minute of silence mid-call.

### The spawn is deliberately narrow

`pi -p --mode json --no-session --no-approve -t read,glob,grep,find,ls` —
`backend/src/services/agent-jobs.ts:148@de2ea80a`.

- `-t read,glob,grep,find,ls` is a read-only allowlist. The agent is pointed at
  repositories the user did not necessarily write, so it gets no shell and no
  write tools.
- `--no-approve` refuses to trust extensions or skills that ship *inside* a
  cloned repository — otherwise a hostile repo could hand instructions to the
  agent reading it.
- `--mode json` gives parseable JSONL; the final answer is the last assistant
  text in `agent_end.messages`, and the cost rides the same events.
- `PI_BIN` is read at spawn time rather than at import —
  `backend/src/services/agent-jobs.ts:24@ce8d0ac2` — so the binary can be
  repointed without a restart. The test suite relies on exactly this: it writes
  a fake `pi` script and points `PI_BIN` at it.

### One job per conversation, and a hard timeout

A second dispatch while one is running is refused with 409 —
`backend/src/services/agent-jobs.ts:102@80b535a0`. Default timeout is 180 s,
after which the process is killed and the job fails rather than hanging. A job
that produces no answer reports a failure; it never resolves silently.

### Replayed results are shown, not spoken

The SSE stream replays already-finished jobs whenever a client connects, so a
reconnect does not lose them. Those events carry `replay: true` —
`backend/src/routes/agents.ts:39@18d878e8` — and the client renders them but
skips the injection that makes the model narrate.

Drop that flag and every reconnect makes the assistant read out an answer from
an hour ago, and bills for the audio. This was a real bug, found by a browser
test rather than by reasoning about the code.

The replay loop and the `subscribe()` call sit in the same synchronous block on
purpose: an `await` between them drops any job that finishes in the gap.

### The result is stripped before it is spoken

The agent answers in markdown; a voice model re-narrating it would read
backticks and asterisks aloud. `forSpeech` removes them before the result leaves
the service.

## References

- `.agents/skills/integrating-openai-realtime/SKILL.md` — the injection half of
  the round trip.

## Escape hatch

Widening the tool allowlist is a security decision, not a convenience one. If a
task needs the agent to write, that belongs in a separate, explicitly-confirmed
change with its own worktree — not a quiet edit to the flag list.
