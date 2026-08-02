#!/usr/bin/env node
// PreToolUse gate on SKILL.md writes.
//
// The rule this enforces: a skill may be edited only after something outside the
// model has said the change is sound. A model's confidence about its own output
// is not evidence — intrinsic self-correction fails often enough that
// "importance" alone must not authorise a write. So the eval runner mints a
// short-lived token on green, and this hook refuses the edit without one.
//
// Creating a *new* SKILL.md is allowed: that is a proposal, and the linter plus
// human review are its gate. Editing an existing one is memory mutation, which
// is where a wrong belief gets persisted and later retrieved as if true.
//
// Exit 0 = allow. Exit 2 = block, stderr goes back to the agent.

import { existsSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";

const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

let payload;
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0); // not invoked as a hook
}

const toolName = payload.tool_name ?? "";
if (!EDIT_TOOLS.has(toolName)) process.exit(0);

const filePath = payload.tool_input?.file_path ?? "";
if (!/skills[\\/][^\\/]+[\\/]SKILL\.md$/.test(filePath)) process.exit(0);

const cwd = payload.cwd ?? process.cwd();
const absolute = resolve(cwd, filePath);

// A new skill is a draft for review, not a memory write.
if (!existsSync(absolute)) process.exit(0);

const skill = absolute.split(sep).at(-2);
const tokenPath = resolve(cwd, ".agents/skills/.validation", `${skill}.json`);

function refuse(reason) {
  console.error(
    `Refused to edit ${skill}/SKILL.md — ${reason}.\n\n` +
      "A skill is memory: a wrong entry here is retrieved on every similar task " +
      "and repeated. So an edit needs a signal that did not come from the model.\n\n" +
      `  1. make the change to the code and prove it: run the skill's verification signal\n` +
      `  2. node .agents/skills/scripts/run-evals.mjs ${skill}\n` +
      `  3. edit the skill while the token is valid (20 minutes)\n\n` +
      "If the evals go red, that is the answer: discard the learning rather than " +
      "writing it down.",
  );
  process.exit(2);
}

if (!existsSync(tokenPath)) refuse("no validation token; its evals have not passed");

let token;
try {
  token = JSON.parse(readFileSync(tokenPath, "utf8"));
} catch {
  refuse("the validation token is unreadable");
}

if (token.passed !== true) refuse("the last eval run was red");
if (typeof token.expires_at !== "number" || Date.now() > token.expires_at) {
  refuse("the validation token has expired — re-run the evals against the current tree");
}

console.log(`skill-write-gate: ${skill} validated by ${token.signal} (${token.cases} cases)`);
process.exit(0);
