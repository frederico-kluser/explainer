import { describe, it, expect, afterEach, vi } from "vitest";

import {
  applyWebSearchEvent,
  isReplay,
  isWebSearchEvent,
  sessionStreamHandler,
  type SessionStreamDeps,
} from "@/hooks/useRealtimeSession";
import { userTextEvent } from "@/lib/realtime";
import type { AgentJob, DeepThinkJob, TranscriptEntry, WebSearchJob } from "@/types";

// The suite has no jsdom, so a React hook cannot be rendered here. Everything
// the hook decides therefore lives in the exported functions below, and the hook
// is the wiring that hands them `setWebSearchJobs`/`send`. These tests drive
// those functions with the same folds React would apply, so what passes here is
// what runs in the browser.

const CONV = "550e8400-e29b-41d4-a716-446655440000";
const AT = "2026-08-13T12:00:00.000Z";

const RESULT =
  "O preco do modelo gpt-4o e de 2.50 dolares por milhao de tokens de entrada.";

afterEach(() => {
  vi.unstubAllGlobals();
});

interface Recorded {
  deps: SessionStreamDeps;
  jobs: () => AgentJob[];
  webSearchJobs: () => WebSearchJob[];
  sent: object[];
  entries: Array<{ id: string; role: TranscriptEntry["role"]; text: string; final?: boolean }>;
  persisted: Array<{ id: string; role: string; content: string }>;
  responses: () => number;
}

/** A stand-in for the hook: plain variables where React would hold state. */
function record(): Recorded {
  let jobs: AgentJob[] = [];
  let deepThinkJobs: DeepThinkJob[] = [];
  let webSearchJobs: WebSearchJob[] = [];
  let responses = 0;
  const sent: object[] = [];
  const entries: Recorded["entries"] = [];
  const persisted: Recorded["persisted"] = [];

  const deps: SessionStreamDeps = {
    conversationId: CONV,
    setJobs: (update) => {
      jobs = update(jobs);
    },
    setDeepThinkJobs: (update) => {
      deepThinkJobs = update(deepThinkJobs);
    },
    setWebSearchJobs: (update) => {
      webSearchJobs = update(webSearchJobs);
    },
    upsertEntry: (id, role, mutate, final) => {
      entries.push({ id, role, text: mutate(""), final });
    },
    persist: (id, role, content) => {
      persisted.push({ id, role, content });
    },
    send: (event) => {
      sent.push(event);
    },
    requestResponse: () => {
      responses += 1;
    },
  };

  return {
    deps,
    jobs: () => jobs,
    webSearchJobs: () => webSearchJobs,
    sent,
    entries,
    persisted,
    responses: () => responses,
  };
}

// ---------------------------------------------------------------------------
// A web_search event never becomes a failed agent job
// ---------------------------------------------------------------------------

