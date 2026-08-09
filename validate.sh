#!/bin/bash
set -e

echo "=== Lint Backend ==="
npm --prefix backend run lint

echo "=== Lint Frontend ==="
npm --prefix frontend run lint

echo "=== TypeCheck Backend ==="
npm --prefix backend run typecheck

echo "=== TypeCheck Frontend ==="
npm --prefix frontend run typecheck

# Re-runs the two above on the way to tsconfig.node.json and tsconfig.web.json,
# which nothing else in this gate reaches: the electron main and preload sources,
# and the frontend sources as the desktop build types them. The overlap costs a
# few seconds and is the price of not having to keep a second list of projects
# in sync with package.json.
echo "=== TypeCheck Root (4 projects) ==="
npm run typecheck

echo "=== Test Backend ==="
npm --prefix backend test

echo "=== Test Frontend ==="
npm --prefix frontend test || true

# Run by path rather than through a package.json script: the desktop suite lives
# outside both workspaces, and `--root .` is what points vitest at the root
# install. There is no vite.config.ts at the root (the file is named
# electron.vite.config.ts), so vitest takes its defaults and resolves cleanly.
# No `|| true` here — unlike the frontend line above, this one is meant to fail
# the gate.
echo "=== Test Desktop (electron main) ==="
npx vitest run --root . electron/main/services/__tests__/backend-process.test.ts

echo "=== Build Backend ==="
npm --prefix backend run build

echo "=== Build Frontend ==="
npm --prefix frontend run build

# The only check that compiles electron.vite.config.ts itself and every source
# it pulls into main, preload and the renderer. Without it the gate could stay
# green while the packaged app failed to build at all.
echo "=== Build Desktop ==="
npx electron-vite build

echo "=== GATE OK ==="
