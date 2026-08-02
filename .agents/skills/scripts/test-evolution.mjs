#!/usr/bin/env node
// End-to-end check of the memory pipeline, on a throwaway skill so no real one
// is disturbed.
//
// Three scenarios, matching the three things the pipeline promises:
//   A. a learning with a green signal is promotable
//   B. a learning that causes a correct→wrong flip is discarded, and the token
//      standing from the previous green run is revoked
//   C. a learning with no signal at all cannot be written
//
// Usage: node .agents/skills/scripts/test-evolution.mjs

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(process.cwd());
const FIXTURE = "checking-pipeline-fixture";
const FIXTURE_DIR = join(ROOT, ".agents/skills", FIXTURE);
const TOKEN = join(ROOT, ".agents/skills/.validation", `${FIXTURE}.json`);
const BASELINE = join(ROOT, ".agents/skills/.validation", `${FIXTURE}.baseline.json`);

const results = [];
function check(name, passed, detail = "") {
  results.push({ name, passed, detail });
}

// The fixture carries a real SKILL.md because the write-gate deliberately lets
// a *new* skill be created — without the file, every gate scenario would be
// testing the creation path instead of the memory-write path.
const FIXTURE_SKILL = `---
name: ${FIXTURE}
description: Checks the pipeline end to end and is deleted immediately afterwards. Use when running test-evolution.mjs, never in real work.
metadata:
  type: meta
  verification_signal: fixture
---
# Fixture

## When to use

Never by hand — test-evolution.mjs creates and removes it.

## Protocol

None.
`;

function evals(cases) {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  writeFileSync(join(FIXTURE_DIR, "SKILL.md"), FIXTURE_SKILL);
  writeFileSync(
    join(FIXTURE_DIR, "evals.json"),
    JSON.stringify({ skill: FIXTURE, verification_signal: "fixture", cases }, null, 2),
  );
}

function runEvals(extra = []) {
  const result = spawnSync(
    "node",
    [".agents/skills/scripts/run-evals.mjs", FIXTURE, ...extra],
    { cwd: ROOT, encoding: "utf8" },
  );
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

function writeGate() {
  const result = spawnSync("node", [".agents/hooks/skill-write-gate.mjs"], {
    cwd: ROOT,
    encoding: "utf8",
    input: JSON.stringify({
      tool_name: "Edit",
      cwd: ROOT,
      tool_input: { file_path: `.agents/skills/${FIXTURE}/SKILL.md` },
    }),
  });
  return result.status;
}

// A claim that is true of the tree right now, and one that is trivially true.
const TRUE_CLAIM = {
  id: "claim-holds",
  type: "file_matches",
  file: "backend/src/services/pricing.ts",
  pattern: "WEB_SEARCH_CALL_USD",
};
const ALSO_TRUE = {
  id: "second-claim-holds",
  type: "file_matches",
  file: "backend/src/tools/index.ts",
  pattern: "toolsForSources",
};

try {
  // --- A. green run: the learning is promotable ---------------------------
  evals([TRUE_CLAIM, ALSO_TRUE]);
  let run = runEvals(["--accept-baseline"]);
  check("A: a verified learning goes green", run.code === 0, run.out.trim().split("\n").at(-1));
  check("A: a token is minted", existsSync(TOKEN));
  check("A: the write-gate then allows the edit", writeGate() === 0);

  // --- B. regression: a claim that used to hold no longer does -------------
  // Simulates the dangerous case — the learning still sounds important, is
  // still well-cited, and is now false.
  evals([{ ...TRUE_CLAIM, pattern: "THIS_CONSTANT_DOES_NOT_EXIST" }, ALSO_TRUE]);
  run = runEvals();
  check("B: the flip is detected", /REGRESSION/.test(run.out), "expected a REGRESSION line");
  check("B: the run is red", run.code !== 0);
  check("B: the standing token is revoked", !existsSync(TOKEN));
  check("B: the write-gate now refuses the edit", writeGate() === 2);

  // --- C. no signal at all -------------------------------------------------
  rmSync(TOKEN, { force: true });
  check("C: an unvalidated skill cannot be edited", writeGate() === 2);

  // --- back to green: the discard was not permanent ------------------------
  evals([TRUE_CLAIM, ALSO_TRUE]);
  run = runEvals();
  check("D: fixing the claim restores promotability", run.code === 0);
  check("D: the write-gate allows again", writeGate() === 0);
} finally {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
  rmSync(TOKEN, { force: true });
  rmSync(BASELINE, { force: true });
}

for (const r of results) {
  console.log(`${r.passed ? "pass" : "FAIL"}  ${r.name}${r.passed || !r.detail ? "" : ` — ${r.detail}`}`);
}
const failed = results.filter((r) => !r.passed).length;
console.log(`\n${results.length - failed}/${results.length} pipeline scenarios behaved as specified`);
process.exit(failed > 0 ? 1 : 0);
