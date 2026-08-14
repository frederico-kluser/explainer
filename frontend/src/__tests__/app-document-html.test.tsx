/** @vitest-environment happy-dom */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

// The mode's `document.format` reaches the sandboxed frame through the whole
// App: `/api/modes` → `modeDocument` → `DocumentSidebar` → `DocumentPanel`.
// The component suites prove each step renders; this file mounts the real App
// so the wiring between them is the thing under test.
//
// `App` reaches for two things this environment does not have: a WebRTC
// session and a backend. The session hook is replaced with an idle one and
// `fetch` answers the handful of endpoints the first render asks for — the
// same substitution `app-setup-gate.test.tsx` makes. Nothing else is stubbed.

const session = vi.hoisted(() => ({ documentContent: "" }));

vi.mock("@/hooks/useRealtimeSession", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/useRealtimeSession")>();
  const noop = () => {};
  const idle = {
    status: "idle" as const,
    error: null,
    micFailure: null,
    audioBlocked: false,
    playAudio: noop,
    callDropped: false,
    transcript: [],
    userSpeaking: false,
    assistantSpeaking: false,
    activeTool: null,
    jobs: [],
    deepThinkJobs: [],
    webSearchJobs: [],
    diagrams: [],
    resumed: false,
    memoryEvents: 0,
    sessionUsd: 0,
    documentContent: null,
    setDocumentContent: noop,
    connect: async () => {},
    disconnect: noop,
    sendText: noop,
    cancelJob: noop,
    reloadMemory: noop,
    setSpeed: noop,
  };
  return {
    ...actual,
    useRealtimeSession: () => ({
      ...idle,
      documentContent: session.documentContent,
    }),
  };
});

import { App } from "@/App";
import { resetSetupDismissed } from "@/components/SetupScreen";
import type { ModeSummary } from "@/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function mount(node: ReactNode): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(node);
  });
}

/** Lets the mount's fetches resolve and React commit what they produced. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await act(async () => {});
}

function text(): string {
  return container?.textContent ?? "";
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const HTML_DOCUMENT =
  "<!doctype html><html><head><title>Pesquisa</title></head>" +
  "<body><h1>Relatorio</h1><p>Conteudo da pesquisa</p></body></html>";

function installBackend(mode: ModeSummary): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/api/modes")) {
        return jsonResponse({ modes: [mode], default: mode.id });
      }
      if (url.endsWith("/api/conversations")) {
        return jsonResponse([
          {
            id: "conv-1",
            title: "Conversa da suíte",
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z",
          },
        ]);
      }
      if (url.endsWith("/api/provider-keys")) {
        return jsonResponse({
          providers: [
            {
              provider: "openai",
              env_var: "OPENAI_API_KEY",
              present: true,
              source: "env",
              console_url: "https://platform.openai.com/api-keys",
            },
            {
              provider: "openrouter",
              env_var: "OPENROUTER_API_KEY",
              present: true,
              source: "env",
              console_url: "https://openrouter.ai/keys",
            },
            {
              provider: "deepseek",
              env_var: "DEEPSEEK_API_KEY",
              present: true,
              source: "env",
              console_url: "https://platform.deepseek.com/api_keys",
            },
          ],
        });
      }
      if (url.endsWith("/settings")) {
        return jsonResponse({ voice: "alloy", speed: 1, voices: ["alloy"] });
      }
      if (url.includes("/api/sources/")) {
        return jsonResponse({ materials: [], tools: [], greeting: "" });
      }
      if (url.includes("/api/credits")) return jsonResponse({ providers: [] });
      // Everything else — costs, memory — is absent rather than broken, which
      // is the shape those callers already handle.
      return new Response("", { status: 404 });
    }),
  );
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  session.documentContent = "";
  document.body.innerHTML = "";
  delete window.api;
  resetSetupDismissed();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the mode's document format, through the whole App", () => {
  it("renders an html mode's document in the sandboxed frame", async () => {
    session.documentContent = HTML_DOCUMENT;
    installBackend({
      id: "research",
      label: "Pesquisa",
      description: "Busque na web e monte um relatório.",
      icon: "Search",
      requires_material: false,
      document: {
        title: "Pesquisa",
        placeholder: "A pesquisa aparece aqui.",
        open_by_default: true,
        format: "html",
      },
    });
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1440,
    });

    await mount(<App />);
    await settle();

    const frame = container?.querySelector("iframe");
    expect(frame).not.toBeNull();
    const sandbox = frame!.getAttribute("sandbox") ?? "";
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-same-origin");
    expect(frame!.getAttribute("srcdoc")).toContain("Relatorio");
    // The mode's own sidebar is the one on screen, titled by the mode.
    expect(text()).toContain("Pesquisa");
  });

  it("keeps the markdown panel when the mode's format says markdown", async () => {
    session.documentContent = "# Roteiro\n\nSlides da apresentacao";
    installBackend({
      id: "presentation",
      label: "Criar apresentação",
      description: "Monte o roteiro slide a slide.",
      icon: "Presentation",
      requires_material: false,
      document: {
        title: "Roteiro",
        placeholder: "O roteiro aparece aqui.",
        open_by_default: true,
        format: "markdown",
      },
    });
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1440,
    });

    await mount(<App />);
    await settle();

    expect(container?.querySelector("iframe")).toBeNull();
    // The markdown branch rendered the content: a real heading, not a frame.
    const heading = container?.querySelector("h1");
    expect(heading?.textContent).toContain("Roteiro");
  });
});
