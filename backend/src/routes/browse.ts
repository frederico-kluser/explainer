import { Router } from "express";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import {
  SandboxError,
  allowedSourceRoots,
  assertAllowedSourceRoot,
  isInsideRoot,
} from "../middleware/sandbox.js";

const router = Router();

const MAX_ENTRIES = 400;

interface BrowseEntry {
  name: string;
  path: string;
  /** True when the directory is a git working tree. */
  is_repo: boolean;
  /** True when it has a README (or another anchor document) to talk about. */
  has_doc: boolean;
}

const DOC_NAMES = [
  "README.md",
  "readme.md",
  "Readme.md",
  "README.MD",
  "README",
  "SKILL.md",
  "AGENTS.md",
  "CLAUDE.md",
];

// ---------------------------------------------------------------------------
// GET /api/browse?path=… — walk the machine to find a repository
// ---------------------------------------------------------------------------
//
// Typing an absolute path from memory is the worst part of pointing a tool at a
// local repo, so the UI navigates instead. The walk is confined to the same
// roots a local material may live under: this endpoint must not become a way to
// enumerate the whole filesystem from the browser.

router.get("/", async (req, res, next) => {
  try {
    const roots = allowedSourceRoots();
    const requested = typeof req.query.path === "string" ? req.query.path : "";

    if (!requested) {
      // No path yet: offer the roots themselves as the starting points.
      const entries = await Promise.all(
        roots.map(async (root) => describe(root)),
      );
      res.json({
        path: null,
        parent: null,
        roots,
        entries: entries.filter((entry): entry is BrowseEntry => entry !== null),
      });
      return;
    }

    const target = assertAllowedSourceRoot(requested);

    let dirEntries;
    try {
      dirEntries = await readdir(target, { withFileTypes: true });
    } catch {
      res.status(404).json({ error: `Diretório não encontrado: ${requested}` });
      return;
    }

    const directories = dirEntries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .slice(0, MAX_ENTRIES);

    const entries = (
      await Promise.all(
        directories.map((entry) => describe(join(target, entry.name))),
      )
    ).filter((entry): entry is BrowseEntry => entry !== null);

    entries.sort((a, b) => {
      // Repositories first — they are what the user came here for.
      if (a.is_repo !== b.is_repo) return a.is_repo ? -1 : 1;
      return a.name.localeCompare(b.name, "pt-BR");
    });

    // Offer "up" only while it stays inside an allowed root.
    const parent = dirname(target);
    const canGoUp =
      parent !== target && roots.some((root) => isInsideRoot(root, parent));

    res.json({
      path: target,
      parent: canGoUp ? parent : null,
      roots,
      entries,
      self: await describe(target),
    });
  } catch (err) {
    if (err instanceof SandboxError) {
      res.status(403).json({ error: err.message });
      return;
    }
    next(err);
  }
});

async function describe(path: string): Promise<BrowseEntry | null> {
  const absolute = resolve(path.replace(/^~(?=$|\/)/, homedir()));

  try {
    if (!(await stat(absolute)).isDirectory()) return null;
  } catch {
    return null;
  }

  const [isRepo, hasDoc] = await Promise.all([
    exists(join(absolute, ".git")),
    hasAnchorDoc(absolute),
  ]);

  return {
    name: basename(absolute) || absolute,
    path: absolute,
    is_repo: isRepo,
    has_doc: hasDoc,
  };
}

async function hasAnchorDoc(dir: string): Promise<boolean> {
  for (const name of DOC_NAMES) {
    if (await exists(join(dir, name))) return true;
  }
  return false;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export default router;
