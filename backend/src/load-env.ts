import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Side-effect module: import it before anything that reads process.env.
//
// Node's built-in loader keeps the dependency count at zero; variables already
// present in the environment win over the file.

const CANDIDATES = [
  resolve(import.meta.dirname, "..", ".env"), // backend/.env
  resolve(import.meta.dirname, "..", "..", ".env"), // <repo root>/.env
];

for (const path of CANDIDATES) {
  if (!existsSync(path)) continue;
  try {
    process.loadEnvFile(path);
  } catch (err) {
    console.warn(
      `[env] Could not load ${path}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

if (!process.env.OPENAI_API_KEY) {
  console.warn(
    "[env] OPENAI_API_KEY is not set — the realtime session cannot be minted " +
      "and web search will fall back to surf-research-skill. " +
      "Copy .env.example to .env and fill it in.",
  );
}
