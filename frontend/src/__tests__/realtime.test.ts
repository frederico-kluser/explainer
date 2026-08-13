import { afterEach, describe, expect, it, vi } from "vitest";

import * as api from "@/lib/api";
import {
  executeToolCalls,
  failedToolOutcomes,
  foldToolOutcomes,
  type ToolOutcomeDeps,
} from "@/hooks/useRealtimeSession";
import {
  ITEM_ACK_EVENTS,
  functionCallsFrom,
  functionOutputEvent,
  userTextEvent,
} from "@/lib/realtime";

describe("functionCallsFrom", () => {
  it("pulls every function call out of a response.done payload", () => {
    const calls = functionCallsFrom({
      type: "response.done",
      response: {
        output: [
          { type: "message", content: [] },
          {
            type: "function_call",
            name: "search_source",
            call_id: "call_a",
            arguments: '{"query":"vad"}',
          },
          {
            type: "function_call",
            name: "web_search",
            call_id: "call_b",
            arguments: '{"query":"node lts"}',
          },
        ],
      },
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      name: "search_source",
      call_id: "call_a",
      arguments: '{"query":"vad"}',
    });
  });

  it("defaults missing arguments to an empty object", () => {
    const calls = functionCallsFrom({
      type: "response.done",
      response: { output: [{ type: "function_call", name: "x", call_id: "c" }] },
    });
    expect(calls[0]?.arguments).toBe("{}");
  });

  it("skips items with no name or call_id, and responses with no output", () => {
    expect(
      functionCallsFrom({
        type: "response.done",
        response: { output: [{ type: "function_call", name: "x" }] },
      }),
    ).toHaveLength(0);
    expect(functionCallsFrom({ type: "response.done" })).toHaveLength(0);
  });
});

describe("client events", () => {
  it("shapes a function_call_output the way the API expects", () => {
    expect(functionOutputEvent("call_a", "resultado")).toEqual({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: "call_a",
        output: "resultado",
      },
    });
  });

  it("shapes a typed user message as input_text", () => {
    const event = userTextEvent("oi");
    expect(event.item.content[0]).toEqual({ type: "input_text", text: "oi" });
  });
});

describe("ITEM_ACK_EVENTS", () => {
  it("accepts both the old and the new acknowledgement names", () => {
    // The name changed between API generations; gating on only one of them
    // would silently fall back to the timeout on every tool call.
    expect(ITEM_ACK_EVENTS.has("conversation.item.created")).toBe(true);
    expect(ITEM_ACK_EVENTS.has("conversation.item.added")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A tool call that dies on the wire
//
// The conversation must never stay stuck on a tool: whatever the failure — a
// fetch that rejects, a server that never answers, a batch that dies whole —
// every call of the batch gets a `function_call_output`, the spinner goes
// away, and the existing ack flow (drained acks or the timer) closes the turn.
// ---------------------------------------------------------------------------

const CONV = "550e8400-e29b-41d4-a716-446655440000";

/** A fetch that never settles until the abort signal ends it. */
function hangingFetch() {
  return vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("Aborted")));
      }),
  );
}

