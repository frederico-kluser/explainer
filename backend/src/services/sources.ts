import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { v4 as uuidv4 } from "uuid";

import {
  MACHINE_DOCS_ROOT,
  REPO_CACHE_ROOT,
  assertAllowedSourceRoot,
  ensureDir,
} from "../middleware/sandbox.js";
import type { ResolvedSource, SourceKind, SourceSpec } from "../types/index.js";

const execFileAsync = promisify(execFile);

/** How much of the anchor document goes into the model's instructions. */
const PRIMARY_DOC_LIMIT = 24_000;

const GITHUB_URL_RE =
  /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/.*)?$/i;
const SHORTHAND_RE = /^([\w.-]+)\/([\w.-]+)$/;

export class SourceError extends Error {
  public readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "SourceError";
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

interface GitHubRef {
  owner: string;
  repo: string;
  url: string;
}

/** Parse `https://github.com/owner/repo`, `owner/repo`, or `…/blob/main/README.md`. */
export function parseGitHubRef(input: string): GitHubRef | null {
  const trimmed = input.trim();

  const url = GITHUB_URL_RE.exec(trimmed);
  if (url?.[1] && url[2]) {
    return {
      owner: url[1],
      repo: url[2],
      url: `https://github.com/${url[1]}/${url[2]}.git`,
    };
  }

  // Bare `owner/repo` — but only when it can't be a real path.
  const short = SHORTHAND_RE.exec(trimmed);
  if (short?.[1] && short[2] && !trimmed.startsWith(".") && !trimmed.startsWith("/")) {
    return {
      owner: short[1],
      repo: short[2],
      url: `https://github.com/${short[1]}/${short[2]}.git`,
    };
  }

  return null;
}

/**
 * Decide what the user just handed us.
 *
 * The concept the UI implements: a repo README unlocks the repo tools, free
 * markdown unlocks nothing but the web, and a question about the laptop routes
 * to the machine docs. This is the server-side half of that routing, used when
 * the client sends `kind: "auto"`.
 */
export function inferKind(spec: SourceSpec): SourceKind {
  if (spec.kind && spec.kind !== ("auto" as SourceKind)) return spec.kind;
  if (spec.ref && spec.ref.trim().length > 0) return "repo";
  return "markdown";
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Turn a client-supplied spec into a directory + anchor document on disk. */
export async function resolveSource(spec: SourceSpec): Promise<ResolvedSource> {
  const kind = inferKind(spec);

  switch (kind) {
    case "machine":
      return resolveMachine(spec);
    case "repo":
      return resolveRepo(spec);
    case "markdown":
      return resolveMarkdown(spec);
    default:
      throw new SourceError(`Unknown source kind: ${String(kind)}`);
  }
}

async function resolveMachine(spec: SourceSpec): Promise<ResolvedSource> {
  const root = MACHINE_DOCS_ROOT;
  if (!(await isDirectory(root))) {
    throw new SourceError(
      `Machine docs directory not found: ${root}. Set EXPLAINER_MACHINE_DOCS.`,
      404,
    );
  }

  // The router skill is the domain → document index for the whole tree; it is a
  // far better anchor than the repo README, which only describes the folders.
  const routerSkill = join(root, ".agents", "skills", "project-router", "SKILL.md");
  const anchor = (await fileExists(routerSkill))
    ? routerSkill
    : await findPrimaryDoc(root);

  return {
    id: uuidv4(),
    kind: "machine",
    label: spec.label || "Este computador",
    root,
    origin: root,
    primary_doc_path: anchor ? relativeTo(root, anchor) : undefined,
    primary_doc: anchor ? await readTruncated(anchor) : undefined,
    resolved_at: new Date().toISOString(),
  };
}

async function resolveRepo(spec: SourceSpec): Promise<ResolvedSource> {
  const ref = (spec.ref ?? "").trim();
  if (!ref) throw new SourceError("A repo source needs a `ref` (URL or path)");

  const github = parseGitHubRef(ref);
  let root: string;
  let origin: string;
  let ephemeral = false;

  if (github) {
    root = await cloneOrReuse(github);
    origin = `https://github.com/${github.owner}/${github.repo}`;
    ephemeral = true;
  } else {
    // A local path. It may point at the README itself rather than the repo.
    let candidate = resolve(ref.replace(/^~(?=$|\/)/, homedir()));
    if (await fileExists(candidate)) {
      candidate = resolve(candidate, "..");
    }
    if (!(await isDirectory(candidate))) {
      throw new SourceError(`Not a directory: ${candidate}`, 404);
    }
    root = assertAllowedSourceRoot(candidate);
    origin = root;
  }

  const anchor = await findPrimaryDoc(root);

  return {
    id: uuidv4(),
    kind: "repo",
    label: spec.label || (github ? `${github.owner}/${github.repo}` : basename(root)),
    root,
    origin,
    ephemeral,
    primary_doc_path: anchor ? relativeTo(root, anchor) : undefined,
    primary_doc: anchor ? await readTruncated(anchor) : undefined,
    resolved_at: new Date().toISOString(),
  };
}

function resolveMarkdown(spec: SourceSpec): ResolvedSource {
  const markdown = (spec.markdown ?? "").trim();
  if (!markdown) {
    throw new SourceError("A markdown source needs a `markdown` body");
  }

  return {
    id: uuidv4(),
    kind: "markdown",
    label: spec.label || firstHeading(markdown) || "Documento markdown",
    primary_doc: markdown.slice(0, PRIMARY_DOC_LIMIT),
    resolved_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Cloning
// ---------------------------------------------------------------------------

/**
 * Shallow-clone a GitHub repo into the cache, or reuse what is already there.
 *
 * Shallow and single-branch: the point is to read the README and grep the tree,
 * not to have history. A stale cache is refreshed on a best-effort basis — a
 * failed fetch is never fatal, because the cached copy still answers questions.
 */
async function cloneOrReuse(ref: GitHubRef): Promise<string> {
  await ensureDir(REPO_CACHE_ROOT);

  const slug = `${ref.owner}-${ref.repo}`.replace(/[^\w.-]/g, "_");
  const digest = createHash("sha256").update(ref.url).digest("hex").slice(0, 8);
  const dir = join(REPO_CACHE_ROOT, `${slug}-${digest}`);

  if (await isDirectory(join(dir, ".git"))) {
    try {
      await execFileAsync("git", ["-C", dir, "fetch", "--depth", "1", "origin"], {
        timeout: 60_000,
      });
      await execFileAsync("git", ["-C", dir, "reset", "--hard", "FETCH_HEAD"], {
        timeout: 30_000,
      });
    } catch (err) {
      console.warn(
        `[sources] Refresh of ${ref.url} failed, using the cached clone:`,
        err instanceof Error ? err.message : String(err),
      );
    }
    return dir;
  }

  try {
    await execFileAsync(
      "git",
      ["clone", "--depth", "1", "--single-branch", ref.url, dir],
      { timeout: 180_000 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/could not read|not found|repository .* does not exist/i.test(message)) {
      throw new SourceError(
        `Repository not found or private: ${ref.owner}/${ref.repo}`,
        404,
      );
    }
    throw new SourceError(`git clone failed: ${message}`, 502);
  }

  return dir;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PRIMARY_DOC_CANDIDATES = [
  "README.md",
  "readme.md",
  "Readme.md",
  "README.MD",
  "README.markdown",
  "README",
  "SKILL.md",
  "AGENTS.md",
  "CLAUDE.md",
  "docs/README.md",
];

/** Find the document that best introduces a directory. */
export async function findPrimaryDoc(root: string): Promise<string | null> {
  for (const candidate of PRIMARY_DOC_CANDIDATES) {
    const path = join(root, candidate);
    if (await fileExists(path)) return path;
  }

  // Nothing conventional — take the first markdown file at the top level.
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const md = entries
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md"))
      .map((e) => e.name)
      .sort()[0];
    if (md) return join(root, md);
  } catch {
    // unreadable directory — treated as "no anchor"
  }

  return null;
}

async function readTruncated(path: string): Promise<string> {
  const content = await readFile(path, "utf-8");
  return content.length > PRIMARY_DOC_LIMIT
    ? `${content.slice(0, PRIMARY_DOC_LIMIT)}\n\n[...documento truncado...]`
    : content;
}

function relativeTo(root: string, path: string): string {
  return path.startsWith(root) ? path.slice(root.length).replace(/^[/\\]/, "") : path;
}

export function firstHeading(markdown: string): string | null {
  const match = /^#{1,3}\s+(.+)$/m.exec(markdown);
  return match?.[1]?.trim() ?? null;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
