#!/usr/bin/env bash
# Sobe os dois servidores de desenvolvimento de uma vez:
#   backend  → http://localhost:3001 (tsx watch, só em loopback)
#   frontend → localhost:5173        (vite, exposto na LAN e em HTTPS quando há
#                                     certificado, com proxy /api → 3001)
#
# Ctrl+C derruba os dois. Se um morrer, o outro é derrubado junto — mas a linha
# dizendo qual caiu sai antes, senão o terminal volta ao prompt sem explicação
# nenhuma.
#
# Zero dependências novas: nada de concurrently/npm-run-all, no mesmo espírito
# de backend/src/load-env.ts.
#
# Why both ports are classified before anything is spawned:
#
#   3001 — the backend `process.exit(1)`s when the bind fails
#   (`backend/src/services/listen.ts`). What that used to produce, measured
#   against a backend left alive by `npm run dev:desktop`, is worse than an
#   exit: `tsx watch` outlives the server it ran, so the job this script owns
#   never ends. The `[fatal]` line scrolls away, `/api` keeps being proxied to
#   whatever owns 3001 — a request for `/api/health` came back as the other
#   process's HTML — and every file save reruns the bind into the same failure
#   (two `[fatal]` lines from one saved file, tsx 4.23.1). Classifying first
#   turns that into a decision: reuse the backend that already answers
#   `/api/health`, or refuse to start ours and name the port that is taken. Same
#   three states and the same criterion as `probeBackendPort` in
#   `electron/main/services/backend-process.ts`, replicated rather than imported
#   because this is shell.
#
#   5173 — Vite's default port is exactly the one a second checkout is likely to
#   be holding. An earlier version of this comment claimed that waiting for 5173
#   to accept a socket proves there is a page to land on. It proves nothing of
#   the sort, and a reviewer demonstrated it: with a stranger's server on 5173
#   the probe was satisfied on the first attempt, Vite printed "Port 5173 is in
#   use, trying another one" and moved to 5174, and the tab opened on the
#   stranger's app. An accept says the port answers, never whose page it answers
#   with. Two moves answer that: the port is proven free *here*, and
#   `frontend/vite.config.ts` sets `strictPort: true` so Vite binds the port it
#   is handed or dies loudly instead of drifting to another one. Neither closes
#   the gap between the check and the bind, so the probe further down asks the
#   port to identify itself before any tab opens.
#
# Why this script opens the browser at all instead of Vite's `server.open`: the
# escape hatches below belong to the launcher, not to the frontend package —
# `server.open` would also fire for `npm --prefix frontend run dev` and for any
# other consumer of that config, and it knows nothing about the backend.
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

C_API=$'\033[36m'   # ciano
C_WEB=$'\033[35m'   # magenta
C_WARN=$'\033[33m'  # amarelo — as linhas que pedem uma ação
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

# --- Portas ---------------------------------------------------------------

API_PORT="${PORT:-3001}"

