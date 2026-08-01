import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `pi` is spawned as a real subprocess, so the test supplies a real one: a tiny
// script that emits the same JSONL shape pi does. That exercises the whole path
// — spawn, line buffering, event parsing, completion — instead of just the
// parser in isolation.

let workdir: string;
let mod: typeof import("../services/agent-jobs.js");

const CONV = "550e8400-e29b-41d4-a716-446655440000";

function writeFakePi(body: string): string {
  const path = join(workdir, `fake-pi-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function waitFor(
  predicate: (event: import("../services/agent-jobs.js").AgentJobEvent) => boolean,
  timeoutMs = 15_000,
): Promise<import("../services/agent-jobs.js").AgentJobEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("timed out waiting for the job event"));
    }, timeoutMs);

    const unsubscribe = mod.subscribe((event) => {
      if (!predicate(event)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(event);
    });
  });
}

beforeAll(async () => {
  workdir = mkdtempSync(join(tmpdir(), "explainer-agent-"));
  // PI_BIN is read when the module initialises, so it has to be set first.
  process.env.PI_BIN = writeFakePi(`
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
emit({ type: "agent_start" });
emit({ type: "message_update", assistantMessageEvent: { type: "toolCall_start", toolName: "read" } });
emit({
  type: "agent_end",
  messages: [
    { role: "user", content: [{ type: "text", text: "pergunta" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "O projeto usa Express 5." },
      ],
      usage: { cost: { total: 0.0042 } },
    },
  ],
});
`);
  mod = await import("../services/agent-jobs.js");
});

afterAll(() => {
  delete process.env.PI_BIN;
  rmSync(workdir, { recursive: true, force: true });
});

describe("dispatchAgentJob", () => {
  it("returns immediately and delivers the answer on the bus", async () => {
    const done = waitFor((e) => e.type === "done");

    const job = mod.dispatchAgentJob({
      conversationId: CONV,
      prompt: "Qual framework HTTP este projeto usa?",
      cwd: workdir,
    });

    // The whole point: the caller is not blocked on the agent.
    expect(job.status).toBe("running");
    expect(job.id).toBeTruthy();

    const event = await done;
    expect(event.type).toBe("done");
    if (event.type === "done") {
      expect(event.result).toContain("Express 5");
      expect(event.cost_usd).toBeCloseTo(0.0042);
    }

    const finished = mod.getJob(job.id);
    expect(finished?.status).toBe("done");
    expect(finished?.result).toContain("Express 5");
  });

  it("refuses a second agent while one is still running", async () => {
    const slow = writeFakePi(`setTimeout(() => process.exit(0), 5000);`);
    const previous = process.env.PI_BIN;
    process.env.PI_BIN = slow;

    const conv = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
    const job = mod.dispatchAgentJob({
      conversationId: conv,
      prompt: "primeira",
      cwd: workdir,
      timeoutMs: 4_000,
    });

    expect(() =>
      mod.dispatchAgentJob({ conversationId: conv, prompt: "segunda", cwd: workdir }),
    ).toThrow(/Ja existe um agente rodando/);

    expect(mod.cancelJob(job.id)).toBe(true);
    expect(mod.getJob(job.id)?.status).toBe("cancelled");

    if (previous) process.env.PI_BIN = previous;
  });

  it("reports a failure instead of hanging when the agent says nothing", async () => {
    const silent = writeFakePi(`process.stderr.write("boom\\n"); process.exit(3);`);
    const previous = process.env.PI_BIN;
    process.env.PI_BIN = silent;

    const conv = "6ba7b811-9dad-41d1-80b4-00c04fd430c8";
    const failed = waitFor((e) => e.type === "error");
    mod.dispatchAgentJob({ conversationId: conv, prompt: "nada", cwd: workdir });

    const event = await failed;
    expect(event.type).toBe("error");
    if (event.type === "error") expect(event.error).toMatch(/codigo 3|boom/);

    if (previous) process.env.PI_BIN = previous;
  });
});
