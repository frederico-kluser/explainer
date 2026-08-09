#!/usr/bin/env node
/**
 * smoke-dev-browser.mjs — proves that `npm run dev` puts the *application* on a
 * screen, not that a port answers.
 *
 * Every check this repository had until now looked at bytes: a 200 on `/`, a
 * `<title>` in the HTML, a CSS file that exists. All of them stayed green while
 * the window showed unstyled text, because none of them ever asked a browser to
 * paint the page. This script does: it starts the real `dev.sh`, loads the real
 * URL in a real Chromium (the `electron` binary already in devDependencies —
 * zero new packages) and asks the renderer what it ended up with.
 *
 * The five assertions, and why each one exists:
 *
 *   1. A screenshot that is not a single colour. A blank or black window is the
 *      exact failure a status code cannot see. The PNG is decoded again from
 *      disk (zlib is in Node) so the number reported describes the file a human
 *      can open, not an in-memory buffer.
 *   2. The dashboard landmark is in the DOM and the setup screen's headline is
 *      not. `<main>` alone is not enough — the loading and error screens have
 *      one too — so the probe demands the two controls only the live dashboard
 *      renders: the microphone button and the send button.
 *   3. `getComputedStyle` returns compiled Tailwind values. This is the check
 *      that would have caught the bug of onda 1: the renderer was served
 *      `@tailwind utilities;` as literal source, which the browser parses and
 *      discards. Grepping the CSS for `.flex` would have passed; asking the
 *      element what its `display` is cannot.
 *   4. `GET /api/health` from *inside the page*, so the Vite `/api` proxy is
 *      part of what is proven. `curl` from the outside proves the backend only.
 *   5. `dev.sh` opens the browser exactly once, at the frontend's own port, and
 *      stays quiet under `NO_OPEN=1`.
 *
 * Mutation hooks (`--mutate=<name>`, or `SMOKE_MUTATION`): a smoke nobody has
 * seen fail is a smoke nobody should trust. `electron-bridge` puts a complete
 * `window.api` on the page before it loads, which is the shape that used to
 * strand the desktop build on the setup screen — assertion 2 must go red.
 * `raw-css` replaces every stylesheet with the uncompiled source Tailwind is
 * written in, which is what the broken build shipped — assertion 3 must go red.
 * Neither hook runs unless it is asked for by name.
 *
 * Artifacts (screenshots, logs, the fake opener) land in `.smoke/`, gitignored.
 *
 * Usage:
 *   node scripts/smoke-dev-browser.mjs
 *   node scripts/smoke-dev-browser.mjs --mutate=electron-bridge
 *
 * Knobs, all optional: `SMOKE_VERBOSE=1` echoes the servers' output,
 * `SMOKE_BUDGET_MS` bounds the whole run (default 300 000), `SMOKE_READY_MS`
 * bounds the wait for the dashboard to appear (default 40 000) and
 * `SMOKE_CHILD_BUDGET_MS` bounds the Electron half (default 120 000).
 *
 * The same file runs in three modes: as the supervisor (plain node), as the
 * Electron child it spawns (`process.versions.electron` is set), and as a
 * library of probes and helpers imported by `smoke-desktop-ui.mjs`.
 */

