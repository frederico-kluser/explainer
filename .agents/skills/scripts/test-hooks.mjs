#!/usr/bin/env node
// Executable check that the three hooks behave as the skills claim.
//
// The skills assert that an unvalidated skill edit is refused and that a
// destructive command is refused. Those are claims about behaviour, so they get
// a test rather than a paragraph — otherwise the day a regex stops matching,
// every document still says the guarantee holds.
//
// Usage: node .agents/skills/scripts/test-hooks.mjs
// Exit 0 = every scenario behaved as specified.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(process.cwd());
const VALIDATION = resolve(ROOT, ".agents/skills/.validation");
const SUBJECT = "writing-explainer-code";
const TOKEN = resolve(VALIDATION, `${SUBJECT}.json`);
const STASH = resolve(VALIDATION, `${SUBJECT}.json.testbak`);

function fire(hook, payload) {
  const result = spawnSync("node", [`.agents/hooks/${hook}`], {
    cwd: ROOT,
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  return { code: result.status, message: (result.stderr || result.stdout || "").trim() };
}

const scenarios = [];
function expect(name, { code }, wanted) {
  const passed = code === wanted;
  scenarios.push({ name, passed, detail: `exit ${code}, expected ${wanted}` });
}

const skillEdit = {
  tool_name: "Edit",
  cwd: ROOT,
  tool_input: { file_path: `.agents/skills/${SUBJECT}/SKILL.md` },
};

// --- security guardrail ----------------------------------------------------
const guard = (payload) => fire("security-guard.mjs", payload);

expect("blocks reading .env", guard({ tool_name: "Read", tool_input: { file_path: ".env" } }), 2);
expect(
  "blocks catting a secret through the shell",
  guard({ tool_name: "Bash", tool_input: { command: "cat backend/.env" } }),
  2,
);
expect(
  "blocks rm -rf /",
  guard({ tool_name: "Bash", tool_input: { command: "rm -rf / --no-preserve-root" } }),
  2,
);
expect(
  "blocks a force push without lease",
  guard({ tool_name: "Bash", tool_input: { command: "git push --force origin main" } }),
  2,
);
// A guardrail that fires on ordinary work gets switched off, so the allow cases
// matter as much as the block cases.
expect(
  "allows .env.example",
  guard({ tool_name: "Read", tool_input: { file_path: ".env.example" } }),
  0,
);
expect("allows the gate", guard({ tool_name: "Bash", tool_input: { command: "npm run validate" } }), 0);
expect(
  "allows --force-with-lease",
  guard({ tool_name: "Bash", tool_input: { command: "git push --force-with-lease origin topic" } }),
  0,
);

// --- skill write gate ------------------------------------------------------
mkdirSync(VALIDATION, { recursive: true });
const hadToken = existsSync(TOKEN);
if (hadToken) renameSync(TOKEN, STASH);

try {
  expect("refuses a skill edit with no token", fire("skill-write-gate.mjs", skillEdit), 2);

  writeFileSync(
    TOKEN,
    JSON.stringify({ skill: SUBJECT, passed: true, signal: "test", expires_at: 1, cases: 0 }),
  );
  expect("refuses a skill edit with an expired token", fire("skill-write-gate.mjs", skillEdit), 2);

  writeFileSync(
    TOKEN,
    JSON.stringify({
      skill: SUBJECT,
      passed: false,
      signal: "test",
      expires_at: Date.now() + 60_000,
      cases: 0,
    }),
  );
  expect("refuses a skill edit when the last run was red", fire("skill-write-gate.mjs", skillEdit), 2);

  writeFileSync(
    TOKEN,
    JSON.stringify({
      skill: SUBJECT,
      passed: true,
      signal: "test",
      expires_at: Date.now() + 60_000,
      cases: 1,
    }),
  );
  expect("allows a skill edit with a fresh green token", fire("skill-write-gate.mjs", skillEdit), 0);

  expect(
    "allows creating a skill that does not exist yet",
    fire("skill-write-gate.mjs", {
      tool_name: "Write",
      cwd: ROOT,
      tool_input: { file_path: ".agents/skills/proposing-something-new/SKILL.md" },
    }),
    0,
  );
  expect(
    "ignores files that are not skills",
    fire("skill-write-gate.mjs", {
      tool_name: "Edit",
      cwd: ROOT,
      tool_input: { file_path: "backend/src/index.ts" },
    }),
    0,
  );
} finally {
  rmSync(TOKEN, { force: true });
  if (hadToken) renameSync(STASH, TOKEN);
}

// --- bootstrap stop gate ---------------------------------------------------
// The loop guard is the one failure that would trap a session, so it is checked
// explicitly rather than assumed.
expect(
  "never blocks a stop it already caused",
  fire("bootstrap-gate.mjs", { stop_hook_active: true }),
  0,
);

for (const scenario of scenarios) {
  console.log(`${scenario.passed ? "pass" : "FAIL"}  ${scenario.name}${scenario.passed ? "" : ` — ${scenario.detail}`}`);
}

const failed = scenarios.filter((s) => !s.passed).length;
console.log(`\n${scenarios.length - failed}/${scenarios.length} hook scenarios behaved as specified`);
process.exit(failed > 0 ? 1 : 0);