# Classifies a port before anything is spawned: `free`, `backend-alive` (ours —
# it answers `/api/health` with `status: "ok"`, one of the two paths outside the
# key gate in `backend/src/middleware/access-key.ts`) or `occupied-by-other`.
# Without a health path the question is only free/taken.
#
# The TCP connect is what separates "free" from "taken by a stranger", which a
# lone GET cannot do: with no answer it cannot tell a server that refuses to
# reply from a port nobody is listening on.
#
# BOTH LOOPBACK STACKS ARE PROBED, and that is not thoroughness — it is the
# difference between this check working and lying. A server bound only to `::1`
# refuses every IPv4 connection, so a probe of 127.0.0.1 alone reports the port
# `free` while it is very much taken. Measured here against a real one: another
# project's Vite held `[::1]:5173`, this function said `free`, the script handed
# 5173 to our Vite, Vite binds dual-stack, hit the collision and — because
# `strictPort` is on, correctly — died, taking the whole run down with a raw
# stack trace. The checker and the binder have to mean the same thing by "the
# port", so a port is taken when *either* stack answers.
#
# This is why the rule cannot be copied from `probeBackendPort` in
# `electron/main/services/backend-process.ts`, which probes 127.0.0.1 alone and
# is right to: it only ever asks about the backend, and the backend binds
# 127.0.0.1 (`EXPLAINER_HOST`), so an IPv6-only stranger genuinely does not
# collide with it. This function also classifies the *Vite* port, and Vite runs
# with `host: true`. One function, two binders, so it answers for the stricter
# of them. The cost is a backend that moves off 3001 when only `[::1]:3001` is
# taken — over-cautious, and the app still works, which is the right direction
# to be wrong in.
#
# If `node` itself fails here the output is empty and the caller reads it as
# `free`, falling back to the old behaviour of starting the server and letting
# it complain for itself.
classify_port() {
  PROBE_PORT="$1" PROBE_HEALTH="${2:-}" node -e '
    const port = Number(process.env.PROBE_PORT);
    const health = process.env.PROBE_HEALTH || "";
    const hosts = ["127.0.0.1", "::1"];
    const timeoutMs = 600;
    (async () => {
      const { default: net } = await import("node:net");
      const accepts = (host) => new Promise((resolve) => {
        let socket;
        try {
          socket = net.connect({ host, port });
        } catch {
          // A machine with no IPv6 at all: not a listener, so not taken.
          return resolve(false);
        }
        const settle = (value) => {
          socket.removeAllListeners();
          socket.destroy();
          resolve(value);
        };
        socket.setTimeout(timeoutMs);
        socket.once("connect", () => settle(true));
        socket.once("timeout", () => settle(false));
        socket.once("error", () => settle(false));
      });

      // In parallel, so covering both stacks costs one timeout and not two.
      const answered = await Promise.all(hosts.map(accepts));
      const live = hosts.filter((_, index) => answered[index]);

      if (live.length === 0) return process.stdout.write("free");
      if (!health) return process.stdout.write("occupied-by-other");

      // Ask on whichever stack answered. Ours binds 127.0.0.1
      // (`EXPLAINER_HOST` in backend/src/index.ts), but asking only there would
      // reintroduce the blind spot on a machine that changed that.
      for (const host of live) {
        const authority = host.includes(":") ? `[${host}]` : host;
        try {
          const response = await fetch(`http://${authority}:${port}${health}`, {
            signal: AbortSignal.timeout(timeoutMs),
          });
          const body = response.ok ? await response.json() : null;
          if (body && body.status === "ok") {
            return process.stdout.write("backend-alive");
          }
        } catch {
          // Try the other stack before concluding it is a stranger.
        }
      }
      process.stdout.write("occupied-by-other");
    })();
  ' 2>/dev/null || true
}

# The frontend port is picked here rather than by Vite because this script is
# the one that prints and opens the URL: the only way that URL can be true is
# for the script to know the port before it speaks about it. 5173 first, because
# that is the number the README, the certificate and everyone's memory carry.
WEB_PORT=""
for candidate in 5173 5174 5175 5176 5177; do
  if [ "$(classify_port "$candidate")" != "occupied-by-other" ]; then
    WEB_PORT="$candidate"
    break
  fi
done

if [ -z "$WEB_PORT" ]; then
  echo "${C_WARN}[web] as portas 5173-5177 estão todas ocupadas — o frontend não tem onde subir.${C_OFF}"
  echo "${C_DIM}      Veja quem está nelas (\`ss -ltnp | grep -E ':517[3-7]'\`) e feche uma.${C_OFF}"
  exit 1
fi

if [ "$WEB_PORT" != "5173" ]; then
  echo "${C_WARN}[web] a porta 5173 está ocupada por outro processo — subindo o frontend em ${WEB_PORT}.${C_OFF}"
  echo "${C_DIM}      Quem está na 5173: \`ss -ltnp | grep :5173\` (o navegador vai abrir na ${WEB_PORT}).${C_OFF}"
fi

API_STATE="$(classify_port "$API_PORT" /api/health)"
[ -n "$API_STATE" ] || API_STATE="free"

# A stranger on the API port used to end the run's usefulness without ending the
# run: the script warned, started the frontend anyway, and every `/api` request
# was proxied into whatever owned 3001 — measured once as a request for
# `/api/health` coming back as another project's HTML. Moving is strictly better
# than warning, and the frontend can follow because the proxy target reads
# `EXPLAINER_API_PORT` (frontend/vite.config.ts).
#
# Only when the port was ours to choose. `PORT=3002 npm run dev` is a decision,
# and a script that silently overrode it would be worse than the collision.
# `backend-alive` never moves either: that is our own backend from
# `npm run dev:desktop`, and reusing it is the point.
API_MOVED_FROM=""
API_PINNED=0
[ -n "${PORT:-}" ] && API_PINNED=1

if [ "$API_STATE" = "occupied-by-other" ] && [ "$API_PINNED" = "0" ]; then
  for candidate in 3002 3003 3004 3005; do
    candidate_state="$(classify_port "$candidate" /api/health)"
    if [ "$candidate_state" = "free" ] || [ -z "$candidate_state" ]; then
      API_MOVED_FROM="$API_PORT"
      API_PORT="$candidate"
      API_STATE="free"
      break
    fi
  done
fi

# Both halves read this: the backend binds it, and Vite proxies to it.
export PORT="$API_PORT"
export EXPLAINER_API_PORT="$API_PORT"

# --- Servidores -----------------------------------------------------------