import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { createRequire } from "node:module";
import { inflateSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Repository root — this file lives in `scripts/`. */
export const REPO_ROOT = resolve(HERE, "..");

/** Everything this smoke writes. Gitignored; see `.gitignore`. */
export const ARTIFACT_ROOT = join(REPO_ROOT, ".smoke");

/** The two ports `dev.sh` owns. Both must be free before and after a run. */
export const BACKEND_PORT = 3001;
export const FRONTEND_PORT = 5173;

/**
 * Watched at teardown. 5174 is in the list because `frontend/vite.config.ts`
 * sets `port: 5173` without `strictPort`: with 5173 taken, Vite quietly moves
 * one over, and a teardown that only ever looked at 5173 would sign off on a
 * dev server it left running.
 */
export const WATCHED_PORTS = [BACKEND_PORT, FRONTEND_PORT, FRONTEND_PORT + 1];

// ---------------------------------------------------------------------------
// Probes — the source evaluated *in the page*.
//
// They are strings because the two smokes reach a renderer by different roads:
// `webContents.executeJavaScript` here, `Runtime.evaluate` over CDP for the
// desktop window. Keeping the source shared is what makes both screens answer
// the same questions, and the assertions below consume the same shape.
// ---------------------------------------------------------------------------

/** The setup screen's headline. Its presence means the app never appeared. */
export const SETUP_HEADLINE = "Configure sua chave da OpenAI para começar";

/**
 * Assertion 2's probe.
 *
 * The landmarks are the microphone button (`MicButton`, `aria-label` from
 * `MIC_BUTTON_LABELS.idle`) and the send button (`aria-label="Enviar"`), both
 * rendered only by the dashboard branch of `App.tsx`. The loading skeleton and
 * the "Erro de conexão" card also render a `<main>`, so `<main>` is reported
 * but never sufficient.
 */
export const DOM_PROBE = `(() => {
  const text = document.body ? document.body.innerText : "";
  const main = document.querySelector("main");
  const mic = document.querySelector('button[aria-label="Conectar e conversar"]');
  const send = document.querySelector('button[aria-label="Enviar"]');
  const skip = [...document.querySelectorAll("button")]
    .find((b) => b.textContent.trim() === "Pular configuração");
  return {
    url: location.href,
    title: document.title,
    hasMain: !!main,
    hasMic: !!mic,
    hasSend: !!send,
    hasSkipSetup: !!skip,
    setupVisible: text.includes(${JSON.stringify(SETUP_HEADLINE)}),
    connectionError: text.includes("Erro de conexão"),
    textLength: text.length,
  };
})()`;

/**
 * Assertion 3's probe.
 *
 * Three elements, chosen because the values they must compute to cannot be
 * reached by an unstyled document, and because each one needs a *different*
 * part of the Tailwind pipeline to have run:
 *
 *   - `<main class="flex min-w-0 flex-1 flex-col">` → `display: flex`,
 *     `flex-direction: column`. A bare `<main>` is `display: block`. This is
 *     the plain-utility case.
 *   - the microphone button, `MIC_BUTTON_TARGET` = `relative inline-flex
 *     size-16 items-center justify-center rounded-full` → `64px` boxes and a
 *     `rounded-full` radius. `size-16` is emitted as `calc(var(--spacing) * 16)`
 *     and `--spacing` exists only if the `@theme` block was *compiled*; served
 *     as source, the custom property is never registered and the box falls back
 *     to its intrinsic size. This is the theme-variable case.
 *     Its `display` is asserted as `flex`, not `inline-flex`, and the
 *     difference is not a mistake: the button is a flex item (its wrapper is
 *     `flex flex-col`), and CSS blockifies a flex item's display. Reading
 *     `flex` here is therefore evidence that *both* utilities landed.
 *   - the shell `<div class="dark … bg-background">` → an opaque background.
 *     `bg-background` is `var(--color-background)`, another `@theme` token; with
 *     the stylesheet uncompiled the element stays `rgba(0, 0, 0, 0)`.
 *
 * `ruleCount` and `className` are recorded for whoever reads a red run, never
 * asserted on: a stylesheet full of rules the browser refused to apply is
 * precisely the bug being hunted.
 */
export const STYLE_PROBE = `(() => {
  const read = (el) => {
    if (!el) return null;
    const s = getComputedStyle(el);
    return {
      className: typeof el.className === "string" ? el.className : String(el.className),
      display: s.display,
      flexDirection: s.flexDirection,
      width: s.width,
      height: s.height,
      borderRadius: s.borderRadius,
      backgroundColor: s.backgroundColor,
    };
  };
  let ruleCount = 0;
  for (const sheet of document.styleSheets) {
    try { ruleCount += sheet.cssRules.length; } catch { /* cross-origin */ }
  }
  return {
    main: read(document.querySelector("main")),
    mic: read(document.querySelector('button[aria-label="Conectar e conversar"]')),
    shell: read(document.querySelector("div.dark")),
    styleSheets: document.styleSheets.length,
    ruleCount,
  };
})()`;

/** Assertion 4's probe. Relative URL on purpose: it must go through the proxy. */
export const HEALTH_PROBE = `(async () => {
  try {
    const res = await fetch("/api/health", { cache: "no-store" });
    let body = null;
    try { body = await res.json(); } catch { /* not json */ }
    return { origin: location.origin, status: res.status, body };
  } catch (err) {
    return { origin: location.origin, status: 0, error: String(err) };
  }
})()`;

/** Clicks the setup screen's escape hatch, present in all of its phases. */
export const SKIP_SETUP_SCRIPT = `(() => {
  const skip = [...document.querySelectorAll("button")]
    .find((b) => b.textContent.trim() === "Pular configuração");
  if (!skip) return false;
  skip.click();
  return true;
})()`;

/**
 * Mutation `electron-bridge`: the complete preload bridge `hasSetupBridge`
 * accepts, injected before the page's own scripts run. In a browser this is a
 * lie, and the app is supposed to notice it is not a browser — which is the
 * point: with it, `App.tsx` renders `SetupScreen` and the dashboard never
 * appears.
 */
export const MUTATION_BRIDGE_SCRIPT = `
  window.api = {
    isElectron: true,
    settings: {
      get: async () => ({ success: true, data: { apiKeys: {} } }),
      set: async () => ({ success: true }),
      saveApiKey: async () => ({ success: true }),
      validateApiKey: async () => ({ success: true, data: { valid: true } }),
    },
    app: {
      openExternal: async () => ({ success: true }),
      getVersion: async () => ({ success: true, data: "0.0.0-smoke" }),
    },
  };
`;

/**
 * Mutation `raw-css`: every stylesheet in the document is replaced by the
 * *source* of `frontend/src/index.css`. That is byte-for-byte what the renderer
 * was served before onda 1 added `tailwindcss()` to the Electron config — a
 * file full of `@import "tailwindcss"`, `@theme` and `@apply` that the browser
 * parses and throws away. The DOM survives untouched, so this isolates
 * assertion 3.
 */
export function mutationRawCssScript(rawCss) {
  return `(() => {
    const raw = ${JSON.stringify(rawCss)};
    let replaced = 0;
    for (const node of document.querySelectorAll("style")) {
      node.textContent = raw;
      replaced++;
    }
    for (const node of document.querySelectorAll('link[rel="stylesheet"]')) {
      node.remove();
      replaced++;
    }
    if (replaced === 0) {
      const style = document.createElement("style");
      style.textContent = raw;
      document.head.appendChild(style);
    }
    return replaced;
  })()`;
}

/** The uncompiled Tailwind source the `raw-css` mutation injects. */
export function readRawCss() {
  return readFileSync(join(REPO_ROOT, "frontend", "src", "index.css"), "utf8");
}

// ---------------------------------------------------------------------------
// PNG: decode and measure
// ---------------------------------------------------------------------------

/**
 * A PNG decoder in ~50 lines, because the alternative was a dependency.
 *
 * Only the shape Chromium emits is supported — 8 bits per channel, no
 * interlacing — and anything else throws rather than returning a number nobody
 * should believe.
 */
export function decodePng(buffer) {
  if (buffer.length < 8 || buffer.readUInt32BE(0) !== 0x89504e47) {
    throw new Error("o arquivo capturado não é um PNG");
  }
  let offset = 8;
  let header = null;
  const idat = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += length + 12;
  }
  if (!header) throw new Error("PNG sem IHDR");
  const channelsByColorType = { 0: 1, 2: 3, 4: 2, 6: 4 };
  const channels = channelsByColorType[header.colorType];
  if (!channels || header.bitDepth !== 8 || header.interlace !== 0) {
    throw new Error(
      `PNG em formato não suportado (colorType=${header.colorType}, ` +
        `bitDepth=${header.bitDepth}, interlace=${header.interlace})`,
    );
  }

  const raw = inflateSync(Buffer.concat(idat));
  const { width, height } = header;
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let read = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[read++];
    const line = raw.subarray(read, read + stride);
    read += stride;
    const row = y * stride;
    const prev = row - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[row + x - channels] : 0;
      const b = y > 0 ? out[prev + x] : 0;
      const c = x >= channels && y > 0 ? out[prev + x - channels] : 0;
      let value = line[x];
      switch (filter) {
        case 0:
          break;
        case 1:
          value += a;
          break;
        case 2:
          value += b;
          break;
        case 3:
          value += (a + b) >> 1;
          break;
        case 4: {
          const pa = Math.abs(b - c);
          const pb = Math.abs(a - c);
          const pc = Math.abs(a + b - 2 * c);
          value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default:
          throw new Error(`filtro de linha PNG desconhecido: ${filter}`);
      }
      out[row + x] = value & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

/**
 * How much the image varies. A window that never painted answers 0 to both
 * numbers, which is exactly the failure this smoke exists to catch.
 *
 * Sampled every 4th pixel: at 1280×860 that is still ~275 000 samples, and the
 * two statistics do not move in the fourth decimal place for the price of
 * reading four times as much.
 */
export function pixelStats(image) {
  const { width, height, channels, data } = image;
  const total = width * height;
  const step = Math.max(1, Math.floor(total / 300000));
  const colors = new Set();
  let samples = 0;
  const sum = [0, 0, 0];
  const sumSq = [0, 0, 0];
  for (let index = 0; index < total; index += step) {
    const at = index * channels;
    const r = data[at];
    const g = channels >= 3 ? data[at + 1] : r;
    const b = channels >= 3 ? data[at + 2] : r;
    sum[0] += r;
    sum[1] += g;
    sum[2] += b;
    sumSq[0] += r * r;
    sumSq[1] += g * g;
    sumSq[2] += b * b;
    if (colors.size < 100000) colors.add((r << 16) | (g << 8) | b);
    samples++;
  }
  const stdDev = [0, 1, 2].map((channel) => {
    const mean = sum[channel] / samples;
    return Math.sqrt(Math.max(0, sumSq[channel] / samples - mean * mean));
  });
  return {
    width,
    height,
    samples,
    uniqueColors: colors.size,
    meanRgb: sum.map((value) => Number((value / samples).toFixed(2))),
    stdDev: stdDev.map((value) => Number(value.toFixed(3))),
    maxStdDev: Number(Math.max(...stdDev).toFixed(3)),
  };
}

/**
 * The bar a real screen clears and a blank one cannot.
 *
 * A solid fill scores `uniqueColors: 1, maxStdDev: 0`. The dashboard on a dark
 * theme — the least colourful thing this app ever shows — measured ~14 000
 * colours and a standard deviation around 20 when this was written, so the
 * thresholds sit an order of magnitude below the real value and still cannot be
 * reached by an empty window.
 */
export const MIN_UNIQUE_COLORS = 24;
export const MIN_STDDEV = 3;

// ---------------------------------------------------------------------------
// Assertions — shared by both smokes so the two screens are held to one bar
// ---------------------------------------------------------------------------

export function assertScreenshot(stats, pngPath) {
  const ok = stats.uniqueColors >= MIN_UNIQUE_COLORS && stats.maxStdDev >= MIN_STDDEV;
  return {
    ok,
    title: "captura de tela existe e não é de cor única",
    detail:
      `${pngPath} — ${stats.width}×${stats.height}, ` +
      `${stats.uniqueColors} cores distintas (mín. ${MIN_UNIQUE_COLORS}), ` +
      `desvio-padrão máx. ${stats.maxStdDev} (mín. ${MIN_STDDEV}), ` +
      `média RGB ${stats.meanRgb.join("/")}`,
  };
}

export function assertDom(dom) {
  const ok = Boolean(dom && dom.hasMain && dom.hasMic && dom.hasSend && !dom.setupVisible);
  const missing = [];
  if (!dom) missing.push("a página não respondeu");
  else {
    if (!dom.hasMain) missing.push("<main> ausente");
    if (!dom.hasMic) missing.push('botão do microfone ausente (aria-label="Conectar e conversar")');
    if (!dom.hasSend) missing.push('botão de envio ausente (aria-label="Enviar")');
    if (dom.setupVisible) missing.push(`tela de setup no ar ("${SETUP_HEADLINE}")`);
    if (dom.connectionError) missing.push('card "Erro de conexão" no ar');
  }
  return {
    ok,
    title: "o DOM é o dashboard, não a tela de setup",
    detail: ok
      ? `<main> + microfone + envio presentes; setup ausente; ${dom.textLength} caracteres de texto`
      : missing.join("; "),
  };
}

/** `rounded-full` compiles to `calc(infinity * 1px)`, which Chromium reports as
 *  a very large pixel value rather than a keyword. */
const FULL_RADIUS_MIN_PX = 1000;

export function assertStyles(style) {
  const main = style?.main;
  const mic = style?.mic;
  const shell = style?.shell;
  const problems = [];

  if (!main) problems.push("<main> não encontrado");
  else {
    if (main.display !== "flex") problems.push(`main.display = ${main.display} (esperado flex)`);
    if (main.flexDirection !== "column") {
      problems.push(`main.flex-direction = ${main.flexDirection} (esperado column)`);
    }
  }

  if (!mic) problems.push("botão do microfone não encontrado");
  else {
    // `inline-flex` blockified into `flex` — see STYLE_PROBE.
    if (mic.display !== "flex") {
      problems.push(`mic.display = ${mic.display} (esperado flex, de inline-flex blocificado)`);
    }
    if (mic.width !== "64px") problems.push(`mic.width = ${mic.width} (esperado 64px de size-16)`);
    if (mic.height !== "64px") problems.push(`mic.height = ${mic.height} (esperado 64px de size-16)`);
    if (!(parseFloat(mic.borderRadius) >= FULL_RADIUS_MIN_PX)) {
      problems.push(`mic.border-radius = ${mic.borderRadius} (esperado rounded-full)`);
    }
  }

  if (!shell) problems.push("a casca <div class='dark'> não foi encontrada");
  else if (!shell.backgroundColor || /rgba\(0, 0, 0, 0\)|transparent/.test(shell.backgroundColor)) {
    problems.push(
      `shell.background-color = ${shell.backgroundColor} (esperado a cor do token bg-background)`,
    );
  }

  return {
    ok: problems.length === 0,
    title: "o CSS do Tailwind foi compilado E aplicado pelo browser",
    detail:
      problems.length === 0
        ? `main{display:${main.display};flex-direction:${main.flexDirection}} ` +
          `mic{display:${mic.display};width:${mic.width};height:${mic.height};` +
          `border-radius:${mic.borderRadius}} ` +
          `casca{background-color:${shell.backgroundColor}} — ` +
          `${style.styleSheets} folha(s), ${style.ruleCount} regras`
        : problems.join("; "),
  };
}

export function assertHealth(health) {
  const ok = health?.status === 200 && health?.body?.status === "ok";
  return {
    ok,
    title: "GET /api/health = 200 a partir da origem da página",
    detail: ok
      ? `${health.origin}/api/health → 200 ${JSON.stringify(health.body)}`
      : `${health?.origin ?? "?"}/api/health → ${health?.status ?? "sem resposta"} ` +
        `${health?.error ?? JSON.stringify(health?.body ?? null)}`,
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/**
 * `labels` exists so the numbering a reader sees matches the numbering the task
 * uses: the browser block is assertions 1–4, and the two `dev.sh` opener checks
 * are both halves of assertion 5.
 */
export function printResults(results, { title, labels }) {
  console.log(`\n=== ${title} ===`);
  results.forEach((result, index) => {
    console.log(
      `${result.ok ? "OK  " : "FALHA"} [asserção ${labels?.[index] ?? index + 1}] ${result.title}\n` +
        `        ${result.detail}`,
    );
  });
  const failed = results.filter((result) => !result.ok).length;
  console.log(
    failed === 0
      ? `=== ${title}: ${results.length}/${results.length} asserções passaram ===\n`
      : `=== ${title}: ${failed} de ${results.length} asserções FALHARAM ===\n`,
  );
  return failed === 0;
}

// ---------------------------------------------------------------------------
// Ports and processes
// ---------------------------------------------------------------------------

/**
 * Is anything accepting connections there? A raw connect, not an HTTP request:
 * the question is whether the socket answers, and an HTTP probe would confuse
 * "nothing is listening" with "listening and unhappy". Same reasoning as
 * `electron/main/services/backend-process.ts`.
 */
export function portAccepting(port, host = "127.0.0.1", timeoutMs = 500) {
  return new Promise((done) => {
    const socket = createConnection({ port, host });
    const settle = (value) => {
      socket.removeAllListeners();
      socket.destroy();
      done(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });
}

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export async function waitForPort(port, timeoutMs, label = `porta ${port}`) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portAccepting(port)) return true;
    await sleep(200);
  }
  throw new Error(`${label} não respondeu em ${timeoutMs} ms`);
}

/** Runs a command and hands back stdout, or "" if the command is not there. */
function capture(file, args) {
  return new Promise((done) => {
    let out = "";
    let child;
    try {
      child = spawn(file, args, { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      done("");
      return;
    }
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (out += chunk));
    child.once("error", () => done(""));
    child.once("close", () => done(out));
  });
}

/** The pids listening on a port. Best effort — `ss` first, `lsof` after. */
export async function listenerPids(port) {
  const pids = new Set();
  const fromSs = await capture("ss", ["-ltnpH", `sport = :${port}`]);
  for (const match of fromSs.matchAll(/pid=(\d+)/g)) pids.add(Number(match[1]));
  if (pids.size === 0) {
    const fromLsof = await capture("lsof", ["-ti", `:${port}`, "-sTCP:LISTEN"]);
    for (const line of fromLsof.split("\n")) if (line.trim()) pids.add(Number(line.trim()));
  }
  return [...pids];
}

/** A pid's process group, which is how a child of this smoke is recognised. */
export async function pgidOf(pid) {
  const out = await capture("ps", ["-o", "pgid=", "-p", String(pid)]);
  const value = Number(out.trim());
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Which of these ports are still held *by this smoke's own process tree*.
 *
 * "The port is free" is the wrong question on a machine where someone else may
 * legitimately be running a dev server: it turns a colleague's Vite into this
 * smoke's failure, and — worse — it would let a leaked child of ours hide
 * behind the excuse. The process group answers the question that actually
 * matters, since every child here is started in its own.
 */
export async function heldByGroup(ports, pgid) {
  const held = [];
  for (const port of ports) {
    for (const pid of await listenerPids(port)) {
      if ((await pgidOf(pid)) === pgid) held.push(`${port} (pid ${pid})`);
    }
  }
  return held;
}

export async function waitForPortsFree(ports, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const busy = [];
    for (const port of ports) if (await portAccepting(port, "127.0.0.1", 300)) busy.push(port);
    if (busy.length === 0) return [];
    if (Date.now() >= deadline) return busy;
    await sleep(300);
  }
}

/**
 * Every child is started in its own process group.
 *
 * `dev.sh` is a shell that forks a `tsx` and a `vite`, and `electron-vite`
 * forks an Electron that forks a backend. Killing the pid we hold reaches the
 * parent and orphans the rest — a run that leaves 3001 held is a run that
 * poisons the next one. The group is the only handle that covers the tree.
 */
export function spawnGroup(file, args, options = {}) {
  return spawn(file, args, { detached: true, ...options });
}

export async function killGroup(child, graceMs = 5000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((done) => child.once("exit", done));
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
  const timer = sleep(graceMs).then(() => "timeout");
  if ((await Promise.race([exited.then(() => "exited"), timer])) === "timeout") {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
    await Promise.race([exited, sleep(2000)]);
  }
}

/** Strips the ANSI colours `dev.sh` prefixes every line with. */
const stripAnsi = (text) => text.replace(/\[[0-9;]*m/g, "");

/**
 * Collects a child's output while letting it through to the terminal.
 *
 * The URL Vite actually bound is read from here, and not assumed: `port: 5173`
 * in `frontend/vite.config.ts` has no `strictPort`, so an occupied port makes
 * Vite move one over and say so only in this log. Reading it is also what keeps
 * this smoke honest about HTTPS — with a LAN certificate present, `dev.sh`
 * serves the same app over TLS.
 */
export function collectOutput(child, prefix) {
  const lines = [];
  const attach = (stream) => {
    if (!stream) return;
    let buffer = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      buffer += chunk;
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const line = stripAnsi(part);
        lines.push(line);
        if (process.env.SMOKE_VERBOSE === "1") console.log(`${prefix} ${line}`);
      }
    });
  };
  attach(child.stdout);
  attach(child.stderr);
  return lines;
}

/** The `Local:` line Vite prints once it is listening. */
export function findViteUrl(lines) {
  for (const line of lines) {
    const match = line.match(/Local:\s+(https?:\/\/[^\s/]+)/);
    if (match) return match[1];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Supervisor
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url);

function parseMutation(argv) {
  const flag = argv.find((arg) => arg.startsWith("--mutate="));
  return (flag ? flag.slice("--mutate=".length) : process.env.SMOKE_MUTATION) || "none";
}

export function prepareArtifactDir(name) {
  const dir = join(ARTIFACT_ROOT, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * A throwaway home, so a smoke run cannot touch the developer's own data.
 *
 * `HOME` is the one that matters and the one that is easy to miss: the backend
 * pins `DATA_ROOT` to `resolve(homedir(), ".local", "share", "voice-assistant")`
 * in `backend/src/middleware/sandbox.ts`, frozen at module load, and it ignores
 * `XDG_DATA_HOME` entirely. Without this, every run reads the real conversation
 * store — and on a machine whose store is empty, `App.tsx` answers by creating
 * a "Nova conversa" in it. The XDG variables are set alongside because Electron
 * derives `userData` from `XDG_CONFIG_HOME`, which is where the API key would
 * otherwise be read from and written to.
 *
 * The cost is honest and worth naming: the app under test comes up with an
 * empty history, so what the screenshots show is a first launch.
 */
export function isolatedEnv(dir) {
  const home = join(dir, "home");
  for (const sub of [".local/share", ".config", ".cache"]) {
    mkdirSync(join(home, sub), { recursive: true });
  }
  return {
    HOME: home,
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
  };
}

async function runSupervisor() {
  const mutation = parseMutation(process.argv.slice(2));
  const dir = prepareArtifactDir("dev-browser");
  const env = { ...process.env, ...isolatedEnv(dir) };
  const alive = new Set();
  /** Every process group this run created, for the final leak check. */
  const groups = [];
  let timedOut = false;

  const budget = setTimeout(
    () => {
      timedOut = true;
      console.error("\n[smoke] estourou o orçamento global de tempo — derrubando tudo.");
      for (const child of alive) {
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

  /** Starts `dev.sh`, waits for both servers, and hands back a teardown. */
  const startDev = async (args, extraEnv, label) => {
    const child = spawnGroup("bash", ["dev.sh", ...args], {
      cwd: REPO_ROOT,
      env: { ...env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    alive.add(child);
    const lines = collectOutput(child, `[${label}]`);
    // A child started with `detached` leads its own group, so its pid is the
    // group id — and it stays usable after the process itself is gone.
    const pgid = child.pid;
    groups.push(pgid);
    const stop = async () => {
      await killGroup(child);
      alive.delete(child);
      writeFileSync(join(dir, `${label}.log`), lines.join("\n"), "utf8");
      const deadline = Date.now() + 15000;
      let held = await heldByGroup(WATCHED_PORTS, pgid);
      while (held.length > 0 && Date.now() < deadline) {
        await sleep(300);
        held = await heldByGroup(WATCHED_PORTS, pgid);
      }
      if (held.length > 0) {
        throw new Error(`o smoke deixou portas presas depois do teardown: ${held.join(", ")}`);
      }
      const strangers = await waitForPortsFree(WATCHED_PORTS, 0);
      if (strangers.length > 0) {
        console.log(
          `[smoke] ${strangers.join(", ")} seguem ocupadas por processos de fora deste smoke.`,
        );
      }
    };
    try {
      // The URL comes from Vite's own banner rather than from the constant:
      // without `strictPort` the server may have landed one port over, and the
      // whole point of this smoke is to look at what is really there.
      const bannerDeadline = Date.now() + 90000;
      while (!findViteUrl(lines) && Date.now() < bannerDeadline) await sleep(200);
      const url = findViteUrl(lines) ?? `http://localhost:${FRONTEND_PORT}`;
      const port = Number(new URL(url).port || FRONTEND_PORT);
      await waitForPort(port, 90000, `o frontend (${port})`);
      await waitForPort(BACKEND_PORT, 90000, `o backend (${BACKEND_PORT})`);
      return { child, lines, stop, url, port };
    } catch (error) {
      await stop();
      throw error;
    }
  };

  let failures = 0;
  try {
    console.log("[smoke] verificando que 3001 e 5173 estão livres antes de começar…");
    const busy = await waitForPortsFree([BACKEND_PORT, FRONTEND_PORT], 2000);
    if (busy.length > 0) {
      throw new Error(
        `as portas ${busy.join(", ")} já estão ocupadas — pare o que está rodando ` +
          "nelas antes de rodar o smoke (ele não sabe de quem é o processo).",
      );
    }

    // ── Fase 1: a tela ────────────────────────────────────────────────
    console.log("[smoke] subindo `bash dev.sh --no-open`…");
    const dev = await startDev(["--no-open"], {}, "dev");
    let browserOk = false;
    try {
      console.log(`[smoke] o Vite atendeu em ${dev.url} — carregando a página no Chromium…`);
      browserOk = await runBrowserChild({ url: dev.url, dir, mutation, env, alive });
    } finally {
      await dev.stop();
    }
    if (!browserOk) failures++;

    // ── Fase 2 e 3: asserção 5, o navegador que dev.sh abre ───────────
    const openerOk = await runOpenerChecks({ dir, startDev });
    if (!openerOk) failures++;
  } catch (error) {
    console.error(`\nFALHA [smoke] ${error instanceof Error ? error.message : String(error)}`);
    failures++;
  } finally {
    for (const child of alive) await killGroup(child);
    clearTimeout(budget);
  }

  if (timedOut) return;
  // Nothing this run started may still be listening. Each `stop()` above proved
  // it for its own group; this repeats the question for every group at once, so
  // a phase that threw before its teardown cannot slip through.
  const leaked = [];
  for (const pgid of groups) leaked.push(...(await heldByGroup(WATCHED_PORTS, pgid)));
  if (leaked.length > 0) {
    console.error(`FALHA [smoke] o smoke deixou processos vivos nas portas: ${leaked.join(", ")}`);
    failures++;
  } else {
    console.log(`[smoke] nenhum processo deste smoke segue nas portas ${WATCHED_PORTS.join(", ")}.`);
  }

  console.log(
    failures === 0
      ? "\n=== SMOKE DEV/BROWSER OK ===\n"
      : `\n=== SMOKE DEV/BROWSER FALHOU (${failures} bloco(s)) ===\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

/**
 * Spawns this same file under the Electron binary, which is the Chromium this
 * repository already has. Under `xvfb-run` when it exists, so the window is
 * real (a hidden window is not guaranteed to produce frames, and a screenshot
 * of a window that never composited is exactly the blank PNG being guarded
 * against) without ever appearing on the developer's desktop.
 */
async function runBrowserChild({ url, dir, mutation, env, alive }) {
  const electronBin = require("electron");
  const electronArgs = [
    // Chromium switches, before the app path: the harness runs under Xvfb with
    // no GPU and, on this distribution, no usable unprivileged user namespace.
    // The app itself makes the same call in `electron/main/index.ts`, only
    // after probing; here it is unconditional because a test runner that
    // sometimes cannot start is worse than one that never sandboxes its own
    // screenshot.
    "--no-sandbox",
    "--disable-gpu",
    fileURLToPath(import.meta.url),
  ];
  const childEnv = {
    ...env,
    SMOKE_URL: url,
    SMOKE_DIR: dir,
    SMOKE_MUTATION: mutation,
  };
  const hasXvfb = await commandExists("xvfb-run");
  const [file, args] = hasXvfb
    ? ["xvfb-run", ["-a", "-s", "-screen 0 1400x1000x24", electronBin, ...electronArgs]]
    : [electronBin, electronArgs];
  if (!hasXvfb) {
    console.log("[smoke] xvfb-run não encontrado — abrindo a janela no display atual.");
  }

  // Detached like every other child here: `xvfb-run` is a shell wrapping an
  // `Xvfb` and an `electron`, and the global timeout has to be able to reach
  // all three rather than the wrapper alone.
  const child = spawnGroup(file, args, { cwd: REPO_ROOT, env: childEnv, stdio: "inherit" });
  alive.add(child);
  try {
    const code = await new Promise((done) => child.once("exit", done));
    return code === 0;
  } finally {
    await killGroup(child, 2000);
    alive.delete(child);
  }
}

export function commandExists(name) {
  return new Promise((done) => {
    const probe = spawn("sh", ["-c", `command -v ${name}`], { stdio: "ignore" });
    probe.once("exit", (code) => done(code === 0));
    probe.once("error", () => done(false));
  });
}

/**
 * Assertion 5 — the half of `npm run dev` that has no page to inspect.
 *
 * A fake `xdg-open` first in `PATH` records what it was asked to open. `dev.sh`
 * prefers `xdg-open` over `open` and `cmd.exe`, so this is the branch a Linux
 * developer actually hits. Two runs: the default one must record exactly one
 * URL, on the port Vite really bound, and the `NO_OPEN=1` one must record
 * nothing at all.
 */
async function runOpenerChecks({ dir, startDev }) {
  const binDir = join(dir, "fakebin");
  mkdirSync(binDir, { recursive: true });
  const log = join(dir, "opened.log");
  const opener = join(binDir, "xdg-open");
  writeFileSync(
    opener,
    '#!/usr/bin/env bash\nprintf "%s\\n" "$1" >> "$SMOKE_OPEN_LOG"\n',
    "utf8",
  );
  chmodSync(opener, 0o755);
  rmSync(log, { force: true });

  const openerEnv = { PATH: `${binDir}:${process.env.PATH}`, SMOKE_OPEN_LOG: log };
  const readLog = () =>
    existsSync(log)
      ? readFileSync(log, "utf8").split("\n").map((line) => line.trim()).filter(Boolean)
      : [];

  const results = [];

  console.log("[smoke] subindo `bash dev.sh` com um xdg-open falso no PATH…");
  const withOpen = await startDev([], openerEnv, "dev-open");
  let recorded = [];
  try {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && readLog().length === 0) await sleep(250);
    recorded = readLog();
  } finally {
    await withOpen.stop();
  }
  // Compared against the port Vite actually bound, not against 5173: an opener
  // that points at a port the app is not on is the same failure as no opener.
  const expectedPort = String(withOpen.port);
  const single = recorded.length === 1;
  const rightPort = single && safeUrlPort(recorded[0]) === expectedPort;
  results.push({
    ok: single && rightPort,
    title: "`bash dev.sh` abre o navegador uma vez, na porta do frontend",
    detail: single
      ? `xdg-open recebeu ${recorded[0]} (porta ${safeUrlPort(recorded[0])}, ` +
        `o Vite subiu em ${withOpen.url})`
      : `xdg-open foi chamado ${recorded.length} vez(es): ${JSON.stringify(recorded)}`,
  });

  rmSync(log, { force: true });
  console.log("[smoke] subindo `NO_OPEN=1 bash dev.sh`…");
  const withoutOpen = await startDev([], { ...openerEnv, NO_OPEN: "1" }, "dev-noopen");
  let quiet = [];
  try {
    // `dev.sh` opens 250 ms after the port accepts; five seconds is twenty
    // times the window in which it would have happened.
    await sleep(5000);
    quiet = readLog();
  } finally {
    await withoutOpen.stop();
  }
  results.push({
    ok: quiet.length === 0,
    title: "`NO_OPEN=1 bash dev.sh` não abre nada",
    detail:
      quiet.length === 0
        ? "xdg-open não foi chamado nenhuma vez em 5 s de servidor no ar"
        : `xdg-open foi chamado: ${JSON.stringify(quiet)}`,
  });

  return printResults(results, {
    title: "asserção 5 — o navegador que dev.sh abre",
    labels: ["5a", "5b"],
  });
}

function safeUrlPort(value) {
  try {
    const url = new URL(value);
    return url.port || (url.protocol === "https:" ? "443" : "80");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Electron child — the browser half
// ---------------------------------------------------------------------------

/**
 * The Electron half, and the two rules its host imposes.
 *
 * `require("electron")` rather than `await import("electron")`: inside the main
 * process that name is a built-in module and comes back as the API, while the
 * same call in the supervisor above returns the path to the binary. It has to
 * be the synchronous form because of the second rule — nothing in this file may
 * `await` before `app.whenReady()` has a listener. Electron's ESM entrypoint is
 * evaluated around the `ready` dispatch, and a run that awaits first (a dynamic
 * `import()` is enough) reaches a `whenReady()` that never resolves and an app
 * that quits with no output at all. So the body below is registered
 * synchronously and every `await` lives inside it.
 */
function runElectronChild() {
  const { app, BrowserWindow } = require("electron");
  const url = process.env.SMOKE_URL;
  const dir = process.env.SMOKE_DIR;
  const mutation = process.env.SMOKE_MUTATION || "none";
  const pngPath = join(dir, `dev-browser${mutation === "none" ? "" : `-${mutation}`}.png`);

  // The LAN certificate `dev.sh` issues is locally trusted, and Chromium in a
  // throwaway profile has never heard of that authority. Accepted only for the
  // loopback origin this smoke started itself.
  app.on("certificate-error", (event, _contents, requestUrl, _error, _cert, callback) => {
    const host = safeUrlHost(requestUrl);
    if (host === "localhost" || host === "127.0.0.1") {
      event.preventDefault();
      callback(true);
      return;
    }
    callback(false);
  });

  // A window that never finishes loading would otherwise hold the whole run
  // hostage; the supervisor's own budget only covers what it can still reach.
  const budget = setTimeout(
    () => {
      console.error("FALHA [smoke] a janela não concluiu as asserções a tempo.");
      app.exit(1);
    },
    Number(process.env.SMOKE_CHILD_BUDGET_MS || 120000),
  );

  app.whenReady().then(() => driveWindow({ app, BrowserWindow, url, dir, mutation, pngPath, budget }));
}

async function driveWindow({ app, BrowserWindow, url, dir, mutation, pngPath, budget }) {
  let code = 1;
  try {
    const window = new BrowserWindow({
      width: 1280,
      height: 860,
      show: true,
      webPreferences: { backgroundThrottling: false },
    });

    if (mutation === "electron-bridge") {
      // `Page.addScriptToEvaluateOnNewDocument` is the only injection point
      // that is guaranteed to run before the page's own scripts — which is
      // where `App.tsx` reads `window.api`. Anything hooked to a load event
      // would be a race against React's first render.
      //
      // `about:blank` first: on a window that has never navigated there is no
      // renderer to answer, and `Page.enable` simply never settles — a hang,
      // not an error. One throwaway navigation gives the debugger something to
      // attach to, and the injected source survives the next one by design.
      await window.loadURL("about:blank");
      const debug = window.webContents.debugger;
      debug.attach("1.3");
      await debug.sendCommand("Page.enable");
      await debug.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
        source: MUTATION_BRIDGE_SCRIPT,
      });
      console.log("[smoke:mutação] window.api completo injetado antes do load.");
    }

    await window.loadURL(url);

    const evaluate = (source) => window.webContents.executeJavaScript(source, true);
    const readyDeadline = Date.now() + Number(process.env.SMOKE_READY_MS || 40000);
    let dom = await evaluate(DOM_PROBE);
    while (Date.now() < readyDeadline && !(dom.hasMain && dom.hasSend && dom.hasMic)) {
      await sleep(400);
      dom = await evaluate(DOM_PROBE);
    }

    if (mutation === "raw-css") {
      const replaced = await evaluate(mutationRawCssScript(readRawCss()));
      console.log(
        `[smoke:mutação] ${replaced} folha(s) de estilo trocadas pelo CSS-fonte não compilado.`,
      );
    }

    const style = await evaluate(STYLE_PROBE);
    const health = await evaluate(HEALTH_PROBE);
    const image = await window.webContents.capturePage();
    writeFileSync(pngPath, image.toPNG());
    const stats = pixelStats(decodePng(readFileSync(pngPath)));

    const results = [
      assertScreenshot(stats, pngPath),
      assertDom(dom),
      assertStyles(style),
      assertHealth(health),
    ];
    writeFileSync(
      join(dir, "dev-browser-result.json"),
      JSON.stringify({ url, mutation, dom, style, health, stats, results }, null, 2),
      "utf8",
    );
    code = printResults(results, { title: `navegador em ${url}` }) ? 0 : 1;
  } catch (error) {
    console.error(`FALHA [smoke] ${error instanceof Error ? error.stack : String(error)}`);
    code = 1;
  } finally {
    clearTimeout(budget);
    app.exit(code);
  }
}

function safeUrlHost(value) {
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

// `argv[1]` is not enough to know whether this file was *run*: Electron leaves
// its Chromium switches in argv, so the script path can sit anywhere after the
// binary. Scanning for it covers both hosts — and the answer has to be no when
// `smoke-desktop-ui.mjs` merely imports this module for its probes.
const selfPath = fileURLToPath(import.meta.url);
const invokedDirectly = process.argv.slice(1).some((arg) => {
  try {
    return resolve(arg) === selfPath;
  } catch {
    return false;
  }
});

if (invokedDirectly) {
  if (process.versions.electron) runElectronChild();
  else void runSupervisor();
}
