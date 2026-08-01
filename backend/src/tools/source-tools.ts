import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { resolveInsideRoot } from "../middleware/sandbox.js";
import { findPrimaryDoc } from "../services/sources.js";
import type { ResolvedSource } from "../types/index.js";

const execFileAsync = promisify(execFile);

// The model is going to *speak* these results, so they are budgeted for the ear,
// not the eye: enough to answer with, short enough not to derail a conversation.
const MAX_FILE_CHARS = 20_000;
const MAX_SEARCH_CHARS = 8_000;
const MAX_MATCHES = 40;
const MAX_LISTING = 200;

/** Directories that are never worth grepping and always blow up the output. */
const IGNORED_DIRS = [
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "target",
  "vendor",
  "__pycache__",
  ".venv",
  "coverage",
];

function requireRoot(source: ResolvedSource): string {
  if (!source.root) {
    throw new Error(
      "Esta fonte nao tem arquivos para pesquisar — e um markdown solto. " +
        "Use web_search para buscar informacoes externas.",
    );
  }
  return source.root;
}

// ---------------------------------------------------------------------------
// read_source_doc
// ---------------------------------------------------------------------------

/**
 * Read the anchor document (README.md, the project-router skill, the pasted
 * markdown) or a specific document inside the source.
 */
export async function readSourceDoc(
  source: ResolvedSource,
  path?: string,
): Promise<string> {
  if (!path) {
    if (source.primary_doc) {
      const header = source.primary_doc_path
        ? `# ${source.label} — ${source.primary_doc_path}\n\n`
        : `# ${source.label}\n\n`;
      return header + source.primary_doc;
    }
    const root = requireRoot(source);
    const anchor = await findPrimaryDoc(root);
    if (!anchor) return "Nenhum documento principal encontrado nesta fonte.";
    return readTruncated(anchor);
  }

  return readSourceFile(source, path);
}

// ---------------------------------------------------------------------------
// read_source_file
// ---------------------------------------------------------------------------

export async function readSourceFile(
  source: ResolvedSource,
  path: string,
): Promise<string> {
  const root = requireRoot(source);
  const resolved = resolveInsideRoot(root, path);

  let info;
  try {
    info = await stat(resolved);
  } catch {
    return `Arquivo nao encontrado: ${path}`;
  }
  if (!info.isFile()) return `Nao e um arquivo: ${path}`;
  if (info.size > 2_000_000) {
    return `Arquivo grande demais para ler (${Math.round(info.size / 1024)} KB): ${path}`;
  }

  return `# ${path}\n\n${await readTruncated(resolved)}`;
}

// ---------------------------------------------------------------------------
// search_source
// ---------------------------------------------------------------------------

/**
 * Grep the source tree. ripgrep when it is on PATH, POSIX grep otherwise — the
 * fallback matters because a missing `rg` should degrade the answer, not the
 * conversation.
 */
export async function searchSource(
  source: ResolvedSource,
  query: string,
  subpath?: string,
): Promise<string> {
  const root = requireRoot(source);
  const target = subpath ? resolveInsideRoot(root, subpath) : root;

  const pattern = query.trim();
  if (!pattern) return "Consulta vazia.";

  const rgArgs = [
    "--no-heading",
    "--line-number",
    "--color",
    "never",
    "--smart-case",
    "--max-columns",
    "240",
    "--max-count",
    "4",
    ...IGNORED_DIRS.flatMap((dir) => ["--glob", `!${dir}/`]),
    "--",
    pattern,
    target,
  ];

  let stdout = "";
  try {
    ({ stdout } = await execFileAsync("rg", rgArgs, {
      timeout: 20_000,
      maxBuffer: 4 * 1024 * 1024,
    }));
  } catch (err) {
    const code = (err as { code?: number | string }).code;
    // ripgrep exits 1 when nothing matched — that is an answer, not a failure.
    if (code === 1) return `Nenhuma ocorrencia de "${pattern}" em ${source.label}.`;
    if (code === "ENOENT") {
      const grepped = await grepFallback(pattern, target);
      if (grepped !== null) return formatMatches(grepped, root, pattern, source.label);
    }
    const message = err instanceof Error ? err.message : String(err);
    // grep/rg put the useful part on stdout even when they exit non-zero.
    const partial = (err as { stdout?: string }).stdout;
    if (partial) return formatMatches(partial, root, pattern, source.label);
    return `Busca falhou: ${message}`;
  }

  return formatMatches(stdout, root, pattern, source.label);
}

async function grepFallback(
  pattern: string,
  target: string,
): Promise<string | null> {
  const args = [
    "-rn",
    "-I",
    "--max-count=4",
    ...IGNORED_DIRS.map((dir) => `--exclude-dir=${dir}`),
    "-e",
    pattern,
    target,
  ];
  try {
    const { stdout } = await execFileAsync("grep", args, {
      timeout: 20_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    const partial = (err as { stdout?: string }).stdout;
    return partial ?? null;
  }
}

function formatMatches(
  raw: string,
  root: string,
  pattern: string,
  label: string,
): string {
  const lines = raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => (line.startsWith(root) ? line.slice(root.length + 1) : line));

  if (lines.length === 0) {
    return `Nenhuma ocorrencia de "${pattern}" em ${label}.`;
  }

  const shown = lines.slice(0, MAX_MATCHES);
  let body = shown.join("\n");
  if (body.length > MAX_SEARCH_CHARS) {
    body = `${body.slice(0, MAX_SEARCH_CHARS)}\n[...truncado...]`;
  }
  const omitted = lines.length - shown.length;

  return (
    `${lines.length} ocorrencia(s) de "${pattern}" em ${label}:\n\n${body}` +
    (omitted > 0 ? `\n\n[+${omitted} ocorrencia(s) omitida(s)]` : "")
  );
}

// ---------------------------------------------------------------------------
// list_source_files
// ---------------------------------------------------------------------------

export async function listSourceFiles(
  source: ResolvedSource,
  subpath?: string,
): Promise<string> {
  const root = requireRoot(source);
  const target = subpath ? resolveInsideRoot(root, subpath) : root;

  let entries;
  try {
    entries = await readdir(target, { withFileTypes: true });
  } catch {
    return `Diretorio nao encontrado: ${subpath ?? "."}`;
  }

  const rows: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".agents") continue;
    if (IGNORED_DIRS.includes(entry.name)) continue;

    if (entry.isDirectory()) {
      rows.push(`${entry.name}/`);
    } else if (entry.isFile()) {
      let size = 0;
      try {
        size = (await stat(join(target, entry.name))).size;
      } catch {
        // deleted between readdir and stat — report it without the size
      }
      rows.push(`${entry.name} (${formatBytes(size)})`);
    }
    if (rows.length >= MAX_LISTING) {
      rows.push("[...]");
      break;
    }
  }

  if (rows.length === 0) return `Diretorio vazio: ${subpath ?? "."}`;

  return `${subpath ?? "."} em ${source.label}:\n${rows.sort().join("\n")}`;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function readTruncated(path: string): Promise<string> {
  const content = await readFile(path, "utf-8");
  return content.length > MAX_FILE_CHARS
    ? `${content.slice(0, MAX_FILE_CHARS)}\n\n[...truncado...]`
    : content;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