API_PID=""
WEB_PID=""
INTERRUPTED=0

cleanup() {
  trap - INT TERM EXIT
  INTERRUPTED=1
  for pid in "$API_PID" "$WEB_PID"; do
    [ -n "$pid" ] && kill -TERM "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

# The backend prints the access links and needs the port the frontend actually
# took; without this it announces 5173 even on a run that moved. A value the
# user already set wins over ours.
export EXPLAINER_PUBLIC_PORT="${EXPLAINER_PUBLIC_PORT:-$WEB_PORT}"

# `exec` dentro do subshell faz o PID capturado ser o do tsx/vite em si, e não
# o de um npm intermediário que não repassa o sinal.
case "$API_STATE" in
  backend-alive)
    echo "${C_API}[api]${C_OFF} já tem um backend nosso na porta ${API_PORT} (respondeu /api/health) — reusando, não vou subir outro."
    ;;
  occupied-by-other)
    # Two ways to land here, and telling the user the wrong one is worse than
    # saying nothing: either they pinned the port, or nothing in 3001-3005 was
    # free. Blaming a `PORT=` they never typed sends them looking for a variable
    # that does not exist.
    echo "${C_WARN}[api] a porta ${API_PORT} está ocupada por outro processo — não vou subir o backend.${C_OFF}"
    if [ "$API_PINNED" = "1" ]; then
      echo "${C_DIM}      Você fixou essa porta com PORT=${API_PORT}, então não escolhi outra por conta própria."
      echo "      Feche quem está lá (\`ss -ltnp | grep :${API_PORT}\`) ou rode sem PORT, e o dev.sh"
      echo "      acha uma livre sozinho.${C_OFF}"
    else
      echo "${C_DIM}      Procurei uma livre de 3001 a 3005 e não achei nenhuma. Feche um desses"
      echo "      servidores (\`ss -ltnp | grep -E ':300[1-5]'\`) ou escolha a porta na mão"
      echo "      (\`PORT=3010 npm run dev\`).${C_OFF}"
    fi
    echo "${C_DIM}      Assim o frontend sobe, mas tudo que passa por /api vai parar nesse outro"
    echo "      processo, não no nosso backend.${C_OFF}"
    ;;
  *)
    if [ -n "$API_MOVED_FROM" ]; then
      echo "${C_WARN}[api] a porta ${API_MOVED_FROM} é de outro processo — subindo o backend na ${API_PORT}.${C_OFF}"
      echo "${C_DIM}      O proxy do /api vai junto, então o app funciona normalmente. Quem está na"
      echo "      ${API_MOVED_FROM}: \`ss -ltnp | grep :${API_MOVED_FROM}\`.${C_OFF}"
    fi
    (cd backend && exec node_modules/.bin/tsx watch src/index.ts) \
      > >(sed -u "s/^/${C_API}[api]${C_OFF} /") 2>&1 &
    API_PID=$!
    ;;
esac

# `--port` carries the port just proven free; `strictPort` in
# frontend/vite.config.ts turns any drift into a loud error instead of a silent
# move to 5174.
(cd frontend && exec node_modules/.bin/vite --port "$WEB_PORT") \
  > >(sed -u "s/^/${C_WEB}[web]${C_OFF} /") 2>&1 &
WEB_PID=$!

# The LAN address comes from the same script that issued the certificate, so
# neither the IP discovery nor the "is there HTTPS" question is duplicated here.
# Only the port is rewritten: `scripts/dev-cert.mjs` has 5173 hard-coded and no
# way to know this run moved. A certificate covers names, not ports, so HTTPS
# still holds on whichever one we land on.
LAN_URL="$(node scripts/dev-cert.mjs --print-url 2>/dev/null || true)"
[ -n "$LAN_URL" ] || LAN_URL="http://localhost:5173"
case "$LAN_URL" in
  *:[0-9]*) LAN_URL="${LAN_URL%:*}:${WEB_PORT}" ;;
  *) LAN_URL="${LAN_URL}:${WEB_PORT}" ;;
esac
SCHEME="${LAN_URL%%://*}"
LOCAL_URL="${SCHEME}://localhost:${WEB_PORT}"

# Advertising `[api] http://localhost:3001` on a run that refused to start a
# backend is the script naming somebody else's server as ours.
if [ "$API_STATE" = "occupied-by-other" ]; then
  API_LINE="${C_WARN}[api] nenhum backend nosso — a ${API_PORT} é de outro processo${C_OFF}"
else
  API_LINE="${C_API}[api]${C_OFF} http://localhost:${API_PORT}"
fi

echo "${API_LINE}   ${C_WEB}[web]${C_OFF} ${LOCAL_URL}"
echo "${C_WEB}[web]${C_OFF} no celular (mesmo wifi): ${LAN_URL}"

