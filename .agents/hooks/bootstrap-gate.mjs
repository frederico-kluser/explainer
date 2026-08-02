#!/usr/bin/env node
// Stop hook: refuses to let the turn end while the skills-system bootstrap has
// unfinished phases.
//
// Why this exists: an agent stops when work "looks done". Without a pass/fail
// signal, "looks done" is the only signal, and a human becomes the verification
// loop. This turns "complete the whole mission" into a deterministic check.
//
// Exit 0 = allow the turn to end. Exit 2 = block, stderr goes back to the agent.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const STATE = resolve(process.cwd(), ".agents/skills/.bootstrap-state.json");
const ATTEMPTS = resolve(process.cwd(), ".agents/skills/.stop-attempts");

// Kept in its own file rather than in the state JSON: the agent edits the state
// file too, and a hook racing it would corrupt the persistence backbone.
const MAX_BLOCKS = 3;

function readJSON(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

let payload = {};
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch {
  // No stdin (manual run): fall through and evaluate the state anyway.
}

// The documented infinite-loop guard: never block a stop that a stop hook
// already caused.
if (payload.stop_hook_active) process.exit(0);

const state = readJSON(STATE);
if (!state) process.exit(0); // no bootstrap in flight
if (state.mission_complete) process.exit(0);

const pending = (state.phases ?? []).filter(
  (phase) => !phase.done || !phase.gate_passed,
);
if (pending.length === 0) process.exit(0);

const attempts = Number(existsSync(ATTEMPTS) ? readFileSync(ATTEMPTS, "utf8") : 0) || 0;

if (attempts >= MAX_BLOCKS) {
  // A genuinely stuck gate must not trap the session in a loop. Let the turn
  // end and make the stuck state loud instead.
  console.log(
    `[bootstrap-gate] Released after ${attempts} blocks. STILL PENDING: ` +
      pending.map((p) => `${p.id}:${p.name}`).join(", "),
  );
  process.exit(0);
}

writeFileSync(ATTEMPTS, String(attempts + 1));

console.error(
  "Bootstrap incomplete — do not end the turn yet.\n" +
    "Pending phases:\n" +
    pending
      .map(
        (p) =>
          `  ${p.id}. ${p.name} (done=${p.done}, gate_passed=${p.gate_passed}) -> ${p.artifact}`,
      )
      .join("\n") +
    "\nRun each phase's self-verification gate, write its artifact, commit, then " +
    "set done/gate_passed in .agents/skills/.bootstrap-state.json. " +
    `This hook releases after ${MAX_BLOCKS} blocks if a gate is truly stuck.`,
);
process.exit(2);
