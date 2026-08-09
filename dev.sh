#!/usr/bin/env bash
# Sobe os dois servidores de desenvolvimento de uma vez:
#   backend  → http://localhost:3001 (tsx watch, só em loopback)
#   frontend → localhost:5173        (vite, exposto na LAN e em HTTPS quando há
#                                     certificado, com proxy /api → 3001)
#
# Ctrl+C derruba os dois. Se um morrer, o outro é derrubado junto — assim não
# fica um servidor órfão segurando a porta.
#
# Zero dependências novas: nada de concurrently/npm-run-all, no mesmo espírito
# de backend/src/load-env.ts.
#
# Why this script opens the browser itself: the product is a browser app — the
# thing `npm run dev` exists to start is a WebRTC session that only a page can
# hold — so a run that stops at a printed URL is a run that is not finished.
# Vite's own `server.open` cannot take this job: it fires the moment the server
# binds, and the tab then races the first transform. Waiting for 5173 to accept
# a socket is the condition that actually means there is a page to land on.
#
# Why the opener is detached: this script ends on `wait -n`, which returns for
# *any* job the shell still owns. A launcher exits within milliseconds, so left
# as a job it would satisfy `wait -n` at once and the trap would kill both
# servers a second after they came up. `disown` takes it out of the job table,
# and its PID is deliberately kept out of `cleanup` — Ctrl+C stops the servers,
# never the developer's browser.
#
# Escapes, for an editor or a container that already has the tab open:
# `BROWSER=none`, `NO_OPEN=1`, or `dev.sh --no-open`.
set -euo pipefail

cd "$(dirname "$0")"

C_API=$'\033[36m'  # ciano
C_WEB=$'\033[35m'  # magenta
C_DIM=$'\033[2m'
C_OFF=$'\033[0m'

OPEN_BROWSER=1
if [ $# -gt 0 ]; then
  for arg in "$@"; do
    if [ "$arg" = "--no-open" ]; then
      OPEN_BROWSER=0
    fi
  done
fi
if [ "${NO_OPEN:-}" = "1" ] || [ "${BROWSER:-}" = "none" ]; then
  OPEN_BROWSER=0
fi

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
  echo "      OPENAI_API_KEY, senão a sessão de voz não abre.${C_OFF}"
fi

# --- Certificado de LAN ---------------------------------------------------

# Emite (ou reemite, se o IP mudou) o certificado que deixa o celular abrir o
# app com microfone. Nunca derruba o dev.sh: sem mkcert o Vite cai para HTTP e
# o app continua funcionando em localhost.
if ! node scripts/dev-cert.mjs; then
  echo "${C_DIM}[dev] o passo do certificado falhou — subindo os servidores assim mesmo.${C_OFF}"
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

# O endereço da LAN sai do mesmo script que emitiu o certificado, para não
# duplicar aqui a lógica de descobrir o IP nem a de saber se há HTTPS.
LAN_URL="$(node scripts/dev-cert.mjs --print-url 2>/dev/null || true)"
[ -n "$LAN_URL" ] || LAN_URL="http://localhost:5173"
SCHEME="${LAN_URL%%://*}"
LOCAL_URL="${SCHEME}://localhost:5173"

echo "${C_API}[api]${C_OFF} http://localhost:${PORT:-3001}   ${C_WEB}[web]${C_OFF} ${LOCAL_URL}"
echo "${C_WEB}[web]${C_OFF} no celular (mesmo wifi): ${LAN_URL}"

# --- Navegador ------------------------------------------------------------

# The probe is a raw `net.connect` rather than an HTTP request because the only
# question being asked is whether the port answers, and one `node` that waits on
# its own beats a shell loop that spawns forty of them.
open_browser_when_ready() {
  local opener="$1" url="$2"

  node -e '
    const deadline = Date.now() + 20000;
    import("node:net").then(({ default: net }) => {
      const attempt = () => {
        let settled = false;
        const socket = net.connect({ host: "127.0.0.1", port: 5173 });
        const retry = () => {
          if (settled) return;
          settled = true;
          socket.destroy();
          if (Date.now() >= deadline) process.exit(1);
          setTimeout(attempt, 250);
        };
        socket.once("connect", () => { socket.destroy(); process.exit(0); });
        socket.once("error", retry);
        socket.setTimeout(1000, retry);
      };
      attempt();
    });
  ' || return 0

  case "$opener" in
    cmd.exe) cmd.exe /c start "" "$url" || true ;;
    *) "$opener" "$url" || true ;;
  esac
}

if [ "$OPEN_BROWSER" = "1" ]; then
  # The order is dictated by platform, not preference: WSL usually has no
  # xdg-open, and there the thing that reaches a browser is cmd.exe.
  BROWSER_OPENER=""
  if command -v xdg-open >/dev/null 2>&1; then
    BROWSER_OPENER="xdg-open"
  elif command -v open >/dev/null 2>&1; then
    BROWSER_OPENER="open"
  elif command -v cmd.exe >/dev/null 2>&1; then
    BROWSER_OPENER="cmd.exe"
  fi

  if [ -n "$BROWSER_OPENER" ]; then
    open_browser_when_ready "$BROWSER_OPENER" "$LOCAL_URL" >/dev/null 2>&1 &
    disown 2>/dev/null || true
  else
    echo "${C_DIM}[dev] sem comando para abrir o navegador — abra ${LOCAL_URL} na mão.${C_OFF}"
  fi
fi

# Volta assim que QUALQUER um dos dois sair; o trap derruba o sobrevivente.
wait -n
