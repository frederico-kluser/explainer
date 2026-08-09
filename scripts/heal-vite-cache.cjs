#!/usr/bin/env node
/**
 * heal-vite-cache.cjs — surgically heal a TORN Vite dep-optimizer cache before
 * `electron-vite dev` ever reads it. This is the cross-session half of the
 * definitive fix for the recurring renderer hang:
 *
 *   The file does not exist at ".../node_modules/.vite/deps/chunk-XXXX.js?v=YYYY"
 *   which is in the optimize deps directory.
 *   [Window] Browser ready - waiting for React app...
 *   [Window] react-ready not received in time - showing window fallback
 *
 * Mechanism (see docs/ondokai-dev-mode.md §6 (h)): Vite pre-bundles deps into
 * node_modules/.vite/deps/. A re-optimize that is INTERRUPTED (Ctrl+C during
 * "optimizing dependencies"), CLOBBERED by two dev servers writing the same
 * cache, or left over from a branch switch / npm install can leave the cache
 * INCONSISTENT: an optimized module (or _metadata.json) references a sibling
 * `chunk-XXXX.js` that no longer exists on disk, UNDER THE SAME browserHash (so
 * there is no `?v=` cache-bust to save the renderer). The renderer then 404s on
 * that lazy import, React never mounts, the `react-ready` IPC never fires, and
 * the window hangs at the dev fallback. The runtime half of the fix lives in
 * electron/main/window.ts (a bounded `reloadIgnoringCache()` self-heal).
 *
 * This script runs as the FIRST step of every `npm run dev*` (chained in the
 * package.json dev scripts). It is:
 *   - SURGICAL by default: it only clears `.vite` when it proves the cache is
 *     torn, so a healthy cache keeps its fast warm start (no penalty).
 *   - `--force`: always clears (used by `npm run dev:clean`).
 *   - cwd-INDEPENDENT: resolves `.vite` relative to this file, so it works when
 *     called from the repo root (dev-clean-with-cleanup.sh) or from electron-huu.
 *   - NON-FATAL: it ALWAYS exits 0 — healing must never block `npm run dev`.
 *
 * The `.vite` cache is gitignored and fully regenerable, so deleting it is safe.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const FORCE = process.argv.includes('--force');
const QUIET = process.argv.includes('--quiet');

// Resolve relative to THIS file (electron-huu/scripts/) so the script is
// cwd-independent — callable from the repo root or from electron-huu.
const electronHuuRoot = path.resolve(__dirname, '..');
const viteCacheDir = path.join(electronHuuRoot, 'node_modules', '.vite');
const depsDir = path.join(viteCacheDir, 'deps');

function log(msg) {
  if (!QUIET) {
    console.log(`[heal-vite] ${msg}`);
  }
}

/**
 * electron-vite writes `electron.vite.config.<timestamp>.mjs` while it runs and
 * deletes it on a clean exit. A leftover one is the forensic signature of a
 * hard-killed dev run (and a stale temp can confuse the next esbuild bundle).
 */
function removeOrphanTempConfigs() {
  try {
    for (const name of fs.readdirSync(electronHuuRoot)) {
      if (/^electron\.vite\.config\..+\.mjs$/.test(name)) {
        fs.rmSync(path.join(electronHuuRoot, name), { force: true });
        log(`removed orphan temp config ${name} (forensic: hard-killed dev run)`);
      }
    }
  } catch {
    /* best effort — never block dev */
  }
}

function nuke(reason) {
  try {
    fs.rmSync(viteCacheDir, { recursive: true, force: true });
    log(`cleared node_modules/.vite (${reason})`);
  } catch (err) {
    log(`could not clear .vite (${reason}): ${err && err.message}`);
  }
}

/**
 * Returns a human-readable reason string if the deps cache is torn, else null.
 * Torn = a chunk referenced by _metadata.json OR imported by an optimized file
 * is missing from disk.
 */
function findTear() {
  let metadata;
  try {
    metadata = JSON.parse(fs.readFileSync(path.join(depsDir, '_metadata.json'), 'utf8'));
  } catch {
    // No (or unreadable) metadata: nothing to validate — let Vite build it clean.
    return null;
  }

  let onDisk;
  try {
    onDisk = new Set(fs.readdirSync(depsDir));
  } catch {
    return null;
  }

  // 1. Every file referenced by the optimizer metadata must exist.
  const referenced = [];
  for (const entry of Object.values(metadata.optimized || {})) {
    if (entry && entry.file) referenced.push(entry.file);
  }
  for (const entry of Object.values(metadata.chunks || {})) {
    if (entry && entry.file) referenced.push(entry.file);
  }
  for (const file of referenced) {
    if (!onDisk.has(path.basename(file))) {
      return `_metadata.json references missing ${path.basename(file)}`;
    }
  }

  // 2. Every `chunk-XXXX.js` imported by an optimized file must exist. This is
  //    the case the metadata check misses: same browserHash, but a re-optimize
  //    swapped the underlying chunk filenames.
  for (const name of onDisk) {
    if (!name.endsWith('.js')) continue;
    let content;
    try {
      content = fs.readFileSync(path.join(depsDir, name), 'utf8');
    } catch {
      continue;
    }
    const re = /chunk-[A-Z0-9]{6,14}\.js/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      if (!onDisk.has(m[0])) {
        return `${name} imports missing ${m[0]}`;
      }
    }
  }

  return null;
}

function main() {
  removeOrphanTempConfigs();

  if (FORCE) {
    nuke('forced via --force');
    return;
  }

  if (!fs.existsSync(depsDir)) {
    // Fresh checkout / already-cleared — Vite will optimize cleanly on start.
    return;
  }

  const tear = findTear();
  if (tear) {
    nuke(`torn cache: ${tear}`);
  } else {
    log('dep-optimizer cache is consistent — keeping warm start');
  }
}

try {
  main();
} catch (err) {
  // Healing is best-effort; never block `npm run dev`.
  log(`unexpected error (ignored): ${err && err.message}`);
}

process.exit(0);
