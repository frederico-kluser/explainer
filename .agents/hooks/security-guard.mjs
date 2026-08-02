#!/usr/bin/env node
// PreToolUse security guardrail.
//
// Two categories, both narrow on purpose. A guardrail that fires on ordinary
// work gets disabled, and a disabled guardrail protects nothing:
//   1. secrets that must never be read into a transcript or a commit
//   2. shell commands that are hard or impossible to undo
//
// Everything reversible is deliberately left alone — editing files, running
// tests, committing, removing a scratch directory. Hooks also fire for subagent
// tool calls, so these apply recursively.
//
// Exit 0 = allow. Exit 2 = block, stderr goes back to the agent.

import { readFileSync } from "node:fs";

// `.env.example` and friends are templates with no values in them, and the
// refusal message itself tells the reader to consult one — blocking them would
// be both wrong and self-contradicting.
const SECRET_EXCEPTIONS = /\.env\.(example|sample|template|dist)$/;

const SECRET_PATHS = [
  /(^|[\\/])\.env($|\.)/,
  /(^|[\\/])secrets[\\/]/,
  /(^|[\\/])\.secrets($|[\\/])/,
  /(^|[\\/])id_(rsa|ed25519)($|\.)/,
  /(^|[\\/])\.pi[\\/]agent[\\/]auth\.json$/,
];

// Each entry is [pattern, why]. The why is what the agent reads, so it can pick
// a safe alternative instead of retrying the same thing.
const DANGEROUS_COMMANDS = [
  [/\brm\s+(-[a-zA-Z]*\s+)*-?[a-zA-Z]*[rR][a-zA-Z]*f?\s+\/(\s|$)/, "recursive delete of /"],
  [/\brm\s+-[a-zA-Z]*r[a-zA-Z]*\s+(~|\$HOME)(\/)?(\s|$)/, "recursive delete of the home directory"],
  [/--no-preserve-root/, "--no-preserve-root"],
  [/\bgit\s+push\b[^\n]*--force(?!-with-lease)/, "force push without --force-with-lease"],
  [/\bgit\s+push\b[^\n]*\s-f(\s|$)/, "force push without --force-with-lease"],
  [/\bgit\s+filter-branch\b/, "history rewrite"],
  [/\bgit\s+reflog\s+expire\b[^\n]*--expire=now/, "reflog expiry, which removes the undo path"],
  [/\bchmod\s+-R\s+777\s+\/(\s|$)/, "chmod 777 on /"],
  [/\bmkfs(\.|\s)/, "filesystem format"],
  [/\bdd\s+[^\n]*of=\/dev\/(sd|nvme|hd)/, "raw write to a block device"],
];

let payload;
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}

const tool = payload.tool_name ?? "";
const input = payload.tool_input ?? {};

if (["Read", "Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)) {
  const path = String(input.file_path ?? input.notebook_path ?? "");
  if (!SECRET_EXCEPTIONS.test(path) && SECRET_PATHS.some((re) => re.test(path))) {
    console.error(
      `Refused: ${path} holds credentials.\n` +
        "Reading it puts secrets in the transcript, and editing it risks committing them. " +
        "Reference the variable by name (OPENAI_API_KEY) and read .env.example for the shape.",
    );
    process.exit(2);
  }
}

if (tool === "Bash") {
  const command = String(input.command ?? "");

  for (const [pattern, why] of DANGEROUS_COMMANDS) {
    if (pattern.test(command)) {
      console.error(
        `Refused: ${why}.\n` +
          "This is hard to undo, so it needs the user to ask for it explicitly rather " +
          "than being taken on the agent's own judgement. Describe what you want to do " +
          "and let them decide.",
      );
      process.exit(2);
    }
  }

  // Reading a secret through the shell bypasses the file-path check above.
  const readsSecret =
    /\b(cat|less|more|head|tail|bat|xxd|strings)\s+[^\n|]*(\.env(\s|$|\.)|secrets\/|\.secrets)/.test(command) &&
    !/\.env\.(example|sample|template|dist)/.test(command);
  if (readsSecret) {
    console.error(
      "Refused: that reads a secrets file through the shell.\n" +
        "Same reason as the file gate — reference the variable by name instead.",
    );
    process.exit(2);
  }
}

process.exit(0);
