#!/usr/bin/env node
/**
 * smoke-desktop-ui.mjs — the same four assertions as `smoke:dev`, against the
 * window `npm run dev:desktop` actually opens.
 *
 * The browser smoke proves the Vite dev server serves a working app. It cannot
 * prove the desktop build does: the Electron renderer is built by a *different*
 * Vite config (`electron.vite.config.ts`), served to a *different* window, and
 * talks to a backend the main process spawns itself. Onda 1 fixed a bug that
 * lived only on this side — the renderer config had no `tailwindcss()`, so the
 * window showed unstyled text while the browser was fine. Nothing in the
 * repository would have noticed, because nothing ever opened this window.
 *
 * How it looks inside a window that has no screen:
 *   - `xvfb-run` gives Electron a real X display with no monitor attached, so
 *     the window is genuinely mapped and composited — not hidden, which is the
 *     state where a screenshot legitimately comes back blank.
 *   - `REMOTE_DEBUGGING_PORT` is read by `electron-vite`'s own dev command
 *     (`startElectron`, in its `dist/chunks`) and forwarded to Electron as
 *     `--remote-debugging-port`. That is the entire reason this smoke needs no
 *     change to `electron/` — it attaches from outside, over CDP, using Node's
 *     built-in `WebSocket`. Zero new dependencies.
 *
 * The first-run setup screen is part of this path and is treated as such: the
 * desktop build asks for an API key before the dashboard, and the smoke answers
 * it the way a user without a key does — by clicking "Pular configuração". The
 * store it reads is a throwaway `XDG_CONFIG_HOME` inside `.smoke/`, so the run
 * neither depends on nor touches the developer's real keys and conversations.
 *
 * Usage: node scripts/smoke-desktop-ui.mjs
 *
 * Knobs, all optional: `SMOKE_VERBOSE=1` echoes the app's output,
 * `SMOKE_BUDGET_MS` bounds the whole run (default 300 000), `SMOKE_READY_MS`
 * bounds the wait for the dashboard (default 90 000) and `SMOKE_CDP_PORT`
 * moves the DevTools port off 9222.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  BACKEND_PORT,
  DOM_PROBE,
  FRONTEND_PORT,
  HEALTH_PROBE,
  REPO_ROOT,
  SKIP_SETUP_SCRIPT,
  STYLE_PROBE,
  assertDom,
  assertHealth,
  assertScreenshot,
  assertStyles,
  collectOutput,
  commandExists,
  decodePng,
  heldByGroup,
  isolatedEnv,
  killGroup,
  pixelStats,
  prepareArtifactDir,
  printResults,
  sleep,
  spawnGroup,
  waitForPortsFree,
} from "./smoke-dev-browser.mjs";

/** Chromium's DevTools endpoint. Only ever bound on loopback by Electron. */
const CDP_PORT = Number(process.env.SMOKE_CDP_PORT || 9222);

// ---------------------------------------------------------------------------
// A CDP client small enough to read
// ---------------------------------------------------------------------------

/**
 * The three commands this smoke needs, over one socket.
 *
 * `Runtime.evaluate` runs the shared probes in the window's own renderer, and
 * `Page.captureScreenshot` asks the compositor for what is on screen — the same
 * two questions the browser smoke asks through `executeJavaScript` and
 * `capturePage`, which is what keeps the two screens comparable.
 */
class DevToolsClient {
  #socket;
  #nextId = 1;
  #pending = new Map();

  static async connect(webSocketUrl) {
    const client = new DevToolsClient();
    // `WebSocket` is a global since Node 22 — the reason this file needs no
    // `ws` package.
    const socket = new WebSocket(webSocketUrl);
    client.#socket = socket;
    socket.addEventListener("message", (event) => client.#receive(String(event.data)));
    await new Promise((done, fail) => {
      socket.addEventListener("open", done, { once: true });
      socket.addEventListener("error", () => fail(new Error("o CDP recusou a conexão")), {
        once: true,
      });
    });
    return client;
  }

  #receive(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    const waiter = this.#pending.get(message.id);
    if (!waiter) return; // an event, not an answer
    this.#pending.delete(message.id);
    if (message.error) waiter.fail(new Error(`${message.error.message} (${message.method})`));
    else waiter.done(message.result);
  }

  send(method, params = {}) {
    const id = this.#nextId++;
    this.#socket.send(JSON.stringify({ id, method, params }));
    return new Promise((done, fail) => {
      this.#pending.set(id, { done, fail, method });
      setTimeout(() => {
        if (this.#pending.delete(id)) fail(new Error(`${method} não respondeu em 30 s`));
      }, 30000);
    });
  }

  /** Evaluates one of the shared probes and hands back its plain value. */
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        `a expressão falhou na página: ${
          result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
        }`,
      );
    }
    return result.result?.value;
  }

  close() {
    try {
      this.#socket.close();
    } catch {
      /* already closed */
    }
  }
}

