/** @vitest-environment happy-dom */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The one line that can hide the whole application is `App`'s own:
//
//     if (showSetup) return <SetupScreen onComplete={completeSetup} />;
//
// `setup-gate.test.tsx` proves the rule and the screen; neither of them mounts
// that line. So a suite could stay green while the branch was inverted — the
// browser gets the desktop's key form and the desktop gets a window it cannot
// leave — or replaced by `return null`, which is the blank screen this whole
// gate exists to make impossible. This file mounts the real `App` and asserts
// both directions, because a gate is a direction and nothing else.
//
// `App` reaches for two things this environment does not have: a WebRTC session
// and a backend. The session hook is replaced with an idle one — it opens a
// peer connection and an `EventSource`, neither of which exists here — and
// `fetch` answers the handful of endpoints the first render asks for. Nothing
// else about `App` is stubbed: the gate under test is the real one.

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
    diagrams: [],
    resumed: false,
    memoryEvents: 0,
    sessionUsd: 0,
    connect: async () => {},
    disconnect: noop,
    sendText: noop,
    cancelJob: noop,
    reloadMemory: noop,
    setSpeed: noop,
  };
  return { ...actual, useRealtimeSession: () => idle };
});

import { App } from "@/App";
import { markSetupDismissed, resetSetupDismissed } from "@/components/SetupScreen";
import type { ExplainerElectronApi } from "@/types/electron";

// ---------------------------------------------------------------------------
// Harness — the same one `setup-gate.test.tsx` uses: React 19 through `act`.
// ---------------------------------------------------------------------------

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

function buttonLabelled(label: string): HTMLButtonElement {
  const found = [...(container?.querySelectorAll("button") ?? [])].find(
    (button) => button.textContent?.trim() === label,
  );
  if (!found) throw new Error(`no button labelled "${label}" on screen`);
  return found as HTMLButtonElement;
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

// ---------------------------------------------------------------------------
// What is on screen — one marker per side, and neither can be the other
// ---------------------------------------------------------------------------

const CONVERSATION_TITLE = "Conversa da suíte";

/** The setup screen, in either of the two states its first render can reach. */
function setupIsOnScreen(): boolean {
  return (
    text().includes("Bem-vindo ao Explainer") ||
    text().includes("Verificando as configurações")
  );
}

/** The application shell: the conversation the backend stub served. */
function appIsOnScreen(): boolean {
  return (
    container?.querySelector("main") !== null &&
    text().includes(CONVERSATION_TITLE)
  );
}

// ---------------------------------------------------------------------------
// The backend, reduced to what a first render asks it
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function installBackend(options: { keysMissing?: boolean } = {}): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/api/conversations")) {
        return jsonResponse([
          {
            id: "conv-1",
            title: CONVERSATION_TITLE,
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z",
          },
        ]);
      }
      // `App` mounts `ProviderKeysPrompt`, which asks this endpoint on mount.
      // Present by default so the gate cases stay about the gate; the keys-
      // missing case is the one that asserts the reminder card.
      if (url.endsWith("/api/provider-keys")) {
        return jsonResponse({
          providers: [
            {
              provider: "openai",
              env_var: "OPENAI_API_KEY",
              present: !options.keysMissing,
              source: options.keysMissing ? null : "env",
              console_url: "https://platform.openai.com/api-keys",
            },
            {
              provider: "openrouter",
              env_var: "OPENROUTER_API_KEY",
              present: !options.keysMissing,
              source: options.keysMissing ? null : "env",
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

function installBridge(): ExplainerElectronApi {
  const api: ExplainerElectronApi = {
    isElectron: true,
    app: {
      platform: "linux",
      openExternal: vi.fn(async () => ({ success: true })),
    },
    settings: {
      get: vi.fn(async () => ({
        success: true,
        data: {
          version: 1,
          apiKeys: {
            openai: { key: "", validationStatus: "idle" as const },
            openaiAdmin: { key: "", validationStatus: "idle" as const },
          },
          language: "pt-BR" as const,
          theme: "dark" as const,
          updatedAt: 0,
        },
      })),
      saveApiKey: vi.fn(async () => ({ success: true })),
      removeApiKey: vi.fn(async () => ({ success: true })),
      validateApiKey: vi.fn(async () => ({
        success: true,
        data: { valid: true },
      })),
      set: vi.fn(async () => ({ success: true })),
    },
  };
  window.api = api;
  return api;
}

beforeEach(() => {
  installBackend();
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  delete window.api;
  resetSetupDismissed();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// The gate, mounted
// ---------------------------------------------------------------------------

describe("App's first-launch gate", () => {
  it("puts the setup in front of the app inside Electron", async () => {
    installBridge();

    await mount(<App />);
    await settle();

    expect(setupIsOnScreen()).toBe(true);
    expect(appIsOnScreen()).toBe(false);
  });

  it("puts the app in front of the browser, and never the setup", async () => {
    // No `window.api` at all — the browser build. It has no key store, so the
    // screen has nothing to ask for and must never appear.
    await mount(<App />);
    await settle();

    expect(appIsOnScreen()).toBe(true);
    expect(setupIsOnScreen()).toBe(false);
  });

  it("reminds the browser user about missing keys without blocking the app", async () => {
    // The whole point of the web prompt: it is a reminder, not a gate. The
    // dashboard must be on screen WITH the card — a prompt that replaced the
    // dashboard would be the setup gate in disguise, and the smoke's
    // assertion 2 exists to catch exactly that.
    installBackend({ keysMissing: true });

    await mount(<App />);
    await settle();

    expect(appIsOnScreen()).toBe(true);
    expect(setupIsOnScreen()).toBe(false);
    expect(text()).toContain("Faltam as chaves de API");
  });

  it("opens the app when the answer is already remembered", async () => {
    // A remount inside the same window — a hot reload, a parent re-key — must
    // not re-ask a question the user answered a second ago.
    installBridge();
    markSetupDismissed();

    await mount(<App />);
    await settle();

    expect(appIsOnScreen()).toBe(true);
    expect(setupIsOnScreen()).toBe(false);
  });

  it("hands the app over when the setup is skipped", async () => {
    // The whole chain in one case: the screen's skip link, `onComplete`, the
    // state `App` keeps, and the gate re-deciding with it.
    installBridge();

    await mount(<App />);
    await settle();
    expect(setupIsOnScreen()).toBe(true);

    await click(buttonLabelled("Pular configuração"));
    await settle();

    expect(appIsOnScreen()).toBe(true);
    expect(setupIsOnScreen()).toBe(false);
  });
});
