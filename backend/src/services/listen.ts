import type { Server } from "node:http";

/**
 * Keeping "the server started" apart from "the server never bound".
 *
 * Express 5's `app.listen(port, host, cb)` registers `cb` as the server's
 * `error` handler as well as its `listening` one — `express/lib/application.js`
 * wraps it in `once()` and calls `server.once('error', done)`. Both outcomes
 * therefore run the same callback, and this app's callback is the startup
 * banner. A port already held by another process printed
 * "Backend running on http://localhost:3001" and, because an `error` listener
 * now existed, never threw: the process stayed alive with no HTTP server, the
 * Vite proxy forwarded `/api` to whoever really owned the port, and the app
 * showed "Erro de conexão — Não foi possível carregar as conversas" against a
 * terminal that said everything was fine.
 *
 * Attaching the two events separately is what restores the distinction. Call it
 * on the server `app.listen(port, host)` returns, with no callback passed to
 * `listen` — passing one puts the alias back.
 */
export interface ListenOutcome {
  port: number;
  host: string;
  /** The bind succeeded. The startup banner belongs here. */
  onListening: () => void;
  /** The bind failed, with the message the person at the terminal needs. */
  onFailure: (message: string) => void;
}

/**
 * Why a bind failed, in words that name the next move.
 *
 * `EADDRINUSE` gets its own branch because it is the one failure a developer
 * causes by accident and can fix in one command; everything else is reported
 * with its code rather than guessed at.
 */
export function listenFailureMessage(
  err: NodeJS.ErrnoException,
  port: number,
  host: string,
): string {
  if (err.code === "EADDRINUSE") {
    return (
      `[fatal] A porta ${port} já está ocupada em ${host} — o backend não subiu. ` +
      `Veja quem está usando (\`ss -ltnp | grep :${port}\`) e feche, ` +
      `ou suba em outra porta (\`PORT=${port + 1} npm run dev\`). ` +
      `Seguir assim faria o app conversar com o servidor errado.`
    );
  }
  return `[fatal] Não foi possível escutar em ${host}:${port} — ${err.code ?? err.message}.`;
}

/** Route a server's bind result to exactly one of the two callbacks. */
export function attachListenOutcome(server: Server, outcome: ListenOutcome): void {
  server.on("listening", outcome.onListening);
  server.on("error", (err: NodeJS.ErrnoException) => {
    outcome.onFailure(listenFailureMessage(err, outcome.port, outcome.host));
  });
}