/** The renderer target, once Electron has one. DevTools pages are skipped. */
async function findRendererTarget(deadline) {
  let lastError = "nada respondeu ainda";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, {
        signal: AbortSignal.timeout(2000),
      });
      const targets = await response.json();
      const page = targets.find(
        (target) => target.type === "page" && /^https?:/.test(target.url ?? ""),
      );
      if (page?.webSocketDebuggerUrl) return page;
      lastError = `alvos vistos: ${JSON.stringify(targets.map((t) => `${t.type} ${t.url}`))}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(500);
  }
  throw new Error(`a janela do Electron não apareceu no CDP (${lastError})`);
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

async function main() {
  const dir = prepareArtifactDir("desktop-ui");
  const pngPath = join(dir, "desktop-ui.png");

  let child = null;
  let client = null;
  let failures = 0;
  let timedOut = false;
  /** The child's process group, kept for the leak check after it is gone. */
  let pgid = null;
  /** Written out in `finally`: a red run is exactly when this log is wanted. */
  let lines = [];

  const budget = setTimeout(
    () => {
      timedOut = true;
      console.error("\n[smoke] estourou o orçamento global de tempo — derrubando tudo.");
      if (child) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
      process.exit(1);
    },
    Number(process.env.SMOKE_BUDGET_MS || 300000),
  );

  try {
    console.log("[smoke] verificando que 3001, 5173 e o CDP estão livres…");
    const busy = await waitForPortsFree([BACKEND_PORT, FRONTEND_PORT, CDP_PORT], 2000);
    if (busy.length > 0) {
      throw new Error(
        `as portas ${busy.join(", ")} já estão ocupadas — pare o que está rodando ` +
          "nelas antes de rodar o smoke (ele não sabe de quem é o processo).",
      );
    }

    const hasXvfb = await commandExists("xvfb-run");
    if (!hasXvfb) {
      console.log("[smoke] xvfb-run não encontrado — a janela vai abrir no display atual.");
    }

    const env = {
      ...process.env,
      ...isolatedEnv(dir),
      // Read by electron-vite's `startElectron`; becomes
      // `--remote-debugging-port` on the Electron command line.
      REMOTE_DEBUGGING_PORT: String(CDP_PORT),
      // Same switch, same reason as the browser smoke: under Xvfb on a machine
      // whose kernel blocks unprivileged user namespaces, Chromium aborts at
      // launch. electron-vite turns this into `--no-sandbox`.
      NO_SANDBOX: "1",
    };

    const command = ["npm", "run", "dev:desktop"];
    const [file, ...args] = hasXvfb
      ? ["xvfb-run", "-a", "-s", "-screen 0 1400x1000x24", ...command]
      : command;

    console.log("[smoke] subindo `npm run dev:desktop`…");
    child = spawnGroup(file, args, {
      cwd: REPO_ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    pgid = child.pid;
    lines = collectOutput(child, "[desktop]");

    const target = await findRendererTarget(Date.now() + 120000);
    console.log(`[smoke] janela encontrada: ${target.url}`);
    client = await DevToolsClient.connect(target.webSocketDebuggerUrl);
    await client.send("Page.enable");
    await client.send("Runtime.enable");

    // The desktop build shows the first-run setup before the dashboard. Waiting
    // it out is not an option — with no saved key it waits for a human — so the
    // smoke does what a human without a key does, and clicks past it.
    const readyDeadline = Date.now() + Number(process.env.SMOKE_READY_MS || 90000);
    let dom = await client.evaluate(DOM_PROBE);
    let skipped = false;
    while (Date.now() < readyDeadline && !(dom.hasMain && dom.hasMic && dom.hasSend)) {
      if (dom.hasSkipSetup) {
        const clicked = await client.evaluate(SKIP_SETUP_SCRIPT);
        if (clicked && !skipped) {
          skipped = true;
          console.log('[smoke] tela de setup no ar — clicando em "Pular configuração".');
        }
      }
      await sleep(500);
      dom = await client.evaluate(DOM_PROBE);
    }

    const style = await client.evaluate(STYLE_PROBE);
    const health = await client.evaluate(HEALTH_PROBE);
    const shot = await client.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(pngPath, Buffer.from(shot.data, "base64"));
    const stats = pixelStats(decodePng(readFileSync(pngPath)));

    const results = [
      assertScreenshot(stats, pngPath),
      assertDom(dom),
      assertStyles(style),
      assertHealth(health),
    ];
    writeFileSync(
      join(dir, "desktop-ui-result.json"),
      JSON.stringify(
        { target: target.url, skippedSetup: skipped, dom, style, health, stats, results },
        null,
        2,
      ),
      "utf8",
    );
    if (!printResults(results, { title: `janela do desktop em ${target.url}` })) failures++;
  } catch (error) {
    console.error(`\nFALHA [smoke] ${error instanceof Error ? error.message : String(error)}`);
    failures++;
  } finally {
    client?.close();
    await killGroup(child);
    writeFileSync(join(dir, "desktop.log"), lines.join("\n"), "utf8");
    clearTimeout(budget);
  }

  if (timedOut) return;
  // The question is not "is the port free" but "did this run leave anything
  // behind" — someone else's dev server on 5173 is their business, a survivor
  // of ours is a bug. Same reasoning as the browser smoke's teardown.
  const ports = [BACKEND_PORT, FRONTEND_PORT, FRONTEND_PORT + 1, CDP_PORT];
  const deadline = Date.now() + 15000;
  let leaked = pgid ? await heldByGroup(ports, pgid) : [];
  while (leaked.length > 0 && Date.now() < deadline) {
    await sleep(300);
    leaked = await heldByGroup(ports, pgid);
  }
  if (leaked.length > 0) {
    console.error(`FALHA [smoke] o smoke deixou processos vivos nas portas: ${leaked.join(", ")}`);
    failures++;
  } else {
    console.log(`[smoke] nenhum processo deste smoke segue nas portas ${ports.join(", ")}.`);
    const strangers = await waitForPortsFree(ports, 0);
    if (strangers.length > 0) {
      console.log(`[smoke] ${strangers.join(", ")} seguem ocupadas por processos de fora.`);
    }
  }

  console.log(
    failures === 0
      ? "\n=== SMOKE DESKTOP OK ===\n"
      : `\n=== SMOKE DESKTOP FALHOU (${failures} bloco(s)) ===\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