# --- Navegador ------------------------------------------------------------

# The probe asks for `/@vite/client` — the HMR client every Vite dev server
# serves — and opens the tab only for a 200 whose content-type is JavaScript.
#
# An earlier revision connected a bare socket instead, on the theory that the
# port had already been proven ours. It had not: measured here, stealing the
# bind 0.28 s after the start (after the check above, before Vite's listen) left
# a stranger holding 5173, and the socket probe was satisfied by *him* — Vite
# died on `strictPort`, the script said so, and the tab still opened on the
# stranger's page. An accept says the port answers; only an answer says whose it
# is. A squatter serving its own HTML gets `text/html` here and is rejected; one
# that accepts and never replies hits the per-request timeout and is retried
# until the deadline.
#
# The PID watch is the second half: a `strictPort` failure or any other early
# death means there will never be a page. Three outcomes, and the caller says
# something out loud for the one the user cannot otherwise see: 0 ready,
# 1 deadline, 2 Vite died.
open_browser_when_ready() {
  local opener="$1" url="$2" port="$3" pid="$4"
  local status=0

  PROBE_PORT="$port" PROBE_PID="$pid" PROBE_SCHEME="${url%%://*}" node -e '
    const port = Number(process.env.PROBE_PORT);
    const vitePid = Number(process.env.PROBE_PID);
    const deadline = Date.now() + 20000;
    const aliveVite = () => {
      try {
        process.kill(vitePid, 0);
        return true;
      } catch {
        return false;
      }
    };
    (async () => {
      const { default: http } = await import("node:http");
      const { default: https } = await import("node:https");
      const client = process.env.PROBE_SCHEME === "https" ? https : http;
      const isOurs = () => new Promise((resolve) => {
        const req = client.request(
          {
            host: "127.0.0.1",
            port,
            path: "/@vite/client",
            method: "GET",
            timeout: 1000,
            // The LAN certificate is local and self-signed; validating it here
            // would only make the probe reject our own server.
            rejectUnauthorized: false,
          },
          (res) => {
            const type = String(res.headers["content-type"] || "");
            res.resume();
            resolve(res.statusCode === 200 && type.includes("javascript"));
          }
        );
        req.once("error", () => resolve(false));
        req.once("timeout", () => { req.destroy(); resolve(false); });
        req.end();
      });
      for (;;) {
        if (!aliveVite()) process.exit(2);
        if (await isOurs()) process.exit(0);
        if (!aliveVite()) process.exit(2);
        if (Date.now() >= deadline) process.exit(1);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    })();
  ' 2>/dev/null || status=$?

  if [ "$status" = "1" ]; then
    echo "${C_WARN}[dev] o frontend não respondeu na porta ${port} em 20s — abra ${url} na mão quando ele subir.${C_OFF}"
    return 0
  fi

  # status 2: Vite exited. The `wait -n` block below is what explains that, and
  # saying it here too would only double the message after a Ctrl+C.
  [ "$status" = "0" ] || return 0

  case "$opener" in
    cmd.exe) cmd.exe /c start "" "$url" >/dev/null 2>&1 || true ;;
    *) "$opener" "$url" >/dev/null 2>&1 || true ;;
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
    open_browser_when_ready "$BROWSER_OPENER" "$LOCAL_URL" "$WEB_PORT" "$WEB_PID" &
    disown 2>/dev/null || true
  else
    echo "${C_DIM}[dev] sem comando para abrir o navegador — abra ${LOCAL_URL} na mão.${C_OFF}"
  fi
fi

# Returns as soon as EITHER of them exits; the trap takes the survivor down.
# The line printed before that is the whole point: a silent `wait -n` is exactly
# how the terminal used to come back to the prompt with nothing written —
# measured by SIGKILLing Vite, where the old script printed only bash's own job
# notice and a plain non-zero exit would have printed nothing at all.
EXIT_STATUS=0
wait -n || EXIT_STATUS=$?

if [ "$INTERRUPTED" != "1" ]; then
  if [ -n "$API_PID" ] && ! kill -0 "$API_PID" 2>/dev/null; then
    echo "${C_WARN}[dev] o backend saiu (status ${EXIT_STATUS}) — derrubando o frontend junto.${C_OFF}"
  elif [ -n "$WEB_PID" ] && ! kill -0 "$WEB_PID" 2>/dev/null; then
    echo "${C_WARN}[dev] o frontend saiu (status ${EXIT_STATUS}) — derrubando o backend junto.${C_OFF}"
  else
    echo "${C_WARN}[dev] um dos servidores saiu (status ${EXIT_STATUS}) — derrubando o outro junto.${C_OFF}"
  fi
fi

exit "$EXIT_STATUS"
