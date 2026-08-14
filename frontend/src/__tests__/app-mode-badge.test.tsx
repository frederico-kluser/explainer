/** @vitest-environment happy-dom */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

// The mode badge reaches the screen through the whole App: `/api/modes` →
// `activeMode` → the header strip, and `/api/conversations` supplies the
// conversation that makes it render. Mounting the real App is what proves the
// wiring — a component test could stay green while `App` forgot to pass the
// mode.
//
// `App` reaches for two things this environment does not have: a WebRTC
// session and a backend. The session hook is replaced with an idle one — a
// test flips it to "live" to exercise the status row — and `fetch` answers the
// handful of endpoints the first render asks for. Nothing else is stubbed.

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
import { MobileTopBar } from "@/components/ui/MobileTopBar";
import { resetSetupDismissed } from "@/components/SetupScreen";
import type { Conversation, Material, ModeSummary } from "@/types";

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

function modeBadgeOnScreen(): HTMLSpanElement | null {
  const found = container?.querySelector<HTMLSpanElement>('span[title^="Modo:"]');
  return found ?? null;
}

function installBackend(mode: ModeSummary, materials: Material[] = []): void {
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
            metadata: { mode: mode.id },
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
        return jsonResponse({ materials, tools: [], greeting: "" });
      }
      if (url.includes("/api/credits")) return jsonResponse({ providers: [] });
      // Everything else — costs, memory — is absent rather than broken, which
      // is the shape those callers already handle.
      return new Response("", { status: 404 });
    }),
  );
}

/**
 * A backend whose registry holds at least two modes. `default` names the
 * *second* one on purpose: App never reads that field — the fallback rule is
 * "first of the registry", not "server default" — so a test that asserts the
 * badge shows `modes[0]` proves which rule really won.
 */
function installBackendWithModes(
  modes: [ModeSummary, ModeSummary, ...ModeSummary[]],
  conversations: Conversation[],
): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/api/modes")) {
        return jsonResponse({ modes, default: modes[1].id });
      }
      if (url.endsWith("/api/conversations")) {
        return jsonResponse(conversations);
      }
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

const PRESENTATION_MODE: ModeSummary = {
  id: "presentation",
  label: "Criar apresentação",
  description: "Monte o roteiro slide a slide.",
  icon: "Presentation",
  requires_material: false,
  document: null,
};

const MATERIAL: Material = {
  id: "m1",
  kind: "repo",
  label: "Explainer",
  primary_doc_preview: null,
  primary_doc_chars: 0,
  ephemeral: false,
  resolved_at: "2026-08-01T00:00:00.000Z",
};

const RESEARCH_MODE: ModeSummary = {
  id: "research",
  label: "Pesquisa",
  description: "Investigue um tema com buscas na web.",
  icon: "Compass",
  requires_material: false,
  document: null,
};

afterEach(async () => {
  session.status = "idle";
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

describe("the header's mode badge, through the whole App", () => {
  it("says which mode the active conversation is", async () => {
    installBackend(PRESENTATION_MODE);
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1440,
    });

    await mount(<App />);
    await settle();

    const badge = modeBadgeOnScreen();
    expect(badge).not.toBeNull();
    expect(badge?.getAttribute("title")).toBe("Modo: Criar apresentação");
    expect(badge?.textContent).toContain("Criar apresentação");
    expect(badge?.querySelector("svg")?.getAttribute("class") ?? "").toContain(
      "lucide-presentation",
    );
  });

  it("leads the status row once the call is live with materials", async () => {
    session.status = "live";
    installBackend(PRESENTATION_MODE, [MATERIAL]);
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1440,
    });

    await mount(<App />);
    await settle();

    const badge = modeBadgeOnScreen();
    expect(badge).not.toBeNull();
    // First child of the row means it leads the pill strip, not the card.
    expect(badge?.parentElement?.className).toContain("flex items-center");
    expect(container?.textContent).toContain("ao vivo");
  });

  it("stays off screen without an active conversation", async () => {
    // An empty install: the mode picker opens over a dead dashboard, and no
    // badge may claim a conversation that does not exist yet — `activeMode`
    // alone is not enough, because it falls back to the registry's first
    // entry even when nothing is open.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.endsWith("/api/modes")) {
          return jsonResponse({ modes: [PRESENTATION_MODE], default: "presentation" });
        }
        if (url.endsWith("/api/conversations")) return jsonResponse([]);
        if (url.endsWith("/api/provider-keys")) {
          return jsonResponse({ providers: [] });
        }
        return new Response("", { status: 404 });
      }),
    );

    await mount(<App />);
    await settle();

    expect(modeBadgeOnScreen()).toBeNull();
  });

  it("falls back to the first registered mode for a conversation that predates modes", async () => {
    // A conversation created before modes existed has no `metadata.mode`. The
    // server answers those with the first mode in its registry, and
    // `activeMode` mirrors that rule with `modes[0]` — but every other test
    // here registers a single mode whose id matches the conversation, so
    // `find` always wins and the fallback was dead code under test. Removing
    // it would leave this badge empty and the suite would not notice.
    installBackendWithModes(
      [PRESENTATION_MODE, RESEARCH_MODE],
      [
        {
          id: "legacy-1",
          title: "Conversa antiga",
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    );

    await mount(<App />);
    await settle();

    const badge = modeBadgeOnScreen();
    expect(badge).not.toBeNull();
    expect(badge?.getAttribute("title")).toBe("Modo: Criar apresentação");
    expect(badge?.textContent).toContain("Criar apresentação");
    expect(badge?.querySelector("svg")?.getAttribute("class") ?? "").toContain(
      "lucide-presentation",
    );
  });

  it("falls back to the first registered mode when the conversation names a mode the registry does not have", async () => {
    // A mode id that left the registry: `find` misses, and the badge must show
    // the first registered mode rather than an empty one or nothing at all.
    installBackendWithModes(
      [PRESENTATION_MODE, RESEARCH_MODE],
      [
        {
          id: "ghost-1",
          title: "Rota de fuga",
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
          metadata: { mode: "conversation" },
        },
      ],
    );

    await mount(<App />);
    await settle();

    const badge = modeBadgeOnScreen();
    expect(badge).not.toBeNull();
    expect(badge?.getAttribute("title")).toBe("Modo: Criar apresentação");
    expect(badge?.textContent).toContain("Criar apresentação");
    expect(badge?.querySelector("svg")?.getAttribute("class") ?? "").toContain(
      "lucide-presentation",
    );
  });
});

describe("MobileTopBar's mode badge", () => {
  it("renders the mode beside the title when the mode is present", async () => {
    await mount(
      <MobileTopBar
        title="Rota de fuga"
        live={false}
        connecting={false}
        sessionUsd={0}
        runningJobs={0}
        onOpenConversations={() => {}}
        onOpenPanels={() => {}}
        mode={{ icon: "Compass", label: "Pesquisa" }}
      />,
    );

    const badge = container?.querySelector<HTMLSpanElement>('span[title="Modo: Pesquisa"]');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toContain("Pesquisa");
    expect(badge?.querySelector("svg")?.getAttribute("class") ?? "").toContain(
      "lucide-compass",
    );
  });

  it("renders fine without a mode", async () => {
    await mount(
      <MobileTopBar
        title="Rota de fuga"
        live={false}
        connecting={false}
        sessionUsd={0}
        runningJobs={0}
        onOpenConversations={() => {}}
        onOpenPanels={() => {}}
      />,
    );

    expect(container?.querySelector('span[title^="Modo:"]')).toBeNull();
    expect(container?.textContent).toContain("Rota de fuga");
  });
});
