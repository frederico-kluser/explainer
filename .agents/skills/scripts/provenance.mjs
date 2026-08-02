#!/usr/bin/env node
// Provenance stamping and staleness detection for skill citations.
//
// Format: `path/to/file.ts:42@ab12cd34`
//
// The hash is the first 8 hex of sha256 over the NORMALISED CONTENT OF THE CITED
// LINE, not of the file and not of the commit. Two reasons:
//   - A file hash goes stale on any unrelated edit, so every skill would be
//     permanently "to revalidate" and the signal would be ignored.
//   - A line hash survives line drift: when the cited line merely moved, this
//     tool finds it again and reports MOVED (auto-fixable) instead of STALE,
//     so only a real content change demands human revalidation.
//
// Usage:
//   node provenance.mjs stamp <file> <line>     print a citation
//   node provenance.mjs check [--fix]           verify every citation in skills

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";

const ROOT = resolve(process.cwd());
// Skills AND artifacts: a citation in an analysis document can go stale exactly
// the same way, and a checker that silently finds nothing to check is worse than
// no checker at all — it reports green.
const SCAN_DIRS = [resolve(ROOT, ".agents/skills"), resolve(ROOT, ".agents/artifacts")];

// Anchored to the repo root so a citation reads the same from any cwd.
const CITATION_RE = /\b([\w./-]+\.(?:ts|tsx|mts|mjs|js|json|sh|md)):(\d+)@([0-9a-f]{8})\b/g;

function normalise(line) {
  return line.replace(/\s+/g, " ").trim();
}

function hashLine(line) {
  return createHash("sha256").update(normalise(line)).digest("hex").slice(0, 8);
}

function readLines(path) {
  return readFileSync(resolve(ROOT, path), "utf8").split("\n");
}

function stamp(path, lineNumber) {
  const lines = readLines(path);
  const line = lines[lineNumber - 1];
  if (line === undefined) {
    throw new Error(`${path} has no line ${lineNumber} (${lines.length} lines)`);
  }
  return `${path}:${lineNumber}@${hashLine(line)}`;
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.endsWith(".md")) yield full;
  }
}

let citationCount = 0;

function check({ fix = false } = {}) {
  const findings = [];
  let citations = 0;

  for (const doc of SCAN_DIRS.filter(existsSync).flatMap((dir) => [...walk(dir)])) {
    let text = readFileSync(doc, "utf8");
    let rewritten = text;
    let changed = false;

    for (const match of text.matchAll(CITATION_RE)) {
      citations += 1;
      const [citation, path, rawLine, hash] = match;
      const lineNumber = Number(rawLine);
      const where = relative(ROOT, doc);

      let lines;
      try {
        lines = readLines(path);
      } catch {
        findings.push({ level: "STALE", where, citation, why: "cited file is gone" });
        continue;
      }

      const atLine = lines[lineNumber - 1];
      if (atLine !== undefined && hashLine(atLine) === hash) continue; // still true

      // The line may simply have moved; a unique content match is a safe relocate.
      const matches = lines
        .map((line, index) => (hashLine(line) === hash ? index + 1 : 0))
        .filter(Boolean);

      if (matches.length === 1) {
        const moved = `${path}:${matches[0]}@${hash}`;
        findings.push({ level: "MOVED", where, citation, why: `now line ${matches[0]}` });
        if (fix) {
          rewritten = rewritten.replaceAll(citation, moved);
          changed = true;
        }
        continue;
      }

      findings.push({
        level: "STALE",
        where,
        citation,
        why:
          matches.length > 1
            ? "cited line content is now ambiguous"
            : "cited line content changed — revalidate the claim",
      });
    }

    if (changed) writeFileSync(doc, rewritten);
  }

  citationCount = citations;
  if (citations === 0) {
    findings.push({
      level: "STALE",
      where: "(scan)",
      citation: "none",
      why: "no citations found — a vacuous pass is not evidence",
    });
  }

  return findings;
}

const [command, ...args] = process.argv.slice(2);

if (command === "stamp") {
  const [path, line] = args;
  if (!path || !line) {
    console.error("usage: provenance.mjs stamp <file> <line>");
    process.exit(1);
  }
  console.log(stamp(path, Number(line)));
} else if (command === "check") {
  const findings = check({ fix: args.includes("--fix") });
  const stale = findings.filter((f) => f.level === "STALE");
  for (const f of findings) {
    console.log(`${f.level.padEnd(5)} ${f.where}  ${f.citation}  — ${f.why}`);
  }
  if (findings.length === 0) console.log(`all ${citationCount} citations verified`);
  // MOVED is informational (and auto-fixable); only STALE means a claim may now
  // be false, which is the failure this whole system exists to catch.
  process.exit(stale.length > 0 ? 1 : 0);
} else {
  console.error("usage: provenance.mjs <stamp|check> [...]");
  process.exit(1);
}
