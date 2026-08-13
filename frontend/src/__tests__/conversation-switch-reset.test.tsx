/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  useRealtimeSession,
  type RealtimeSessionState,
} from "@/hooks/useRealtimeSession";
import { REALTIME_CALLS_URL } from "@/lib/realtime";

// ---------------------------------------------------------------------------
// The conversation switch resets the panels, through the real hook.
//
// The unit suite drives `applyWebSearchEvent` and `sessionStreamHandler` with a
// stand-in for the hook, and the panel suite mocks the hook away entirely, so
// the switch's reset effect (`setWebSearchJobs([])` and friends) was covered by
// nothing: delete the line and every suite stayed green. This file mounts the
// real `useRealtimeSession`, feeds a web search over the real job-stream path
// the hook wires (`EventSource` → `sessionStreamHandler` → `setWebSearchJobs`),
// switches the conversation id, and pins the list back to empty. A mount is
// what separates proving the wire-up from describing it.
// ---------------------------------------------------------------------------

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const CONV_A = "550e8400-e29b-41d4-a716-446655440000";
const CONV_B = "550e8400-e29b-41d4-a716-446655440001";

// ── Fakes for the browser primitives the handshake touches ────────────────

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  onmessage: ((message: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  close(): void {}
}

class FakeDataChannel {
  label = "";
  readyState = "open";
  sent: string[] = [];
  handlers = new Map<string, Set<(event: { data?: string }) => void>>();

  addEventListener(type: string, handler: (event: { data?: string }) => void): void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(handler);
    if (type === "open") queueMicrotask(() => handler({}));
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {}
}

class FakePeerConnection {
  /** The last instance the hook minted, for the tests to drive. */
  static current: FakePeerConnection | null = null;

  connectionState = "connected";
  ontrack: ((event: { streams?: unknown[] }) => void) | null = null;
  dc = new FakeDataChannel();
  private listeners = new Map<string, Set<() => void>>();

  constructor() {
    FakePeerConnection.current = this;
  }

  addEventListener(type: string, handler: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(handler);
  }

  createDataChannel(name: string): FakeDataChannel {
    this.dc.label = name;
    return this.dc;
  }

  addTrack(): void {}

  createOffer(): Promise<{ sdp: string; type: string }> {
    return Promise.resolve({ sdp: "fake-offer", type: "offer" });
  }

  setLocalDescription(): Promise<void> {
    return Promise.resolve();
  }

  setRemoteDescription(): Promise<void> {
    return Promise.resolve();
  }

  close(): void {}
}

const fakeStream = {
  getAudioTracks: () => [{ stop: () => {} }],
  getTracks: () => [],
};

// ── The fetch contract: mint, SDP exchange, then whatever the test wants ──

const TOKEN = {
  value: "tok_e2e",
  expires_at: Date.now() + 600_000,
  model: "gpt-4o-realtime-preview",
  voice: "alloy",
  speed: 1,
  materials: [],
  tools: ["web_search", "generate_diagram"],
  resumed: false,
  memory_events: 0,
  floor: null,
};

function mintResponse() {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(TOKEN),
  } as Response);
}

function sdpResponse() {
  return Promise.resolve({
    ok: true,
    status: 200,
    text: () => Promise.resolve("fake-sdp-answer"),
  } as Response);
}

/** Discriminate the handshake endpoints from everything else by URL. */
function wireFetch(toolHandler: (url: string) => Promise<Response>) {
  return vi.fn((url: string) => {
    if (url === "/api/realtime/session") return mintResponse();
    if (url === REALTIME_CALLS_URL) return sdpResponse();
    return toolHandler(url);
  });
}

// The conversation reads the switch also fires (document, transcript, memory)
// are fetch calls; rejecting them is fine, every caller swallows its errors.
const deadNetwork = (_url: string) => Promise.reject(new TypeError("Failed to fetch"));

// ── Harness ───────────────────────────────────────────────────────────────

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let host: RealtimeSessionState | undefined;

function Host({ conv }: { conv: string }) {
  host = useRealtimeSession(conv);
  return null;
}

async function mountHost(conv: string): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Host conv={conv} />);
  });
}

/** Re-render the same mount under a different conversation id. */
async function switchConversation(conv: string): Promise<void> {
  await act(async () => {
    root!.render(<Host conv={conv} />);
  });
}

/** Let the mount's fetches and the open handler's microtasks settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await act(async () => {});
}

/**
 * The stream side of the job stream: a `web_search_activity` frame.
 *
 * The hook opens two EventSources — the conversation's `/live` stream and the
 * agent job stream — so the one that folds web search events is matched by its
 * URL rather than by position.
 */
function feedWebSearch(jobId: string, activity: string): void {
  const source = FakeEventSource.instances.find((instance) =>
    instance.url.startsWith("/api/agents/events"),
  );
  source?.onmessage?.({
    data: JSON.stringify({
      type: "web_search_activity",
      job_id: jobId,
      activity,
    }),
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
  // The hook refuses to start on an insecure context, and happy-dom is not
  // one — lend it the secure context the page would have in production.
  Object.defineProperty(window, "isSecureContext", {
    configurable: true,
    value: true,
  });
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => fakeStream) },
  });
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
  host = undefined;
  FakePeerConnection.current = null;
  FakeEventSource.instances = [];
  delete (window as { isSecureContext?: unknown }).isSecureContext;
  delete (navigator as { mediaDevices?: unknown }).mediaDevices;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ── The conversation switch drops what the left conversation left behind ──

describe("the conversation switch, through the real hook", () => {
  it("empties the web search jobs of the conversation that was just left", async () => {
    vi.stubGlobal("fetch", wireFetch(deadNetwork));
    await mountHost(CONV_A);

    await act(async () => {
      await host!.connect();
    });
    await settle();
    // The real handshake ran: token mint, SDP exchange, data channel open.
    expect(host?.status).toBe("live");

    // A web search reported over the job stream lands on the panel, attributed
    // to the conversation the call was opened for.
    await act(async () => {
      feedWebSearch("ws_1", "pesquisando");
    });
    await settle();
    expect(host?.webSearchJobs).toHaveLength(1);
    expect(host?.webSearchJobs[0]?.conversation_id).toBe(CONV_A);

    // Switching conversations re-runs the reset effect, which drops the card
    // from the panel the same way it drops the transcript and the agent jobs.
    await switchConversation(CONV_B);
    await settle();
    expect(host?.webSearchJobs).toEqual([]);
  });
});