describe("a web_search event never becomes a failed agent job", () => {
  it("routes by discriminant instead of falling into the error branch", () => {
    expect(
      isWebSearchEvent({ type: "web_search_activity", job_id: "j", activity: "pesquisando" }),
    ).toBe(true);
    expect(isWebSearchEvent({ type: "web_search_done", job_id: "j", result: "r" })).toBe(true);
    expect(isWebSearchEvent({ type: "web_search_error", job_id: "j", error: "x" })).toBe(true);
    expect(isWebSearchEvent({ type: "done", job_id: "j", result: "r" })).toBe(false);
    expect(isWebSearchEvent({ type: "activity", job_id: "j", activity: "a" })).toBe(false);
    expect(isWebSearchEvent({ type: "deep_think_done", job_id: "j", synthesis: "", thinkers: [] })).toBe(
      false,
    );
  });

  it("creates no phantom pi job card when a search finishes", () => {
    const harness = record();
    const handle = sessionStreamHandler(harness.deps);

    handle(
      JSON.stringify({
        type: "web_search_done",
        job_id: "search_1",
        result: RESULT,
        cost_usd: 0.02,
      }),
    );

    // The old stub produced exactly this shape of bug: the event fell through to
    // the agent fold and opened a card with status "error" and no error in it.
    expect(harness.jobs()).toEqual([]);

    const search = harness.webSearchJobs()[0];
    expect(search?.status).toBe("done");
    expect(search?.error).toBeUndefined();
    expect(search?.result).toBe(RESULT);
    expect(search?.cost_usd).toBe(0.02);
  });

  it("ignores an event type it does not know rather than inventing a job", () => {
    const harness = record();
    const handle = sessionStreamHandler(harness.deps);

    handle(JSON.stringify({ type: "web_search_summarized", job_id: "x", summary: "o" }));
    handle("not json at all");

    expect(harness.jobs()).toEqual([]);
    expect(harness.webSearchJobs()).toEqual([]);
    expect(harness.sent).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A frame with no job in it
// ---------------------------------------------------------------------------

describe("an event that names no job", () => {
  it("is dropped instead of opening a card and making the model speak", () => {
    const harness = record();
    sessionStreamHandler(harness.deps)(
      JSON.stringify({ type: "web_search_done", result: RESULT }),
    );

    expect(harness.webSearchJobs()).toEqual([]);
    expect(harness.entries).toEqual([]);
    expect(harness.sent).toEqual([]);
    expect(harness.responses()).toBe(0);
    expect(harness.persisted).toEqual([]);
  });

  it("refuses an empty job_id too — it would key every card to the same card", () => {
    const harness = record();
    sessionStreamHandler(harness.deps)(
      JSON.stringify({ type: "web_search_done", job_id: "", result: RESULT }),
    );

    expect(harness.webSearchJobs()).toEqual([]);
    expect(harness.sent).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The replay rule
// ---------------------------------------------------------------------------

describe("the replay rule", () => {
  it("injects the result and asks for a response when the search just finished", () => {
    const harness = record();
    const handle = sessionStreamHandler(harness.deps);

    handle(
      JSON.stringify({ type: "web_search_done", job_id: "search_1", result: RESULT }),
    );

    expect(harness.sent).toHaveLength(1);
    expect(JSON.stringify(harness.sent[0])).toContain(RESULT);
    expect(JSON.stringify(harness.sent[0])).toContain("Explique isso para mim em voz alta");
    expect(harness.responses()).toBe(1);

    // The `[busca web]` marker is what the research context of later searches
    // reads back — this is the half that keeps the user's own request coherent.
    expect(harness.persisted[0]?.content).toBe(`[busca web] ${RESULT}`);
    expect(harness.persisted[0]?.role).toBe("tool");
  });

  it("renders but stays silent when the same event carries replay: true", () => {
    const harness = record();
    const handle = sessionStreamHandler(harness.deps);

    handle(
      JSON.stringify({
        type: "web_search_done",
        job_id: "search_1",
        result: RESULT,
        replay: true,
      }),
    );

    // Rendered: the card and the transcript line are both there.
    expect(harness.webSearchJobs()[0]?.result).toBe(RESULT);
    expect(harness.entries.map((entry) => entry.text)).toContain(RESULT);

    // Not spoken: no conversation item, no response.create, nothing persisted.
    // A reconnect must not make the model narrate — and bill for — a search
    // from an hour ago.
    expect(harness.sent).toEqual([]);
    expect(harness.responses()).toBe(0);
    expect(harness.persisted).toEqual([]);
  });

  it("applies the same rule to a failed search", () => {
    const live = record();
    sessionStreamHandler(live.deps)(
      JSON.stringify({ type: "web_search_error", job_id: "s", error: "sem credito" }),
    );
    expect(live.sent).toHaveLength(1);
    expect(live.responses()).toBe(1);

    const replayed = record();
    sessionStreamHandler(replayed.deps)(
      JSON.stringify({
        type: "web_search_error",
        job_id: "s",
        error: "sem credito",
        replay: true,
      }),
    );
    expect(replayed.webSearchJobs()[0]?.status).toBe("error");
    expect(replayed.sent).toEqual([]);
    expect(replayed.responses()).toBe(0);
  });

  it("never treats an activity event as replayable — it carries no such flag", () => {
    expect(isReplay({ type: "web_search_activity", job_id: "j", activity: "pesquisando" })).toBe(
      false,
    );
    expect(isReplay({ type: "web_search_done", job_id: "j", result: "r" })).toBe(false);
    expect(
      isReplay({ type: "web_search_done", job_id: "j", result: "r", replay: true }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

describe("web_search_activity", () => {
  it("updates the card and says nothing out loud", () => {
    const harness = record();
    const handle = sessionStreamHandler(harness.deps);

    handle(
      JSON.stringify({
        type: "web_search_activity",
        job_id: "search_1",
        activity: "3 resultados encontrados",
      }),
    );

    const search = harness.webSearchJobs()[0];
    expect(search?.activity).toBe("3 resultados encontrados");
    expect(search?.status).toBe("running");

    expect(harness.sent).toEqual([]);
    expect(harness.responses()).toBe(0);
    expect(harness.entries).toEqual([]);
    expect(harness.persisted).toEqual([]);
  });

  it("keeps folding into the same card, then closes it", () => {
    const harness = record();
    const handle = sessionStreamHandler(harness.deps);

    handle(
      JSON.stringify({
        type: "web_search_activity",
        job_id: "search_1",
        activity: "buscando",
      }),
    );
    handle(
      JSON.stringify({
        type: "web_search_activity",
        job_id: "search_1",
        activity: "formatando a resposta",
      }),
    );
    handle(JSON.stringify({ type: "web_search_done", job_id: "search_1", result: RESULT }));

    expect(harness.webSearchJobs()).toHaveLength(1);
    expect(harness.webSearchJobs()[0]?.status).toBe("done");
    expect(harness.webSearchJobs()[0]?.started_at).toBeTruthy();
    expect(harness.sent).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// A search ends exactly once
// ---------------------------------------------------------------------------

describe("a search ends exactly once", () => {
  it("does not let a late activity drag a finished search back to running", () => {
    const harness = record();
    const handle = sessionStreamHandler(harness.deps);

    handle(JSON.stringify({ type: "web_search_done", job_id: "s", result: RESULT }));
    handle(
      JSON.stringify({ type: "web_search_activity", job_id: "s", activity: "ainda buscando" }),
    );

    const search = harness.webSearchJobs()[0];
    expect(search?.status).toBe("done");
    expect(search?.activity).toBe("concluido");
    expect(search?.result).toBe(RESULT);
    expect(harness.sent).toHaveLength(1);
    expect(harness.responses()).toBe(1);
  });

  it("does not inject a finished search twice", () => {
    const harness = record();
    const handle = sessionStreamHandler(harness.deps);

    handle(JSON.stringify({ type: "web_search_done", job_id: "s", result: RESULT }));
    handle(JSON.stringify({ type: "web_search_done", job_id: "s", result: RESULT }));

    expect(harness.sent).toHaveLength(1);
    expect(harness.responses()).toBe(1);
    expect(harness.persisted).toHaveLength(1);
  });

  it("never lets one card carry both an error and a result", () => {
    const harness = record();
    const handle = sessionStreamHandler(harness.deps);

    handle(JSON.stringify({ type: "web_search_error", job_id: "s", error: "sem chave" }));
    handle(JSON.stringify({ type: "web_search_done", job_id: "s", result: RESULT }));

    const search = harness.webSearchJobs()[0];
    expect(search?.status).toBe("error");
    expect(search?.error).toBe("sem chave");
    expect(search?.result).toBeUndefined();

    // And the model hears about the failure once, not about both.
    expect(harness.sent).toHaveLength(1);
    expect(JSON.stringify(harness.sent[0])).toContain("sem chave");
    expect(harness.responses()).toBe(1);
  });

  it("refuses the same reversal at the fold, where the card actually lives", () => {
    const failed = applyWebSearchEvent(
      [],
      { type: "web_search_error", job_id: "s", error: "sem chave" },
      CONV,
      AT,
    );
    const after = applyWebSearchEvent(
      failed,
      { type: "web_search_done", job_id: "s", result: RESULT },
      CONV,
      AT,
    );

    expect(after).toBe(failed);
  });
});

// ---------------------------------------------------------------------------
// A search that ended without a result
// ---------------------------------------------------------------------------

describe("a web_search_done with nothing in it", () => {
  it("injects nothing rather than the string 'undefined'", () => {
    const harness = record();

    // `result` is declared on the wire and not guaranteed on it. Templated
    // straight into the turn, an absent one became the literal word "undefined"
    // — which the model would then read out loud as the outcome of a search the
    // user asked for.
    sessionStreamHandler(harness.deps)(
      JSON.stringify({ type: "web_search_done", job_id: "s" }),
    );

    expect(harness.webSearchJobs()[0]?.status).toBe("done");
    expect(harness.webSearchJobs()[0]?.result).toBe("");
    expect(harness.sent).toEqual([]);
    expect(harness.responses()).toBe(0);
    expect(harness.persisted).toEqual([]);
    expect(harness.entries).toEqual([]);
    expect(JSON.stringify(harness.webSearchJobs())).not.toContain("undefined");
  });

  it("treats a result that is not a string as no result", () => {
    const harness = record();
    sessionStreamHandler(harness.deps)(
      JSON.stringify({ type: "web_search_done", job_id: "s", result: { text: RESULT } }),
    );

    expect(harness.webSearchJobs()[0]?.result).toBe("");
    expect(harness.sent).toEqual([]);
  });
});

describe("a failure the server described in no words", () => {
  it("never speaks the string 'undefined' for a search", () => {
    const harness = record();
    sessionStreamHandler(harness.deps)(
      JSON.stringify({ type: "web_search_error", job_id: "s" }),
    );

    expect(harness.webSearchJobs()[0]?.status).toBe("error");
    expect(harness.webSearchJobs()[0]?.error).toBe("");

    const spoken = JSON.stringify(harness.sent) + JSON.stringify(harness.entries);
    expect(spoken).not.toContain("undefined");
    expect(spoken).toContain("o servidor nao disse o motivo");
    expect(harness.responses()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The folds themselves
// ---------------------------------------------------------------------------

describe("applyWebSearchEvent", () => {
  it("seeds a card from an event that arrives before any other", () => {
    const jobs = applyWebSearchEvent(
      [],
      { type: "web_search_activity", job_id: "s", activity: "pesquisando" },
      CONV,
      AT,
    );

    expect(jobs[0]).toMatchObject({
      id: "s",
      conversation_id: CONV,
      query: "",
      status: "running",
      activity: "pesquisando",
      started_at: AT,
    });
  });

  it("still folds the three events in the order they normally arrive", () => {
    let jobs = applyWebSearchEvent(
      [],
      { type: "web_search_activity", job_id: "s", activity: "pesquisando" },
      CONV,
      AT,
    );
    expect(jobs[0]?.status).toBe("running");

    jobs = applyWebSearchEvent(
      jobs,
      { type: "web_search_done", job_id: "s", result: RESULT, cost_usd: 0.02 },
      CONV,
      AT,
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.result).toBe(RESULT);
    expect(jobs[0]?.cost_usd).toBe(0.02);

    jobs = applyWebSearchEvent(
      jobs,
      { type: "web_search_error", job_id: "t", error: "timeout" },
      CONV,
      AT,
    );
    expect(jobs).toHaveLength(2);
    expect(jobs[1]).toMatchObject({ status: "error", error: "timeout" });
  });

  it("does not let a late activity drag a finished search back to running", () => {
    const done = applyWebSearchEvent(
      [],
      { type: "web_search_done", job_id: "s", result: RESULT },
      CONV,
      AT,
    );
    const late = applyWebSearchEvent(
      done,
      { type: "web_search_activity", job_id: "s", activity: "ainda buscando" },
      CONV,
      AT,
    );

    expect(late).toBe(done);
    expect(late[0]?.status).toBe("done");
    expect(late[0]?.activity).toBe("concluido");
  });

  it("leaves the list alone for an unknown discriminant", () => {
    const before: WebSearchJob[] = [];
    const after = applyWebSearchEvent(
      before,
      { type: "web_search_unknown" } as unknown as Parameters<typeof applyWebSearchEvent>[1],
      CONV,
      AT,
    );
    expect(after).toBe(before);
  });

  it("keeps a string out of the field the card calls .toFixed on", () => {
    const jobs = applyWebSearchEvent(
      [],
      { type: "web_search_done", job_id: "s", result: RESULT, cost_usd: "1.50" } as never,
      CONV,
      AT,
    );

    expect(jobs[0]?.cost_usd).toBeUndefined();
    expect(jobs[0]?.result).toBe(RESULT);
  });
});

// ---------------------------------------------------------------------------
// The fold, arriving at the end instead of the beginning
// ---------------------------------------------------------------------------

describe("applyWebSearchEvent with no card to fold into", () => {
  it("finishes a search whose done arrives before any other event", () => {
    const jobs = applyWebSearchEvent(
      [],
      { type: "web_search_done", job_id: "s", result: RESULT, cost_usd: 0.02 },
      CONV,
      AT,
    );

    expect(jobs[0]).toMatchObject({
      id: "s",
      conversation_id: CONV,
      query: "",
      status: "done",
      activity: "concluido",
      result: RESULT,
      cost_usd: 0.02,
      started_at: AT,
      finished_at: AT,
    });
  });

  it("fails a search whose error arrives before any other event", () => {
    const jobs = applyWebSearchEvent(
      [],
      { type: "web_search_error", job_id: "s", error: "sem chave" },
      CONV,
      AT,
    );

    expect(jobs[0]).toMatchObject({
      status: "error",
      activity: "falhou",
      error: "sem chave",
      started_at: AT,
      finished_at: AT,
    });
  });

  it("keeps a zero cost — the card guards on presence, not truthiness", () => {
    const jobs = applyWebSearchEvent(
      [],
      { type: "web_search_done", job_id: "s", result: RESULT, cost_usd: 0 },
      CONV,
      AT,
    );

    expect(jobs[0]?.cost_usd).toBe(0);
  });
});

describe("applyWebSearchEvent is monotonic in every direction", () => {
  it("does not let a late activity drag a failed search back to running", () => {
    const failed = applyWebSearchEvent(
      [],
      { type: "web_search_error", job_id: "s", error: "sem chave" },
      CONV,
      AT,
    );
    const late = applyWebSearchEvent(
      failed,
      { type: "web_search_activity", job_id: "s", activity: "ainda buscando" },
      CONV,
      AT,
    );

    expect(late).toBe(failed);
    expect(late[0]?.status).toBe("error");
    expect(late[0]?.activity).toBe("falhou");
  });

  it("does not let a done overwrite an error either", () => {
    const failed = applyWebSearchEvent(
      [],
      { type: "web_search_error", job_id: "s", error: "sem chave" },
      CONV,
      AT,
    );
    const late = applyWebSearchEvent(
      failed,
      { type: "web_search_done", job_id: "s", result: RESULT },
      CONV,
      AT,
    );

    expect(late).toBe(failed);
    expect(late[0]?.result).toBeUndefined();
  });

  it("leaves a search the user cancelled cancelled", () => {
    // The stream never sends `cancelled` — the backend turns a cancel into a
    // `web_search_error` — but a job list seeded from the registry could hold
    // one, and a late frame for it must not show it working again.
    const cancelled: WebSearchJob[] = [
      {
        id: "s",
        conversation_id: CONV,
        query: "",
        status: "cancelled",
        activity: "cancelado",
        started_at: AT,
      },
    ];

    const lateActivity = applyWebSearchEvent(
      cancelled,
      { type: "web_search_activity", job_id: "s", activity: "ainda buscando" },
      CONV,
      AT,
    );
    expect(lateActivity).toBe(cancelled);

    const lateDone = applyWebSearchEvent(
      cancelled,
      { type: "web_search_done", job_id: "s", result: RESULT },
      CONV,
      AT,
    );
    expect(lateDone).toBe(cancelled);
  });
});

// ---------------------------------------------------------------------------
// What the handler hands the half that speaks
// ---------------------------------------------------------------------------

describe("a search that just finished", () => {
  it("runs entry, persist, send and requestResponse in exactly that order", () => {
    const order: string[] = [];
    let responses = 0;
    const deps: SessionStreamDeps = {
      conversationId: CONV,
      setJobs: () => {},
      setDeepThinkJobs: () => {},
      setWebSearchJobs: () => {},
      upsertEntry: () => {
        order.push("entry");
      },
      persist: () => {
        order.push("persist");
      },
      send: () => {
        order.push("send");
      },
      requestResponse: () => {
        order.push("request");
        responses += 1;
      },
    };

    sessionStreamHandler(deps)(JSON.stringify({ type: "web_search_done", job_id: "s", result: RESULT }));

    // The transcript line must exist before the turn that asks the model to
    // speak it, and the archive before the ask — a response.create that wins
    // the race reads a conversation the archive has not caught up with.
    expect(order).toEqual(["entry", "persist", "send", "request"]);
    expect(responses).toBe(1);
  });

  it("persists under the web- id, with the tool role and the [busca web] marker", () => {
    const harness = record();
    sessionStreamHandler(harness.deps)(
      JSON.stringify({ type: "web_search_done", job_id: "search_1", result: RESULT }),
    );

    expect(harness.persisted).toEqual([
      { id: "web-search_1", role: "tool", content: `[busca web] ${RESULT}` },
    ]);
  });

  it("writes the transcript line under the web- id, as a final agent entry", () => {
    const harness = record();
    sessionStreamHandler(harness.deps)(
      JSON.stringify({ type: "web_search_done", job_id: "search_1", result: RESULT }),
    );

    expect(harness.entries).toEqual([
      { id: "web-search_1", role: "agent", text: RESULT, final: true },
    ]);
  });

  it("hands the result to the model as one exact user turn", () => {
    const harness = record();
    sessionStreamHandler(harness.deps)(
      JSON.stringify({ type: "web_search_done", job_id: "s", result: RESULT }),
    );

    expect(harness.sent).toEqual([
      userTextEvent(
        "A busca web terminou. Resultado:\n\n" +
          `${RESULT}\n\n` +
          "Explique isso para mim em voz alta, com suas palavras, de forma curta.",
      ),
    ]);
  });

  it("seeds the card with the handler's conversation id", () => {
    const harness = record();
    sessionStreamHandler(harness.deps)(
      JSON.stringify({ type: "web_search_activity", job_id: "s", activity: "pesquisando" }),
    );

    expect(harness.webSearchJobs()[0]?.conversation_id).toBe(CONV);
  });
});

describe("a search that just failed", () => {
  it("speaks the reason in one exact user turn", () => {
    const harness = record();
    sessionStreamHandler(harness.deps)(
      JSON.stringify({ type: "web_search_error", job_id: "s", error: "sem credito" }),
    );

    expect(harness.entries).toEqual([
      { id: "web-s", role: "agent", text: "A busca web falhou: sem credito", final: true },
    ]);
    expect(harness.sent).toEqual([
      userTextEvent("A busca web falhou: sem credito. Me avise disso em uma frase."),
    ]);
    expect(harness.responses()).toBe(1);
    expect(harness.persisted).toEqual([]);
  });

  it("reads an empty error string as a reason the server did not give", () => {
    const harness = record();
    sessionStreamHandler(harness.deps)(
      JSON.stringify({ type: "web_search_error", job_id: "s", error: "" }),
    );

    const spoken = JSON.stringify(harness.sent) + JSON.stringify(harness.entries);
    expect(spoken).toContain("o servidor nao disse o motivo");
    expect(spoken).not.toContain("undefined");
  });
});

describe("the settled set, per connection", () => {
  it("ignores a replayed copy of a search that already ended on this connection", () => {
    const harness = record();
    const handle = sessionStreamHandler(harness.deps);

    handle(JSON.stringify({ type: "web_search_done", job_id: "s", result: RESULT }));
    handle(
      JSON.stringify({
        type: "web_search_done",
        job_id: "s",
        result: RESULT,
        replay: true,
      }),
    );

    // One live ending, and the replay after it is not a second ending: no
    // second transcript line, no second turn, no second archive write.
    expect(harness.entries).toHaveLength(1);
    expect(harness.persisted).toHaveLength(1);
    expect(harness.sent).toHaveLength(1);
    expect(harness.responses()).toBe(1);
  });

  it("does not speak a failure for a search that already succeeded", () => {
    const harness = record();
    const handle = sessionStreamHandler(harness.deps);

    handle(JSON.stringify({ type: "web_search_done", job_id: "s", result: RESULT }));
    handle(JSON.stringify({ type: "web_search_error", job_id: "s", error: "sem chave" }));

    // The card closed done; the late failure neither redraws it nor announces
    // itself. The user hears about the success once.
    const search = harness.webSearchJobs()[0];
    expect(search?.status).toBe("done");
    expect(search?.error).toBeUndefined();
    expect(harness.sent).toHaveLength(1);
    expect(harness.responses()).toBe(1);
    expect(harness.entries).toHaveLength(1);
  });

  it("drops a done whose result is only whitespace", () => {
    const harness = record();
    sessionStreamHandler(harness.deps)(
      JSON.stringify({ type: "web_search_done", job_id: "s", result: "   " }),
    );

    expect(harness.webSearchJobs()[0]?.status).toBe("done");
    expect(harness.entries).toEqual([]);
    expect(harness.sent).toEqual([]);
    expect(harness.persisted).toEqual([]);
    expect(harness.responses()).toBe(0);
  });

  it("drops an error frame with no job in it, the same guard as the rest", () => {
    const harness = record();
    sessionStreamHandler(harness.deps)(
      JSON.stringify({ type: "web_search_error", error: "sem chave" }),
    );
    sessionStreamHandler(harness.deps)(
      JSON.stringify({ type: "web_search_activity", activity: "pesquisando" }),
    );

    expect(harness.webSearchJobs()).toEqual([]);
    expect(harness.sent).toEqual([]);
    expect(harness.responses()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Two searches share one stream
// ---------------------------------------------------------------------------

describe("two searches on one connection", () => {
  it("keeps each search on its own card", () => {
    const harness = record();
    const handle = sessionStreamHandler(harness.deps);
    const other = "O mercado de notebooks 2026";

    handle(
      JSON.stringify({ type: "web_search_activity", job_id: "s1", activity: "buscando" }),
    );
    handle(JSON.stringify({ type: "web_search_done", job_id: "s2", result: other }));
    handle(JSON.stringify({ type: "web_search_done", job_id: "s1", result: RESULT }));

    const searches = harness.webSearchJobs();
    expect(searches).toHaveLength(2);
    expect(searches[0]?.result).toBe(RESULT);
    expect(searches[1]?.result).toBe(other);

    // Each ending spoke and archived exactly once, under its own id.
    expect(harness.sent).toHaveLength(2);
    expect(harness.persisted.map((p) => p.id)).toEqual(["web-s2", "web-s1"]);
    expect(harness.entries.map((e) => e.id)).toEqual(["web-s2", "web-s1"]);
  });
});
