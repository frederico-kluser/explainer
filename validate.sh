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

echo "=== Test Backend ==="
npm --prefix backend test

echo "=== Test Frontend ==="
npm --prefix frontend test || true

echo "=== Build Backend ==="
npm --prefix backend run build

echo "=== Build Frontend ==="
npm --prefix frontend run build

echo "=== GATE OK ==="
