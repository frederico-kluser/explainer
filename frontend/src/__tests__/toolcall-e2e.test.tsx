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
// The whole tool-call loop through the real hook.
//
// The unit suite drives `executeToolCalls` and `foldToolOutcomes` directly,
// which proves each stage in isolation. This file mounts the real
// `useRealtimeSession` and lets a real `response.done` travel the entire path
// — `handleEvent` → `runToolCalls` → `executeToolCalls` → `foldToolOutcomes` →
// the data channel — with only the browser primitives faked (fetch, WebRTC,
// EventSource, microphone). A mount is what separates proving the wire-up from
// describing it: the unit tests would stay green if `response.done` stopped
// invoking `runToolCalls` altogether.
// ---------------------------------------------------------------------------

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const CONV = "550e8400-e29b-41d4-a716-446655440000";

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

/** Records what the hook sends to the model; fired by the tests as the model. */
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

function toolResponse(callId: string, output: string) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ call_id: callId, name: "web_search", output, meta: null }),
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

const deadNetwork = (_url: string) => Promise.reject(new TypeError("Failed to fetch"));

// ── Harness ───────────────────────────────────────────────────────────────

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let host: RealtimeSessionState | undefined;

function Host() {
  host = useRealtimeSession(CONV);
  return null;
}

async function mountHost(): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Host />);
  });
}

/** Let the mount's fetches and the open handler's microtasks settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await act(async () => {});
}

/** The model side of the data channel: a `response.done` and its acks. */
function fireServerEvent(event: object): void {
  const handlers = FakePeerConnection.current?.dc.handlers.get("message");
  handlers?.forEach((handler) => handler({ data: JSON.stringify(event) }));
}

function doneWithCalls(
  calls: Array<{ name: string; call_id: string; arguments: string }>,
) {
  return {
    type: "response.done",
    response: { output: calls.map((call) => ({ type: "function_call", ...call })) },
  };
}

interface SentEvent {
  type?: string;
  [key: string]: unknown;
}

function sentEvents(): SentEvent[] {
  return (FakePeerConnection.current?.dc.sent ?? []).map(
    (line) => JSON.parse(line) as SentEvent,
  );
}

function toolOutputs(sent: SentEvent[]) {
  return sent.filter(
    (event) =>
      event.type === "conversation.item.create" &&
      (event.item as { type?: string } | undefined)?.type === "function_call_output",
  );
}

