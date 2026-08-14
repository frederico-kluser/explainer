/** @vitest-environment happy-dom */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

// The phone path of the mode badge, through the whole App. The desktop half
// lives in app-mode-badge.test.tsx; happy-dom's default matchMedia reports
// `matches: false`, so every mount in that file is a desktop mount and nothing
// proves the compact wiring — if `App` forgot to pass `mode` to `MobileTopBar`
// on a phone, that suite would stay green. This file forces the compact layout
// (`useCompactLayout` reads `window.matchMedia` and caches the list on first
// use, so the stub must be in place before the first render) and asserts the
// badge lands in the top bar — never in the desktop header pill, which this
// branch gates off.
//
// `App` reaches for two things this environment does not have: a WebRTC
// session and a backend. The session hook is replaced with an idle one and
// `fetch` answers the handful of endpoints the first render asks for. Nothing
// else is stubbed.

const session = vi.hoisted(() => ({ status: "idle" as "idle" | "live" }));

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
    connect: async () => {},
    disconnect: noop,
    sendText: noop,
    cancelJob: noop,
    reloadMemory: noop,
    setSpeed: noop,
  };
  return {
    ...actual,
    useRealtimeSession: () => ({ ...idle, status: session.status }),
  };
});

import { App } from "@/App";
import { resetSetupDismissed } from "@/components/SetupScreen";
import type { Conversation, ModeSummary } from "@/types";

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

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** The badge the top bar carries, scoped to the `MobileTopBar`'s header. */
function topBarBadge(): HTMLSpanElement | null {
  const header = container?.querySelector("header");
  return header?.querySelector<HTMLSpanElement>('span[title^="Modo:"]') ?? null;
}

/** Every mode badge on screen — the desktop header pill would show up here. */
function badgesOnScreen(): HTMLSpanElement[] {
  return [
    ...(container?.querySelectorAll<HTMLSpanElement>('span[title^="Modo:"]') ??
      []),
  ];
}

/**
 * The phone shell, forced. `use-compact-layout` caches the media query list at
 * module level after the first read, so every test in this file stays compact
 * even after `vi.unstubAllGlobals` — which is what the file wants.
 */
function forceCompactLayout(): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    })),
  );
}

/** The modes endpoint, for tests that need to hold it open. */
let resolveModes: ((response: Response) => void) | null = null;

function pendingModes(): Promise<Response> {
  return new Promise((resolve) => {
    resolveModes = resolve;
  });
}

function installBackend(
  mode: ModeSummary,
  conversations: Conversation[],
  modesPending = false,
): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/api/modes")) {
        return modesPending
          ? pendingModes()
          : jsonResponse({ modes: [mode], default: mode.id });
      }
      if (url.endsWith("/api/conversations")) return jsonResponse(conversations);
      if (url.endsWith("/api/provider-keys")) {
        return jsonResponse({ providers: [] });
      }
      if (url.endsWith("/settings")) {
        return jsonResponse({ voice: "alloy", speed: 1, voices: ["alloy"] });
      }
      if (url.includes("/api/sources/")) {
        return jsonResponse({ materials: [], tools: [], greeting: "" });
      }
      if (url.includes("/api/credits")) return jsonResponse({ providers: [] });
      return new Response("", { status: 404 });
    }),
  );
}

const RESEARCH_MODE: ModeSummary = {
  id: "research",
  label: "Pesquisa",
  description: "Investigue um tema com buscas na web.",
  icon: "Compass",
  requires_material: false,
  document: null,
};

const PRESENTATION_MODE: ModeSummary = {
  id: "presentation",
  label: "Criar apresentação",
  description: "Monte o roteiro slide a slide.",
  icon: "Presentation",
  requires_material: false,
  document: null,
};

function conversation(
  id: string,
  title: string,
  metadata?: { mode: string },
): Conversation {
  return {
    id,
    title,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    metadata,
  };
}

