import { describe, it, expect } from "vitest";
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