function responseCreates(sent: SentEvent[]) {
  return sent.filter((event) => event.type === "response.create");
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

// ── The conversation unlocks no matter how the tool dies ──────────────────

describe("the real tool loop, end to end", () => {
  it("a dead network still sends spoken failures and frees the turn", async () => {
    vi.stubGlobal("fetch", wireFetch(deadNetwork));
    await mountHost();

    await act(async () => {
      await host!.connect();
    });
    await settle();
    // The real handshake ran: token mint, SDP exchange, data channel open.
    expect(host?.status).toBe("live");

    await act(async () => {
      fireServerEvent(
        doneWithCalls([
          { name: "web_search", call_id: "call_1", arguments: '{"query":"x"}' },
          { name: "generate_diagram", call_id: "call_2", arguments: "{}" },
        ]),
      );
    });
    await settle();

    // Every call of the dead batch got its own spoken failure output — the
    // per-call catch's sentence, since `executeToolCalls` converts each
    // rejection instead of letting the batch die whole.
    const outputs = toolOutputs(sentEvents());
    expect(outputs).toHaveLength(2);
    const byCall = (callId: string) =>
      (outputs.find((event) => (event.item as { call_id?: string })?.call_id === callId)
        ?.item as { output?: string } | undefined)?.output;
    expect(byCall("call_1")).toContain("A ferramenta falhou: Failed to fetch");
    expect(byCall("call_2")).toContain("A ferramenta falhou: Failed to fetch");

    // The spinner is off and the transcript carries both tool lines.
    expect(host?.activeTool).toBeNull();
    expect(host?.transcript.map((entry) => entry.id)).toEqual([
      "tool-call_1",
      "tool-call_2",
    ]);
    expect(host?.transcript[0]?.text).toContain("web_search — A ferramenta falhou");

    // Nothing asked for a response yet: the acks gate it.
    expect(responseCreates(sentEvents())).toHaveLength(0);

    // One ack alone must not unlock the conversation — the other call's output
    // is still unacknowledged, and the model has nothing to answer with.
    await act(async () => {
      fireServerEvent({ type: "conversation.item.added", item: { call_id: "call_1" } });
    });
    await settle();
    expect(responseCreates(sentEvents())).toHaveLength(0);

    // The escape hatch fires: the ack timer closes the turn anyway.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_600);
    });
    expect(responseCreates(sentEvents())).toHaveLength(1);
  });

  it("keeps the spinner on while a batch is still in flight", async () => {
    let hangRelease: ((err: unknown) => void) | undefined;
    const hanging = new Promise<Response>((_resolve, reject) => {
      hangRelease = reject;
    });
    vi.stubGlobal("fetch", wireFetch(() => hanging));
    await mountHost();

    await act(async () => {
      await host!.connect();
    });
    await settle();

    await act(async () => {
      fireServerEvent(
        doneWithCalls([
          { name: "web_search", call_id: "call_1", arguments: '{"query":"x"}' },
        ]),
      );
    });
    await settle();

    // The fetch has not settled, so the tool is still the active one.
    expect(host?.activeTool).toBe("web_search");

    await act(async () => {
      hangRelease?.(new TypeError("Failed to fetch"));
    });
    await settle();

    expect(host?.activeTool).toBeNull();
    expect(toolOutputs(sentEvents())).toHaveLength(1);
  });

  it("a healthy batch unlocks on the acks, before the timer", async () => {
    const queue = [toolResponse("call_1", "achei 1"), toolResponse("call_2", "achei 2")];
    vi.stubGlobal(
      "fetch",
      wireFetch((url) =>
        url === "/api/realtime/tool"
          ? queue.shift() ?? Promise.reject(new TypeError("no more tools"))
          : deadNetwork(url),
      ),
    );
    await mountHost();

    await act(async () => {
      await host!.connect();
    });
    await settle();

    await act(async () => {
      fireServerEvent(
        doneWithCalls([
          { name: "web_search", call_id: "call_1", arguments: '{"query":"x"}' },
          { name: "web_search", call_id: "call_2", arguments: '{"query":"y"}' },
        ]),
      );
    });
    await settle();

    const outputs = toolOutputs(sentEvents());
    expect(outputs).toHaveLength(2);
    expect(host?.transcript[0]?.text).toBe("web_search — achei 1");
    expect(responseCreates(sentEvents())).toHaveLength(0);

    // Both acknowledgement names are accepted; only the second drains the set.
    await act(async () => {
      fireServerEvent({ type: "conversation.item.created", item: { call_id: "call_1" } });
    });
    await settle();
    expect(responseCreates(sentEvents())).toHaveLength(0);

    await act(async () => {
      fireServerEvent({ type: "conversation.item.added", item: { call_id: "call_2" } });
    });
    await settle();
    expect(responseCreates(sentEvents())).toHaveLength(1);

    // The acks cleared the timer, so the escape hatch must not fire a second
    // response on top of the one the acks already asked for.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_600);
    });
    expect(responseCreates(sentEvents())).toHaveLength(1);
  });

  it("a second batch re-arms the ack timer instead of stacking it", async () => {
    const queue = [
      toolResponse("call_1", "achei 1"),
      toolResponse("call_2", "achei 2"),
      toolResponse("call_3", "achei 3"),
      toolResponse("call_4", "achei 4"),
    ];
    vi.stubGlobal(
      "fetch",
      wireFetch((url) =>
        url === "/api/realtime/tool"
          ? queue.shift() ?? Promise.reject(new TypeError("no more tools"))
          : deadNetwork(url),
      ),
    );
    await mountHost();

    await act(async () => {
      await host!.connect();
    });
    await settle();

    await act(async () => {
      fireServerEvent(
        doneWithCalls([
          { name: "web_search", call_id: "call_1", arguments: '{"query":"x"}' },
          { name: "web_search", call_id: "call_2", arguments: '{"query":"y"}' },
        ]),
      );
    });
    await settle();
    await act(async () => {
      fireServerEvent(
        doneWithCalls([
          { name: "web_search", call_id: "call_3", arguments: '{"query":"z"}' },
          { name: "web_search", call_id: "call_4", arguments: '{"query":"w"}' },
        ]),
      );
    });
    await settle();

    expect(toolOutputs(sentEvents())).toHaveLength(4);
    // No acks arrive; when the escape hatch fires, a stacked timer would have
    // asked for the response twice. The re-arm clears the previous one.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_600);
    });
    expect(responseCreates(sentEvents())).toHaveLength(1);
  });
});
