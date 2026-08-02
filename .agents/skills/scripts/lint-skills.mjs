#!/usr/bin/env node
// Deterministic linter for SKILL.md files.
//
// Every rule here exists because prose cannot enforce itself. A convention that
// a script can check is a guarantee; the same convention written as a paragraph
// is a suggestion that decays. This is the guarantee half.
//
// Usage: node .agents/skills/scripts/lint-skills.mjs [--quiet]
// Exit 0 = every skill passes. Exit 1 = at least one error.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";

const ROOT = resolve(process.cwd());
const SKILLS_DIR = resolve(ROOT, ".agents/skills");

// The mission fixes these names, so the gerund rule cannot apply to them.
const NAME_EXEMPT = new Set([
  "project-router",
  "meta-skill-evolution",
  "meta-skill-consolidate",
]);

const LIMITS = {
  nameChars: 64,
  descriptionChars: 1024,
  bodyLinesError: 500,
  bodyLinesWarn: 350,
};

const CITATION_RE = /\b[\w./-]+\.(?:ts|tsx|mts|mjs|js|json|sh|md):\d+@[0-9a-f]{8}\b/;
const DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/;
const CAPS_IMPERATIVE_RE = /\b(MUST|ALWAYS|NEVER)\b/;
// A caps imperative is allowed only next to its reason; the rule is "explain the
// why", so the linter checks that a why is present rather than banning emphasis.
const RATIONALE_RE = /\b(because|otherwise|so that|senão|porque|caso contr[áa]rio)\b|—/i;

/**
 * Minimal frontmatter reader. Deliberately not a YAML library: the schema is
 * two scalars plus one nested block, and this file must run with zero installs.
 */