afterEach(async () => {
  session.status = "idle";
  resolveModes = null;
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  document.body.innerHTML = "";
  delete window.api;
  resetSetupDismissed();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the mode badge on the compact layout, through the whole App", () => {
  it("puts the badge in the top bar and nowhere else, with an active research conversation", async () => {
    forceCompactLayout();
    installBackend(RESEARCH_MODE, [
      conversation("research-1", "Rota de fuga", { mode: "research" }),
    ]);

    await mount(<App />);
    await settle();

    // Exactly one badge: the top bar's. The desktop header pill is gated off
    // by `!compact`, so a badge outside the header would be a regression.
    expect(badgesOnScreen()).toHaveLength(1);
    const badge = topBarBadge();
    expect(badge).not.toBeNull();
    expect(badge?.getAttribute("title")).toBe("Modo: Pesquisa");
    expect(badge?.textContent).toContain("Pesquisa");
    expect(badge?.querySelector("svg")?.getAttribute("class") ?? "").toContain(
      "lucide-compass",
    );
  });

  it("follows the active conversation's own mode from the registry", async () => {
    forceCompactLayout();
    installBackend(PRESENTATION_MODE, [
      conversation("presentation-1", "Rota de fuga", { mode: "presentation" }),
    ]);

    await mount(<App />);
    await settle();

    const badge = topBarBadge();
    expect(badge).not.toBeNull();
    expect(badge?.getAttribute("title")).toBe("Modo: Criar apresentação");
    expect(badge?.querySelector("svg")?.getAttribute("class") ?? "").toContain(
      "lucide-presentation",
    );
  });

  it("stays off screen without an active conversation", async () => {
    // No conversations, so the app opens the mode picker over a dead
    // dashboard. `activeMode` alone is not enough — it falls back to the
    // registry's first entry — so the top bar must not badge a ghost.
    forceCompactLayout();
    installBackend(RESEARCH_MODE, []);

    await mount(<App />);
    await settle();

    expect(badgesOnScreen()).toHaveLength(0);
    expect(topBarBadge()).toBeNull();
    const header = container?.querySelector("header");
    expect(header?.textContent).toContain("Explainer");
  });

  it("renders no badge while modes are still loading, then shows it when they land", async () => {
    forceCompactLayout();
    installBackend(
      RESEARCH_MODE,
      [conversation("research-1", "Rota de fuga", { mode: "research" })],
      true,
    );

    await mount(<App />);
    await settle();

    // The conversation is open but `/api/modes` has not answered: no badge
    // and no crash — `activeMode` is null until the registry lands.
    expect(topBarBadge()).toBeNull();
    expect(container?.textContent).toContain("Rota de fuga");

    await act(async () => {
      resolveModes?.(
        jsonResponse({ modes: [RESEARCH_MODE], default: "research" }),
      );
    });
    await settle();

    const badge = topBarBadge();
    expect(badge).not.toBeNull();
    expect(badge?.getAttribute("title")).toBe("Modo: Pesquisa");
  });

  it("hints the mode in the command palette rows, and omits it for a conversation without one", async () => {
    forceCompactLayout();
    installBackend(RESEARCH_MODE, [
      conversation("research-1", "Rota de fuga", { mode: "research" }),
      conversation("legacy-1", "Anotação antiga"),
    ]);

    await mount(<App />);
    await settle();

    // The palette's trigger is parked off-screen by App, but it is a real
    // button — opening through it exercises the same path a user takes.
    const trigger = [...(container?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent?.includes("Buscar conversas") ?? false,
    );
    expect(trigger).not.toBeUndefined();
    await act(async () => trigger!.click());
    await settle();

    // The dialog portals to the body; the rows live in the listbox.
    const listbox = document.body.querySelector('[role="listbox"]');
    expect(listbox).not.toBeNull();
    const rows = [...(listbox?.querySelectorAll('[role="option"]') ?? [])];

    const researchRow = rows.find((row) =>
      row.textContent?.includes("Rota de fuga"),
    );
    expect(researchRow?.textContent).toContain("Pesquisa · Atualizada");

    const legacyRow = rows.find((row) =>
      row.textContent?.includes("Anotação antiga"),
    );
    expect(legacyRow?.textContent).toContain("Atualizada");
    expect(legacyRow?.textContent).not.toContain("Pesquisa");
  });
});
