import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Side-effect module: import it before anything that reads process.env.
//
// `.env.example` and the playbook both tell the operator to put
// OPENROUTER_API_KEY in a `.env`, but nothing was ever reading that file, so the
// key never reached the process. Node's built-in loader keeps the dependency
// count at zero; variables already present in the environment win.

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

if (!process.env.OPENROUTER_API_KEY) {
  console.warn(
    "[env] OPENROUTER_API_KEY is not set — STT, chat and TTS will fail. " +
      "Copy .env.example to .env and fill it in.",
  );
}
