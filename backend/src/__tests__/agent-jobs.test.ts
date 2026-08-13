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

// The caps the prompt is built against, pinned by their exported names where
// they exist and by value otherwise — see the why-comments in agent-jobs.ts.
const MAX_PROMPT_CHARS = 8_000;

afterAll(() => {
  delete process.env.PI_BIN;
  rmSync(workdir, { recursive: true, force: true });
});

describe("buildPrompt", () => {
  it("caps the context section at MAX_CONTEXT_CHARS without touching the question", async () => {
    const done = waitFor((e) => e.type === "done");

    const job = mod.dispatchAgentJob({
      conversationId: CONV,
      prompt: "P".repeat(5_000),
      cwd: workdir,
      context: "C".repeat(20_000),
    });
    await done;

    const prompt = mod.getJob(job.id)?.prompt ?? "";
    const contextPart = prompt.slice(
      prompt.indexOf("Contexto: ") + "Contexto: ".length,
      prompt.indexOf("\n\nPergunta: "),
    );
    expect(contextPart.length).toBeLessThanOrEqual(mod.MAX_CONTEXT_CHARS);
    // The question is the model's own phrasing, so it survives in full: the
    // context must not crowd it out of the budget.
    expect(prompt).toContain(`Pergunta: ${"P".repeat(5_000)}`);
  });

  it("caps the question itself at MAX_PROMPT_CHARS", async () => {
    const done = waitFor((e) => e.type === "done");

    const job = mod.dispatchAgentJob({
      conversationId: CONV,
      prompt: "P".repeat(20_000),
      cwd: workdir,
    });
    await done;

    const prompt = mod.getJob(job.id)?.prompt ?? "";
    expect(prompt).toContain(`Pergunta: ${"P".repeat(MAX_PROMPT_CHARS)}`);
    expect(prompt).not.toContain("P".repeat(MAX_PROMPT_CHARS + 1));
  });

  it("puts the context before the question", async () => {
    const done = waitFor((e) => e.type === "done");

    const job = mod.dispatchAgentJob({
      conversationId: CONV,
      prompt: "qual o bug?",
      cwd: workdir,
      context: "o modulo de cobranca",
    });
    await done;

    const prompt = mod.getJob(job.id)?.prompt ?? "";
    expect(prompt.indexOf("Contexto: o modulo de cobranca")).toBeLessThan(
      prompt.indexOf("Pergunta: qual o bug?"),
    );
  });

  it("omits the context section when the context is only whitespace", async () => {
    const done = waitFor((e) => e.type === "done");

    const job = mod.dispatchAgentJob({
      conversationId: CONV,
      prompt: "qual o bug?",
      cwd: workdir,
      context: "   ",
    });
    await done;

    const prompt = mod.getJob(job.id)?.prompt ?? "";
    expect(prompt).not.toContain("Contexto:");
    expect(prompt).toContain("Pergunta: qual o bug?");
  });

  it("trims the context and keeps one at exactly the cap whole", async () => {
    const done = waitFor((e) => e.type === "done");

    const job = mod.dispatchAgentJob({
      conversationId: CONV,
      prompt: "pergunta",
      cwd: workdir,
      context: `  ${"c".repeat(mod.MAX_CONTEXT_CHARS)}  `,
    });
    await done;

    const prompt = mod.getJob(job.id)?.prompt ?? "";
    const contextPart = prompt.slice(
      prompt.indexOf("Contexto: ") + "Contexto: ".length,
      prompt.indexOf("\n\nPergunta: "),
    );
    // Trimmed at both ends first, then sliced — a context of exactly the cap
    // survives intact, so the slice has no off-by-one.
    expect(contextPart.length).toBe(mod.MAX_CONTEXT_CHARS);
    expect(contextPart).toBe("c".repeat(mod.MAX_CONTEXT_CHARS));
  });

  it("caps the context at exactly MAX_CONTEXT_CHARS, not one more", async () => {
    const done = waitFor((e) => e.type === "done");

    const job = mod.dispatchAgentJob({
      conversationId: CONV,
      prompt: "pergunta",
      cwd: workdir,
      context: "c".repeat(mod.MAX_CONTEXT_CHARS + 1),
    });
    await done;

    const prompt = mod.getJob(job.id)?.prompt ?? "";
    const contextPart = prompt.slice(
      prompt.indexOf("Contexto: ") + "Contexto: ".length,
      prompt.indexOf("\n\nPergunta: "),
    );
    expect(contextPart.length).toBe(mod.MAX_CONTEXT_CHARS);
    expect(contextPart).toBe("c".repeat(mod.MAX_CONTEXT_CHARS));
    expect(prompt).not.toContain("c".repeat(mod.MAX_CONTEXT_CHARS + 1));
  });

  it("caps the question and the context independently", async () => {
    const done = waitFor((e) => e.type === "done");

    const job = mod.dispatchAgentJob({
      conversationId: CONV,
      prompt: "p".repeat(20_000),
      cwd: workdir,
      context: "c".repeat(10_000),
    });
    await done;

    const prompt = mod.getJob(job.id)?.prompt ?? "";
    // A long question is cut at its own 8 000-character ceiling, and a long
    // context at its own — neither cap borrows from the other.
    expect(prompt).toContain(`Pergunta: ${"p".repeat(MAX_PROMPT_CHARS)}`);
    expect(prompt).not.toContain("p".repeat(MAX_PROMPT_CHARS + 1));
    const contextPart = prompt.slice(
      prompt.indexOf("Contexto: ") + "Contexto: ".length,
      prompt.indexOf("\n\nPergunta: "),
    );
    expect(contextPart).toBe("c".repeat(mod.MAX_CONTEXT_CHARS));
  });
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
