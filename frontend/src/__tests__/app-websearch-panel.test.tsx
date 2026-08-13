/** @vitest-environment happy-dom */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The rail section that holds the search cards is a branch inside `App`:
//
//     jobs.length > 0 || deepThinkJobs.length > 0 || webSearchJobs.length > 0
//       ? <panel with the three card lists>
//       : ...
//
// The fold suites prove the cards' content; this file proves the panel is
// wired to the hook's `webSearchJobs` — that the list a stream fills is the
// list a card is drawn from, and that an empty one draws no card. `App`
// reaches for WebRTC and a backend, so the session hook is replaced with an
// idle one carrying a mutable `webSearchJobs`, and `fetch` answers the handful
// of endpoints the first render asks for. Nothing else about `App` is stubbed.

const state = vi.hoisted(() => ({
  webSearchJobs: [] as import("@/types").WebSearchJob[],
}));

vi.mock("@/hooks/useRealtimeSession", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/useRealtimeSession")>();
  const noop = () => {};
  const base = {
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
  return {
    ...actual,
    useRealtimeSession: () => ({ ...base, webSearchJobs: state.webSearchJobs }),
  };
});

import { App } from "@/App";
import { resetSetupDismissed } from "@/components/SetupScreen";

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

function searchCards(): Element[] {
  return [...(container?.querySelectorAll('[data-role="web-search"]') ?? [])];
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function installBackend(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/api/conversations")) {
        return jsonResponse([
          {
            id: "conv-1",
            title: "Conversa da suite",
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
      return new Response("", { status: 404 });
    }),
  );
}

function searchJob(id: string): import("@/types").WebSearchJob {
  return {
    id,
    conversation_id: "conv-1",
    query: "",
    status: "running",
    activity: "pesquisando",
    started_at: "2026-08-13T12:00:00.000Z",
  };
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
  state.webSearchJobs = [];
  resetSetupDismissed();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// The panel, mounted
// ---------------------------------------------------------------------------

describe("the rail's search cards", () => {
  it("draws no card while the hook reports no searches", async () => {
    await mount(<App />);
    await settle();

    // The app itself is on screen — this is not an empty mount.
    expect(container?.querySelector("main")).not.toBeNull();
    expect(text()).toContain("Conversa da suite");

    // The agents section does not exist at all: no card, no heading.
    expect(searchCards()).toHaveLength(0);
    expect(text()).not.toContain("Agentes");
  });

  it("opens the section on webSearchJobs alone and draws the card", async () => {
    state.webSearchJobs = [searchJob("s1")];

    await mount(<App />);
    await settle();

    expect(searchCards()).toHaveLength(1);
    expect(text()).toContain("Busca web — pesquisando");
    // The `jobs.length > 0 || deepThinkJobs.length > 0 ||` half is not
    // carrying this panel: the heading is drawn because the search list is.
    expect(text()).toContain("Agentes");
  });

  it("keys one card per search, in the hook's order", async () => {
    state.webSearchJobs = [
      searchJob("s1"),
      { ...searchJob("s2"), status: "done", activity: "concluido" },
    ];

    await mount(<App />);
    await settle();

    expect(searchCards()).toHaveLength(2);
    expect(text()).toContain("Busca web — pesquisando");
    expect(text()).toContain("Busca web — concluido");
  });

  it("hides the card again when the hook's list empties", async () => {
    state.webSearchJobs = [searchJob("s1")];
    await mount(<App />);
    await settle();
    expect(searchCards()).toHaveLength(1);

    // A new conversation's first render arrives with an empty list — the
    // hook's own conversation-switch effect resets it; App only draws it.
    state.webSearchJobs = [];
    await act(async () => {
      root!.render(<App />);
    });
    await settle();

    expect(searchCards()).toHaveLength(0);
    expect(text()).not.toContain("Agentes");
  });
});
