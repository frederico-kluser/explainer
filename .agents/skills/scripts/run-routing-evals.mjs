#!/usr/bin/env node
// Routing evals: does each description actually discriminate?
//
// At selection time the description is the only signal, and every skill competes
// with every other. This scores a query against all descriptions with IDF
// weighting — a term shared by six skills is worth almost nothing, a term unique
// to one is worth a lot — and asserts the expected skill wins.
//
// What this measures: lexical discrimination between descriptions. What it does
// NOT measure: the model's own semantic and cross-lingual matching, which is
// stronger than this and is why the cases lean on identifiers and file names
// that read the same in Portuguese and English.
//
// Usage: node .agents/skills/scripts/run-routing-evals.mjs

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(process.cwd());
const SKILLS_DIR = resolve(ROOT, ".agents/skills");
const CASES = resolve(SKILLS_DIR, "evals/routing.json");

const STOPWORDS = new Set(
  ("a as o os um uma de do da dos das em no na nos nas e ou que se por para com " +
    "the a an of to in on and or for is are it its this that use when whenever " +
    "before after any time even if never always every all not").split(" "),
);

function terms(text) {
  return new Set(
    text
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .split(/[^a-z0-9_.]+/)
      .filter((t) => t.length > 2 && !STOPWORDS.has(t)),
  );
}

function descriptionOf(skill) {
  const text = readFileSync(join(SKILLS_DIR, skill, "SKILL.md"), "utf8");
  const match = /^description:\s*(.+)$/m.exec(text);
  return match ? match[1] : "";
}

const skills = readdirSync(SKILLS_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(SKILLS_DIR, e.name, "SKILL.md")))
  .map((e) => ({ name: e.name, terms: terms(descriptionOf(e.name)) }));

// A term in every description carries no information; a term in one carries all
// of it. This is the whole reason a vague description routes badly.
const documentFrequency = new Map();
for (const skill of skills) {
  for (const term of skill.terms) {
    documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }
}

function rank(query) {
  const queryTerms = terms(query);
  return skills
    .map((skill) => {
      let score = 0;
      for (const term of queryTerms) {
        if (!skill.terms.has(term)) continue;
        score += Math.log(skills.length / documentFrequency.get(term));
      }
      return { name: skill.name, score };
    })
    .sort((a, b) => b.score - a.score);
}

const suite = JSON.parse(readFileSync(CASES, "utf8"));
let failed = 0;

for (const testCase of suite.cases) {
  const ranked = rank(testCase.query);
  const top = ranked[0];
  const winners = ranked.filter((r) => r.score > 0).map((r) => r.name);

  let ok;
  let detail;

  if (testCase.expect) {
    ok = top.score > 0 && top.name === testCase.expect;
    detail = ok ? "" : `got ${top.name} (${top.score.toFixed(2)}), wanted ${testCase.expect}`;
  } else {
    // Near-miss: the named skills must not surface at all.
    const surfaced = testCase.expect_not.filter((name) => winners.includes(name));
    ok = surfaced.length === 0;
    detail = ok ? "" : `wrongly surfaced ${surfaced.join(", ")}`;
  }

  if (!ok) failed += 1;
  console.log(`${ok ? "pass" : "FAIL"}  ${testCase.query}${detail ? ` — ${detail}` : ""}`);
}

console.log(`\n${suite.cases.length - failed}/${suite.cases.length} routing cases`);
process.exit(failed > 0 ? 1 : 0);
