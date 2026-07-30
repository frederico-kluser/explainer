#!/bin/bash
set -e
echo "=== Lint ==="
# (skip lint for now — no eslintrc configured)
echo "=== TypeCheck Backend ==="
cd backend && npx tsc --noEmit
echo "=== TypeCheck Frontend ==="
cd ../frontend && npx tsc --noEmit
echo "=== Build Frontend ==="
npx vite build
echo "=== GATE OK ==="
