import { defineConfig } from "vitest/config";

// The desktop suite's config, and the reason it exists at all.
//
// `validate.sh` runs `npx vitest run --root .` over the Electron main process
// tests. Without a config *here*, Vitest resolves one by walking up the
// directory tree — out of the repository and into whatever happens to be above
// it. Measured: a `vitest.config.ts` belonging to an unrelated project sitting
// in the developer's home directory was loaded instead, failed on an import it
// could not resolve from here, and took the gate down with a stack trace that
// named neither this repository nor the suite it was running.
//
// So this file is not configuration so much as a boundary: it makes the desktop
// step depend on nothing outside the checkout. `backend/` and `frontend/` were
// already immune — each carries its own config and is run with `--prefix`.
export default defineConfig({
  test: {
    globals: true,
    // Node, not a DOM: this suite covers the main process, which spawns and
    // supervises the backend. The renderer's tests live in `frontend/` and run
    // under that package's own config.
    environment: "node",
    include: ["electron/**/__tests__/**/*.test.ts", "src/shared/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/out/**"],
  },
});