/** Let every pending macrotask run, so a timer armed by the fold fires. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("runTool gives up on a tool that hangs", () => {
  it("aborts the fetch and rejects naming the tool and the deadline", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("fetch", hangingFetch());

      const pending = api.runTool(CONV, {
        call_id: "call_t",
        name: "web_search",
        arguments: '{"query":"node lts"}',
      });
      // Attach the handler before the deadline fires: a rejection that happens
      // under `advanceTimersByTimeAsync` with nobody listening is flagged as
      // unhandled even though the test catches it one line later.
      const rejection = expect(pending).rejects.toThrow(/web_search/);
      const deadline = expect(pending).rejects.toThrow(/limite de tempo/);

      await vi.advanceTimersByTimeAsync(api.REALTIME_TOOL_TIMEOUT_MS + 1);

      await rejection;
      await deadline;
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});

describe("executeToolCalls under a dead network", () => {
  it("turns every failed call into a spoken output the model can answer", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));

    const outcomes = await executeToolCalls(CONV, [
      { name: "web_search", call_id: "call_1", arguments: '{"query":"x"}' },
      { name: "generate_diagram", call_id: "call_2", arguments: "{}" },
    ]);

    expect(outcomes).toHaveLength(2);
    for (const outcome of outcomes) {
      expect(outcome.output).toContain("A ferramenta falhou");
      expect(outcome.diagram).toBeNull();
    }
    expect(outcomes[0]?.call.call_id).toBe("call_1");
    expect(outcomes[1]?.call.call_id).toBe("call_2");
  });

  it("keeps the good results of a batch whose other call died", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockRejectedValueOnce(new TypeError("Failed to fetch"))
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              call_id: "call_2",
              name: "web_search",
              output: "achei",
              meta: null,
            }),
        }),
    );

    const outcomes = await executeToolCalls(CONV, [
      { name: "generate_diagram", call_id: "call_1", arguments: "{}" },
      { name: "web_search", call_id: "call_2", arguments: '{"query":"x"}' },
    ]);

    expect(outcomes[0]?.output).toContain("A ferramenta falhou");
    expect(outcomes[1]?.output).toBe("achei");
  });

  it("turns a tool that blows the deadline into a spoken timeout output", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("fetch", hangingFetch());

      const pending = executeToolCalls(CONV, [
        { name: "web_search", call_id: "call_1", arguments: '{"query":"x"}' },
      ]);

      await vi.advanceTimersByTimeAsync(api.REALTIME_TOOL_TIMEOUT_MS + 1);

      const [outcome] = await pending;
      expect(outcome?.output).toContain("web_search");
      expect(outcome?.output).toContain("excedeu o limite de tempo");
      expect(outcome?.diagram).toBeNull();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});

describe("failedToolOutcomes", () => {
  it("answers every call of a dead batch with the same spoken failure", () => {
    const outcomes = failedToolOutcomes([
      { name: "web_search", call_id: "call_1", arguments: "{}" },
      { name: "search_source", call_id: "call_2", arguments: "{}" },
    ]);

    expect(outcomes).toHaveLength(2);
    for (const outcome of outcomes) {
      expect(outcome.output).toContain("A ferramenta falhou por demora ou erro de conexao");
      expect(outcome.output).toContain("proponha tentar de novo");
      expect(outcome.diagram).toBeNull();
    }
    expect(outcomes.map((outcome) => outcome.call.call_id)).toEqual(["call_1", "call_2"]);
  });
});

describe("foldToolOutcomes", () => {
  /**
   * A stand-in for the hook: plain variables where React holds state, plus the
   * hook's ack semantics — the timer fires `flushAcks`, which drops the pending
   * set and asks for a response.
   */
  function foldHarness() {
    const pending = new Set<string>();
    const order: string[] = [];
    const sent: Array<{ call_id: string; output: string }> = [];
    const entries: string[] = [];
    let active: string | null = "tool";
    let arms = 0;
    let responses = 0;

    const deps: ToolOutcomeDeps = {
      upsertEntry: (_id, _role, mutate, _final) => {
        entries.push(mutate(""));
      },
      setDiagrams: () => {},
      addPendingAck: (callId) => {
        pending.add(callId);
        order.push(`ack:${callId}`);
      },
      send: (event) => {
        const item = (event as { item?: { call_id?: string; output?: string } }).item;
        sent.push({ call_id: item?.call_id ?? "?", output: item?.output ?? "" });
        order.push(`send:${item?.call_id}`);
      },
      setActiveTool: (name) => {
        active = name;
        order.push(`active:${name}`);
      },
      armAckTimer: () => {
        arms += 1;
        order.push("arm");
        // What the hook's timer does when it fires: `flushAcks` clears the
        // pending set and asks for a response. Fired on the next macrotask so
        // tests can wait for it with `settle`.
        setTimeout(() => {
          pending.clear();
          responses += 1;
        }, 0);
      },
    };

    return {
      deps,
      pending,
      order,
      sent,
      entries,
      active: () => active,
      arms: () => arms,
      responses: () => responses,
    };
  }

  const outcomes = (): Parameters<typeof foldToolOutcomes>[1] => [
    {
      call: { name: "web_search", call_id: "call_1", arguments: "{}" },
      output: "achei",
      diagram: null,
    },
    {
      call: { name: "generate_diagram", call_id: "call_2", arguments: "{}" },
      output: "desenhei",
      diagram: null,
    },
  ];

  it("registers each call_id in pendingAcks before sending its output", () => {
    const h = foldHarness();
    foldToolOutcomes(h.deps, outcomes());

    // ack before send, per call, in one pass — the invariant that keeps the
    // first acknowledgement from draining the pending set while later outputs
    // are still unsent.
    expect(h.order).toEqual([
      "ack:call_1",
      "send:call_1",
      "ack:call_2",
      "send:call_2",
      "active:null",
      "arm",
    ]);
    expect(h.pending).toEqual(new Set(["call_1", "call_2"]));
    expect(h.sent.map((sent) => sent.call_id)).toEqual(["call_1", "call_2"]);
    expect(h.entries).toContain("web_search — achei");
    expect(h.entries).toContain("generate_diagram — desenhei");
    expect(h.active()).toBeNull();
    expect(h.arms()).toBe(1);
  });

  it("still closes the turn when the emit loop throws mid-way", () => {
    const h = foldHarness();
    h.deps.upsertEntry = (id, _role, mutate, _final) => {
      if (id === "tool-call_2") throw new Error("boom");
      h.entries.push(mutate(""));
    };

    expect(() => foldToolOutcomes(h.deps, outcomes())).toThrow("boom");

    // The spinner is gone and the ack timer is armed anyway — the turn closes
    // with whatever output landed instead of staying stuck forever.
    expect(h.active()).toBeNull();
    expect(h.arms()).toBe(1);
    expect(h.order).toEqual(["ack:call_1", "send:call_1", "active:null", "arm"]);
  });

  it("closes the turn of a batch that failed on the wire", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
    const h = foldHarness();

    const results = await executeToolCalls(CONV, [
      { name: "web_search", call_id: "call_1", arguments: '{"query":"x"}' },
      { name: "generate_diagram", call_id: "call_2", arguments: "{}" },
    ]);
    foldToolOutcomes(h.deps, results);

    // Every call got a spoken error output, registered for acknowledgement.
    expect(h.sent.map((sent) => sent.call_id)).toEqual(["call_1", "call_2"]);
    for (const item of h.sent) {
      expect(item.output).toContain("A ferramenta falhou");
    }
    expect(h.active()).toBeNull();
    expect(h.arms()).toBe(1);

    // When the ack timer fires (or the acks drain), `flushAcks` drops the
    // pending set and asks for a response — the conversation is not stuck.
    await settle();
    expect(h.pending.size).toBe(0);
    expect(h.responses()).toBe(1);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
