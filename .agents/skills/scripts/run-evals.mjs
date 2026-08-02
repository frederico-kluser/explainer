#!/usr/bin/env node
// Per-skill eval runner, regression gate, and validation-token minter.
//
// This is the external signal the whole memory design rests on. A model's own
// confidence that a learning is correct is not evidence; a green check that it
// did not write is. So a skill may only be edited after its evals pass here,
// and the write-gate hook refuses the edit without the token this script mints.
//
// It also supplies the regression half: a case that used to pass and now fails
// is a correct→wrong flip, and the update is discarded rather than promoted.
//
// Usage:
//   node run-evals.mjs <skill-name>        run one skill's evals, mint on pass
//   node run-evals.mjs --all               run every skill's evals
//   node run-evals.mjs <skill> --accept-baseline   record the current results
//   node run-evals.mjs <skill> --no-token          check only, mint nothing

import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(process.cwd());
const SKILLS_DIR = resolve(ROOT, ".agents/skills");
const VALIDATION_DIR = join(SKILLS_DIR, ".validation");

// Long enough to edit a skill after a green run, short enough that a token can
// never stand in for a check that happened yesterday.
const TOKEN_TTL_MS = 20 * 60 * 1000;

function readJSON(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function runCase(testCase) {
  switch (testCase.type) {
    case "command": {
      try {
        execSync(testCase.run, {
          cwd: ROOT,
          stdio: "pipe",
          timeout: testCase.timeout_ms ?? 240_000,
        });
        return { passed: (testCase.expect_exit ?? 0) === 0 };
      } catch (err) {
        const code = typeof err.status === "number" ? err.status : 1;
        const expected = testCase.expect_exit ?? 0;
        return {
          passed: code === expected,
          detail: code === expected ? undefined : `exit ${code}, expected ${expected}`,
        };
      }
    }

    // Entailment: the source the skill cites must actually say what the skill
    // claims. "The file exists" is not evidence that the claim is true.
    case "file_matches":
    case "file_absent_match": {
      const path = resolve(ROOT, testCase.file);
      if (!existsSync(path)) {
        return { passed: false, detail: `missing file ${testCase.file}` };
      }
      const text = readFileSync(path, "utf8");
      const found = new RegExp(testCase.pattern, testCase.flags ?? "m").test(text);
      const wantFound = testCase.type === "file_matches";
      return {
        passed: found === wantFound,
        detail:
          found === wantFound
            ? undefined
            : wantFound
              ? `pattern not found in ${testCase.file}`
              : `forbidden pattern present in ${testCase.file}`,
      };
    }

    case "citations_fresh": {
      try {
        execSync("node .agents/skills/scripts/provenance.mjs check", {
          cwd: ROOT,
          stdio: "pipe",
        });
        return { passed: true };
      } catch {
        return { passed: false, detail: "a cited line changed — revalidate the claim" };
      }
    }

    default:
      return { passed: false, detail: `unknown case type "${testCase.type}"` };
  }
}

function runSkill(skill, { acceptBaseline = false, mintToken = true } = {}) {
  const evalsPath = join(SKILLS_DIR, skill, "evals.json");
  const suite = readJSON(evalsPath);

  if (!suite) {
    console.error(`FAIL ${skill}: no evals.json — a skill without a check cannot be validated`);
    return false;
  }

  const results = {};
  let failures = 0;

  for (const testCase of suite.cases ?? []) {
    const outcome = runCase(testCase);
    results[testCase.id] = outcome.passed;
    if (outcome.passed) {
      console.log(`  pass  ${testCase.id}`);
    } else {
      failures += 1;
      console.error(`  FAIL  ${testCase.id} — ${outcome.detail ?? "assertion failed"}`);
    }
  }

  mkdirSync(VALIDATION_DIR, { recursive: true });
  const baselinePath = join(VALIDATION_DIR, `${skill}.baseline.json`);
  const baseline = readJSON(baselinePath);

  // Promote-or-discard: a case that used to pass and now fails is a regression,
  // and no amount of new green cases buys it back.
  const regressions = baseline
    ? Object.entries(baseline.results ?? {})
        .filter(([id, wasPassing]) => wasPassing && results[id] === false)
        .map(([id]) => id)
    : [];

  if (regressions.length) {
    console.error(`  REGRESSION ${skill}: ${regressions.join(", ")} — discard this change`);
  }

  const green = failures === 0 && regressions.length === 0;

  if (acceptBaseline && failures === 0) {
    writeFileSync(baselinePath, JSON.stringify({ skill, results }, null, 2) + "\n");
    console.log(`  baseline recorded for ${skill}`);
  }

  const tokenPath = join(VALIDATION_DIR, `${skill}.json`);

  // A red run revokes any token still standing. Without this, failing the evals
  // and then editing the skill inside the previous token's window would sail
  // past the write-gate — the check would have run, said no, and been ignored.
  if (!green && existsSync(tokenPath)) {
    rmSync(tokenPath);
    console.error(`  token revoked for ${skill} — the last run was not green`);
  }

  if (green && mintToken) {
    const now = Date.now();
    writeFileSync(
      tokenPath,
      JSON.stringify(
        {
          skill,
          passed: true,
          signal: suite.verification_signal ?? "evals.json",
          minted_at: now,
          expires_at: now + TOKEN_TTL_MS,
          cases: Object.keys(results).length,
        },
        null,
        2,
      ) + "\n",
    );
    console.log(`  token minted (valid ${TOKEN_TTL_MS / 60000} min) -> ${skill}`);
  }

  console.log(`${green ? "GREEN" : "RED  "} ${skill}`);
  return green;
}

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const targets = args.filter((a) => !a.startsWith("--"));

const skills = flags.has("--all")
  ? readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(SKILLS_DIR, e.name, "evals.json")))
      .map((e) => e.name)
  : targets;

if (skills.length === 0) {
  console.error("usage: run-evals.mjs <skill-name> | --all [--accept-baseline] [--no-token]");
  process.exit(1);
}

let allGreen = true;
for (const skill of skills) {
  console.log(`\n== ${skill}`);
  const green = runSkill(skill, {
    acceptBaseline: flags.has("--accept-baseline"),
    mintToken: !flags.has("--no-token"),
  });
  allGreen = allGreen && green;
}

process.exit(allGreen ? 0 : 1);
