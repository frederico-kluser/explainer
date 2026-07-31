#!/usr/bin/env bash
# Sobe os dois servidores de desenvolvimento de uma vez:
#   backend  → http://localhost:3001  (tsx watch)
#   frontend → http://localhost:5173  (vite, com proxy /api → 3001)
#
# Ctrl+C derruba os dois. Se um morrer, o outro é derrubado junto — assim não
# fica um servidor órfão segurando a porta.
#
# Zero dependências novas: nada de concurrently/npm-run-all, no mesmo espírito
# de backend/src/load-env.ts.
set -euo pipefail

cd "$(dirname "$0")"

C_API=$'\033[36m'  # ciano
C_WEB=$'\033[35m'  # magenta
C_DIM=$'\033[2m'
C_OFF=$'\033[0m'

# --- Dependências ---------------------------------------------------------

for pkg in backend frontend; do
  if [ ! -d "$pkg/node_modules" ]; then
    echo "${C_DIM}[dev] instalando dependências de $pkg…${C_OFF}"
    npm --prefix "$pkg" install
  fi
done

# --- .env -----------------------------------------------------------------

if [ ! -f .env ] && [ ! -f backend/.env ]; then
  echo "${C_DIM}[dev] nenhum .env encontrado — 'cp .env.example .env' e preencha"
  echo "      OPENROUTER_API_KEY, senão STT, chat e TTS vão falhar.${C_OFF}"
fi

# --- Servidores -----------------------------------------------------------

API_PID=""
WEB_PID=""

cleanup() {
  trap - INT TERM EXIT
  for pid in "$API_PID" "$WEB_PID"; do
    [ -n "$pid" ] && kill -TERM "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

# `exec` dentro do subshell faz o PID capturado ser o do tsx/vite em si, e não
# o de um npm intermediário que não repassa o sinal.
(cd backend && exec node_modules/.bin/tsx watch src/index.ts) \
  > >(sed -u "s/^/${C_API}[api]${C_OFF} /") 2>&1 &
API_PID=$!

(cd frontend && exec node_modules/.bin/vite) \
  > >(sed -u "s/^/${C_WEB}[web]${C_OFF} /") 2>&1 &
WEB_PID=$!

echo "${C_API}[api]${C_OFF} http://localhost:${PORT:-3001}   ${C_WEB}[web]${C_OFF} http://localhost:5173"

# Volta assim que QUALQUER um dos dois sair; o trap derruba o sobrevivente.
wait -n
