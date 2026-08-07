import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Side-effect module: import it before anything that reads process.env.
//
// Phase 1 — load every variable through Node's built-in loader.  It won't
// overwrite keys already present in the environment, which is the right
// default for everything EXCEPT the API key: the .env file IS the source of
// truth and must win over any shell-inherited value.
//
// Phase 2 — re-read the file ourselves and force-set OPENAI_API_KEY so the
// .env value always wins, no matter what the parent process exported.

const CANDIDATES = [
  resolve(import.meta.dirname, "..", ".env"), // backend/.env
  resolve(import.meta.dirname, "..", "..", ".env"), // <repo root>/.env
];

for (const path of CANDIDATES) {
  if (!existsSync(path)) continue;

  // Phase 1: load everything (best-effort; won't overwrite existing vars).
  try {
    process.loadEnvFile(path);
  } catch (err) {
    console.warn(
      `[env] Could not load ${path}:`,
      err instanceof Error ? err.message : String(err),
    );
  }

  // Phase 2: force OPENAI_API_KEY from the file, always.
  try {
    const raw = readFileSync(path, "utf-8");
    const match = raw.match(/^OPENAI_API_KEY\s*=\s*(.+)$/m);
    if (match?.[1]) {
      const value = match[1].trim();
      // Strip optional surrounding quotes (single, double, or backticks).
      const unquoted = value.replace(/^["'`]|["'`]$/g, "");
      if (unquoted && unquoted !== "sk-proj-...") {
        process.env.OPENAI_API_KEY = unquoted;
      }
    }
  } catch (err) {
    console.warn(
      `[env] Could not force-read OPENAI_API_KEY from ${path}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

if (process.env.OPENAI_API_KEY) {
  const preview =
    process.env.OPENAI_API_KEY.slice(0, 15) + "..." +
    process.env.OPENAI_API_KEY.slice(-4);
  console.log(`[env] OPENAI_API_KEY loaded: ${preview}`);
} else {
  console.warn(
    "[env] OPENAI_API_KEY is not set — the realtime session cannot be minted " +
      "and web search will fall back to surf-research-skill. " +
      "Copy .env.example to .env and fill it in.",
  );
}
