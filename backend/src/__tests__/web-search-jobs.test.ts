import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import type { WebSearchEvent } from "../types/deep-tools.js";

// web-search-jobs.ts imports executeWebSearch from tools/web-search.js, which
// would reach the OpenAI API and the surf CLI. The stub replaces the whole
// module, so nothing in this file touches the network.
const { executeWebSearchMock } = vi.hoisted(() => ({ executeWebSearchMock: vi.fn() }));

vi.mock("../tools/web-search.js", () => ({ executeWebSearch: executeWebSearchMock }));

const mod = await import("../services/web-search-jobs.js");

type SearchResult = { text: string; cost_usd?: number };

function waitFor(
  predicate: (event: WebSearchEvent) => boolean,
  timeoutMs = 10_000,
): Promise<WebSearchEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("timed out waiting for the search event"));
    }, timeoutMs);

    const unsubscribe = mod.subscribeWebSearch((event) => {
      if (!predicate(event)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(event);
    });
  });
}

/** A search that never answers; the job has to be torn off it. */
function hangingSearch(): Promise<SearchResult> {
  return new Promise<SearchResult>(() => undefined);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("dispatchWebSearch", () => {
  it("returns a running job with the query before the search has answered", async () => {
    executeWebSearchMock.mockImplementationOnce(hangingSearch);

    const job = mod.dispatchWebSearch({
      conversationId: randomUUID(),
      query: "o que e rust?",
    });

    // The whole point: the caller is not blocked on the search.
    expect(job.status).toBe("running");
    expect(job.query).toBe("o que e rust?");
    expect(job.activity).toBe("buscando na web");
    expect(job.result).toBeUndefined();

    expect(mod.cancelWebSearch(job.id)).toBe(true);
    expect(mod.getWebSearchJob(job.id)?.status).toBe("cancelled");
  });

  it("disarms the budget timer when the job is cancelled", () => {
    vi.useFakeTimers();
    try {
      executeWebSearchMock.mockImplementationOnce(hangingSearch);

      const job = mod.dispatchWebSearch({ conversationId: randomUUID(), query: "x" });
      expect(vi.getTimerCount()).toBe(1);

      expect(mod.cancelWebSearch(job.id)).toBe(true);
      // A live timer here would hold the event loop and the job closure until
      // the whole budget elapsed, even though the job is already cancelled.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a second search in the same conversation", async () => {
    executeWebSearchMock.mockImplementationOnce(hangingSearch);

    const conv = randomUUID();
    const first = mod.dispatchWebSearch({
      conversationId: conv,
      query: "primeira",
    });

    let status = 0;
    try {
      mod.dispatchWebSearch({ conversationId: conv, query: "segunda" });
      expect.unreachable("the second dispatch should have been refused");
    } catch (err) {
      expect(err).toBeInstanceOf(mod.WebSearchJobError);
      expect((err as InstanceType<typeof mod.WebSearchJobError>).message).toMatch(
        /Ja existe uma busca/,
      );
      status = (err as InstanceType<typeof mod.WebSearchJobError>).status;
    }
    expect(status).toBe(409);

    // Cancelling frees the conversation, and a finished search is not "running".
    expect(mod.cancelWebSearch(first.id)).toBe(true);
    expect(mod.cancelWebSearch(first.id)).toBe(false);
    expect(mod.listWebSearchJobs(conv).map((j) => j.id)).toContain(first.id);
  });

  it("announces the search stages on the bus", async () => {
    executeWebSearchMock.mockResolvedValueOnce({ text: "pronto" });

    const activities: string[] = [];
    const unsubscribe = mod.subscribeWebSearch((event) => {
      if (event.type === "web_search_activity") activities.push(event.activity);
    });

    const job = mod.dispatchWebSearch({ conversationId: randomUUID(), query: "x" });
    await waitFor((e) => e.type === "web_search_done" && e.job_id === job.id);
    unsubscribe();

    expect(activities).toEqual(["buscando na web", "formatando os resultados"]);
  });

  it("delivers the finished search with its cost on the bus", async () => {
    executeWebSearchMock.mockResolvedValueOnce({ text: "O petroleo subiu. Fonte: X.", cost_usd: 0.0123 });

    const job = mod.dispatchWebSearch({
      conversationId: randomUUID(),
      query: "preco do petroleo",
    });
    const event = await waitFor((e) => e.type === "web_search_done" && e.job_id === job.id);

    expect(event.type).toBe("web_search_done");
    if (event.type === "web_search_done") {
      expect(event.result).toContain("O petroleo subiu.");
      expect(event.cost_usd).toBeCloseTo(0.0123);
      expect(event.replay).toBeUndefined(); // live, not replayed
    }

    const finished = mod.getWebSearchJob(job.id);
    expect(finished?.status).toBe("done");
    expect(finished?.result).toContain("O petroleo subiu.");
    expect(finished?.cost_usd).toBeCloseTo(0.0123);
    expect(finished?.activity).toBe("concluido");
  });

  it("leaves cost off the done event when the search cost nothing", async () => {
    executeWebSearchMock.mockResolvedValueOnce({ text: "sem custo" });

    const job = mod.dispatchWebSearch({ conversationId: randomUUID(), query: "x" });
    const event = await waitFor((e) => e.type === "web_search_done" && e.job_id === job.id);

    expect(event).not.toHaveProperty("cost_usd");
    expect(mod.getWebSearchJob(job.id)?.cost_usd).toBeUndefined();
  });

  it("reports a search that threw as an error", async () => {
    executeWebSearchMock.mockRejectedValueOnce(new Error("boom"));

    const job = mod.dispatchWebSearch({ conversationId: randomUUID(), query: "x" });
    const event = await waitFor((e) => e.type === "web_search_error" && e.job_id === job.id);

    expect(event.type).toBe("web_search_error");
    if (event.type === "web_search_error") {
      expect(event.error).toMatch(/A busca falhou: boom/);
    }
    expect(mod.getWebSearchJob(job.id)?.status).toBe("error");
  });

  it("times the job out with a spoken error", async () => {
    executeWebSearchMock.mockImplementationOnce(hangingSearch);

    const job = mod.dispatchWebSearch({
      conversationId: randomUUID(),
      query: "demora",
      timeoutMs: 1_000,
    });
    const event = await waitFor((e) => e.type === "web_search_error" && e.job_id === job.id);

    expect(event.type).toBe("web_search_error");
    if (event.type === "web_search_error") {
      expect(event.error).toBe("A busca passou de 1s e foi interrompida.");
    }
    expect(mod.getWebSearchJob(job.id)?.status).toBe("error");
  });

  it("drops the late arrival of a cancelled search without emitting anything", async () => {
    let resolveSearch: (value: SearchResult) => void = () => undefined;
    executeWebSearchMock.mockImplementationOnce(
      () => new Promise<SearchResult>((resolve) => { resolveSearch = resolve; }),
    );

    const job = mod.dispatchWebSearch({ conversationId: randomUUID(), query: "lenta" });
    expect(mod.cancelWebSearch(job.id)).toBe(true);
    expect(mod.getWebSearchJob(job.id)?.status).toBe("cancelled");

    // Subscribe after the cancel so the only thing that could arrive is the
    // late result — and nothing should.
    const events: WebSearchEvent[] = [];
    const unsubscribe = mod.subscribeWebSearch((event) => events.push(event));

    resolveSearch({ text: "chegou tarde", cost_usd: 0.01 });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mod.getWebSearchJob(job.id)?.status).toBe("cancelled");
    expect(mod.getWebSearchJob(job.id)?.result).toBeUndefined();
    expect(events.some((event) => event.type === "web_search_done")).toBe(false);
    unsubscribe();
  });

  it("hands the conversation block to the search", async () => {
    executeWebSearchMock.mockResolvedValueOnce({ text: "ok" });

    const conv = randomUUID();
    const job = mod.dispatchWebSearch({
      conversationId: conv,
      query: "o que o usuario perguntou?",
      context: "# Contexto da conversa\nusuario: sobre a migracao",
    });
    await waitFor((e) => e.type === "web_search_done" && e.job_id === job.id);

    // The query stays untrimmed-unmodified (dispatch trims), and the context
    // rides as the 4th argument.
    expect(executeWebSearchMock).toHaveBeenCalledWith(
      "o que o usuario perguntou?",
      conv,
      undefined,
      "# Contexto da conversa\nusuario: sobre a migracao",
    );
  });

  it("prunes finished jobs beyond the retention cap", async () => {
    executeWebSearchMock.mockResolvedValue({ text: "ok" });

    const ids: string[] = [];
    for (let i = 0; i < 60; i++) {
      ids.push(
        mod.dispatchWebSearch({ conversationId: randomUUID(), query: `q${i}` }).id,
      );
      // started_at is ms-precision and the prune sorts on it, so the pause
      // keeps the order deterministic — and lets each job finish before the
      // next dispatch prunes it.
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(mod.getWebSearchJob(ids[0]!)).toBeUndefined();
    expect(mod.getWebSearchJob(ids[9]!)).toBeUndefined();
    expect(mod.getWebSearchJob(ids[59]!)).toBeDefined();
    expect(mod.getWebSearchJob(ids[58]!)).toBeDefined();
  });
});