function parseFrontmatter(text) {
  if (!text.startsWith("---\n")) return { error: "missing frontmatter fence" };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { error: "unterminated frontmatter" };

  const raw = text.slice(4, end);
  const body = text.slice(end + 4).replace(/^\n/, "");
  const data = {};
  let nested = null;

  for (const line of raw.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;

    const indented = /^\s/.test(line);
    const separator = line.indexOf(":");
    if (separator === -1) return { error: `unparseable frontmatter line: ${line}` };

    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();

    if (indented) {
      if (!nested) return { error: `indented key with no parent: ${line}` };
      nested[key] = value;
    } else if (value === "") {
      nested = {};
      data[key] = nested;
    } else {
      nested = null;
      data[key] = value.replace(/^["']|["']$/g, "");
    }
  }

  return { data, body };
}

function stripCodeFences(body) {
  return body.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
}

function lintSkill(path) {
  const errors = [];
  const warnings = [];
  const text = readFileSync(path, "utf8");
  const { data, body, error } = parseFrontmatter(text);

  if (error) return { errors: [error], warnings };

  const name = data.name;
  const description = data.description;
  const metadata = typeof data.metadata === "object" ? data.metadata : null;
  const type = metadata?.type;

  // --- frontmatter shape -------------------------------------------------
  const allowedKeys = new Set(["name", "description", "metadata"]);
  for (const key of Object.keys(data)) {
    if (!allowedKeys.has(key)) {
      errors.push(`frontmatter key "${key}" breaks cross-tool portability`);
    }
  }

  if (!name) errors.push("missing name");
  else {
    if (name.length > LIMITS.nameChars) errors.push(`name > ${LIMITS.nameChars} chars`);
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
      errors.push(`name "${name}" must be lowercase letters/digits separated by hyphens`);
    }
    if (!NAME_EXEMPT.has(name) && !/ing$/.test(name.split("-")[0])) {
      errors.push(`name "${name}" must start with a gerund (verb+ing)`);
    }
    if (name !== path.split("/").at(-2)) {
      errors.push(`name "${name}" does not match its directory`);
    }
  }

  if (!description) errors.push("missing description");
  else {
    if (description.length > LIMITS.descriptionChars) {
      errors.push(`description > ${LIMITS.descriptionChars} chars`);
    }
    if (!/^[A-Z][a-z]+s\b/.test(description)) {
      errors.push("description must open in the third person (e.g. 'Routes…', 'Explains…')");
    }
    // Selection among many skills happens on the description alone, and the
    // model under-triggers, so an explicit trigger clause is mandatory.
    const invites = /\bUse\b/i.test(description);
    const names_a_trigger =
      /\b(when|whenever|before|after|periodically|any time|during)\b/i.test(description);
    if (!invites || !names_a_trigger) {
      errors.push(
        "description must invite use and name a trigger ('Use whenever …', 'Use before …')",
      );
    }
  }

  if (!type) errors.push("missing metadata.type");
  else if (!["knowledge", "task", "router", "meta"].includes(type)) {
    errors.push(`metadata.type "${type}" is not knowledge|task|router|meta`);
  }

  if (type && type !== "router" && !metadata?.verification_signal) {
    errors.push("missing metadata.verification_signal (what externally validates updates)");
  }

  // --- body --------------------------------------------------------------
  const lines = body.split("\n");
  if (lines.length > LIMITS.bodyLinesError) {
    errors.push(`body ${lines.length} lines > ${LIMITS.bodyLinesError}; move detail to references/`);
  } else if (lines.length > LIMITS.bodyLinesWarn) {
    warnings.push(`body ${lines.length} lines; approaching the ${LIMITS.bodyLinesError} limit`);
  }

  // Sections are required per type: a router carries a protocol, a knowledge
  // skill carries knowledge, a task skill carries both plus the evolution step.
  if (!/^##\s+When to use\s*$/m.test(body)) errors.push("missing '## When to use'");

  if (type === "knowledge" || type === "task") {
    if (!/^##\s+Injected knowledge\s*$/m.test(body)) {
      errors.push("missing '## Injected knowledge'");
    }
  }
  if (type === "router" || type === "meta") {
    if (!/^##\s+(Protocol|Procedure)\s*$/m.test(body)) {
      errors.push("missing '## Protocol' or '## Procedure'");
    }
  }
  if (type === "task") {
    if (!/^##\s+Procedure\s*$/m.test(body)) errors.push("missing '## Procedure'");
    if (!/^##\s+<evolution>\s*$/m.test(body)) {
      errors.push("task skill must end with a '## <evolution>' section");
    }
  }

  const prose = stripCodeFences(body);

  if (DATE_RE.test(prose)) {
    errors.push("dates belong in git history, not in the skill body");
  }
  if (/^##+\s+(Changelog|History|Changelog\b)/im.test(body)) {
    errors.push("changelog section: history lives in git, not in the file");
  }

  for (const [index, line] of prose.split("\n").entries()) {
    if (CAPS_IMPERATIVE_RE.test(line) && !RATIONALE_RE.test(line)) {
      errors.push(`line ${index + 1}: caps imperative with no rationale — explain the why`);
    }
  }

  if ((type === "knowledge" || type === "task") && !CITATION_RE.test(body)) {
    errors.push("no provenance citation (path:line@hash) — claims must be traceable");
  }

  return { errors, warnings };
}

const quiet = process.argv.includes("--quiet");
let failed = 0;
let checked = 0;

if (!existsSync(SKILLS_DIR)) {
  console.error(`no skills directory at ${SKILLS_DIR}`);
  process.exit(1);
}

for (const entry of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const skillFile = join(SKILLS_DIR, entry.name, "SKILL.md");
  if (!existsSync(skillFile)) continue;

  checked += 1;
  const { errors, warnings } = lintSkill(skillFile);
  const where = relative(ROOT, skillFile);

  if (errors.length) {
    failed += 1;
    console.error(`FAIL ${where}`);
    for (const error of errors) console.error(`  - ${error}`);
  } else if (!quiet) {
    console.log(`ok   ${where}`);
  }
  for (const warning of warnings) console.error(`  ! ${where}: ${warning}`);
}

if (checked === 0) {
  console.error("no SKILL.md files found");
  process.exit(1);
}

console.log(`\n${checked - failed}/${checked} skills pass the linter`);
process.exit(failed > 0 ? 1 : 0);
