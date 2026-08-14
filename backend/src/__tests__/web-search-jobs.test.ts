import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import type { WebSearchEvent, WebSearchJob } from "../types/deep-tools.js";

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

  it("runs the 180s default budget when no timeout is injected", () => {
    vi.useFakeTimers();
    try {
      executeWebSearchMock.mockImplementationOnce(hangingSearch);

      // No timeoutMs: the dispatch path has to fall back to the module's
      // DEFAULT_TIMEOUT_MS, which nothing else in the suite pins.
      const job = mod.dispatchWebSearch({ conversationId: randomUUID(), query: "x" });
      expect(vi.getTimerCount()).toBe(1);

      // One second short of the default budget the job is still running...
      vi.advanceTimersByTime(180_000 - 1);
      expect(mod.getWebSearchJob(job.id)?.status).toBe("running");

      // ...and the 180s mark kills it, with the seconds read from the constant
      // spoken back in the error.
      vi.advanceTimersByTime(1);
      expect(mod.getWebSearchJob(job.id)?.status).toBe("error");
      expect(mod.getWebSearchJob(job.id)?.error).toBe(
        "A busca passou de 180s e foi interrompida.",
      );
    } finally {
      vi.useRealTimers();
    }
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

  it("trims the query before storing it and searching", async () => {
    executeWebSearchMock.mockResolvedValueOnce({ text: "ok" });

    const conv = randomUUID();
    const job = mod.dispatchWebSearch({
      conversationId: conv,
      query: "  com espacos  ",
    });
    expect(job.query).toBe("com espacos");

    await waitFor((e) => e.type === "web_search_done" && e.job_id === job.id);
    expect(executeWebSearchMock).toHaveBeenCalledWith(
      "com espacos",
      conv,
      undefined,
      undefined,
    );
  });

  it("lets two conversations search at the same time", async () => {
    executeWebSearchMock.mockImplementation(hangingSearch);

    const a = mod.dispatchWebSearch({ conversationId: randomUUID(), query: "a" });
    const b = mod.dispatchWebSearch({ conversationId: randomUUID(), query: "b" });

    // The 409 is per conversation: a search in one must not block another.
    expect(a.status).toBe("running");
    expect(b.status).toBe("running");

    expect(mod.cancelWebSearch(a.id)).toBe(true);
    expect(mod.cancelWebSearch(b.id)).toBe(true);
  });

  it("lists only the jobs of the conversation asked about", async () => {
    executeWebSearchMock.mockImplementation(hangingSearch);

    const convA = randomUUID();
    const convB = randomUUID();
    const a = mod.dispatchWebSearch({ conversationId: convA, query: "a" });
    const b = mod.dispatchWebSearch({ conversationId: convB, query: "b" });

    expect(mod.listWebSearchJobs(convA).map((job) => job.id)).toEqual([a.id]);
    expect(mod.listWebSearchJobs(convB).map((job) => job.id)).toEqual([b.id]);
    expect(mod.listWebSearchJobs(randomUUID())).toEqual([]);
    expect(mod.getWebSearchJob("nao-existe")).toBeUndefined();

    expect(mod.cancelWebSearch(a.id)).toBe(true);
    expect(mod.cancelWebSearch(b.id)).toBe(true);
  });

  it("ignores a cancel for a finished job or an unknown id", async () => {
    executeWebSearchMock.mockResolvedValueOnce({ text: "pronto" });
    const job = mod.dispatchWebSearch({ conversationId: randomUUID(), query: "x" });
    await waitFor((e) => e.type === "web_search_done" && e.job_id === job.id);

    // Only `running` jobs can be cancelled; a done job is left alone.
    expect(mod.cancelWebSearch(job.id)).toBe(false);
    expect(mod.getWebSearchJob(job.id)?.status).toBe("done");
    expect(mod.cancelWebSearch(randomUUID())).toBe(false);
  });

  it("frees the conversation slot once a job is cancelled or finished", async () => {
    executeWebSearchMock.mockImplementationOnce(hangingSearch);
    executeWebSearchMock.mockResolvedValueOnce({ text: "ok" });

    const conv = randomUUID();
    const first = mod.dispatchWebSearch({ conversationId: conv, query: "primeira" });
    expect(mod.cancelWebSearch(first.id)).toBe(true);

    const second = mod.dispatchWebSearch({ conversationId: conv, query: "segunda" });
    await waitFor((e) => e.type === "web_search_done" && e.job_id === second.id);

    // A finished search is not "running", so the conversation is free again.
    const third = mod.dispatchWebSearch({ conversationId: conv, query: "terceira" });
    expect(third.status).toBe("running");
    expect(mod.cancelWebSearch(third.id)).toBe(true);
  });

  it("disarms the budget timer when the timeout fires", () => {
    vi.useFakeTimers();
    try {
      const setTimeoutSpy = vi.spyOn(global, "setTimeout");
      const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");
      executeWebSearchMock.mockImplementationOnce(hangingSearch);

      const job = mod.dispatchWebSearch({
        conversationId: randomUUID(),
        query: "x",
        timeoutMs: 30_000,
      });
      expect(vi.getTimerCount()).toBe(1);

      const budgetTimer = setTimeoutSpy.mock.results[0]!.value;

      vi.advanceTimersByTime(30_000);
      expect(mod.getWebSearchJob(job.id)?.status).toBe("error");
      // The timer has already fired by the time finish() runs on this path, so
      // `getTimerCount()` (pending timers only) cannot see the disarm — that
      // assertion held whether or not finish() cleared the timer. The search
      // never settles, so runSearch's finally, the other clearTimeout site,
      // never runs: the only clearTimeout caller in this window is finish(),
      // and the id it clears must be the budget timer's own.
      expect(clearTimeoutSpy).toHaveBeenCalledWith(budgetTimer);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it("drops the late arrival of a job that timed out", async () => {
    let resolveSearch: (value: SearchResult) => void = () => undefined;
    executeWebSearchMock.mockImplementationOnce(
      () => new Promise<SearchResult>((resolve) => { resolveSearch = resolve; }),
    );

    const job = mod.dispatchWebSearch({
      conversationId: randomUUID(),
      query: "lenta",
      timeoutMs: 50,
    });
    const event = await waitFor((e) => e.type === "web_search_error" && e.job_id === job.id);
    expect(event.type).toBe("web_search_error");
    if (event.type === "web_search_error") expect(event.error).toMatch(/interrompida/);

    const events: WebSearchEvent[] = [];
    const unsubscribe = mod.subscribeWebSearch((e) => events.push(e));

    resolveSearch({ text: "chegou tarde", cost_usd: 0.01 });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mod.getWebSearchJob(job.id)?.status).toBe("error");
    expect(mod.getWebSearchJob(job.id)?.result).toBeUndefined();
    expect(events.some((e) => e.type === "web_search_done")).toBe(false);
    unsubscribe();
  });

  it("never prunes a running job", async () => {
    // 5 searches, still running, dispatched first: they are the oldest jobs in
    // the registry. The prune sorts by started_at and deletes from the oldest
    // end, so a prune that kept the 50 newest by age alone would take them
    // before any finished job — only the explicit "not running" filter can
    // protect them.
    executeWebSearchMock.mockImplementation(hangingSearch);
    const runningIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      runningIds.push(
        mod.dispatchWebSearch({ conversationId: randomUUID(), query: `r${i}` }).id,
      );
    }

    // 55 finished searches, one per conversation — every one settled before the
    // next dispatch, so the prune always sees them.
    executeWebSearchMock.mockResolvedValue({ text: "ok" });
    const finishedIds: string[] = [];
    for (let i = 0; i < 55; i++) {
      const job = mod.dispatchWebSearch({ conversationId: randomUUID(), query: `f${i}` });
      finishedIds.push(job.id);
      await waitFor((e) => e.type === "web_search_done" && e.job_id === job.id);
      // started_at is ms-precision and the prune sorts on it, so the pause
      // keeps the order deterministic.
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    // The oldest finished jobs were pruned away — but the running ones survive
    // even though they predate every finished job.
    expect(mod.getWebSearchJob(finishedIds[0]!)).toBeUndefined();
    expect(mod.getWebSearchJob(finishedIds[10]!)).toBeDefined();
    expect(mod.getWebSearchJob(finishedIds[54]!)).toBeDefined();
    for (const id of runningIds) {
      expect(mod.getWebSearchJob(id)?.status).toBe("running");
    }

    for (const id of runningIds) expect(mod.cancelWebSearch(id)).toBe(true);
  });

  it("stops delivering to a listener that unsubscribed", async () => {
    executeWebSearchMock.mockResolvedValueOnce({ text: "ok" });

    const received: WebSearchEvent[] = [];
    const unsubscribe = mod.subscribeWebSearch((event) => received.push(event));
    unsubscribe();

    const job = mod.dispatchWebSearch({ conversationId: randomUUID(), query: "x" });
    await waitFor((e) => e.type === "web_search_done" && e.job_id === job.id);

    expect(received).toEqual([]);
  });

  it("stamps the terminal state on the job's activity", async () => {
    executeWebSearchMock.mockRejectedValueOnce(new Error("boom"));
    const conv = randomUUID();
    const failed = mod.dispatchWebSearch({ conversationId: conv, query: "falha" });
    await waitFor((e) => e.type === "web_search_error" && e.job_id === failed.id);
    expect(mod.getWebSearchJob(failed.id)?.activity).toMatch(/A busca falhou: boom/);

    executeWebSearchMock.mockImplementationOnce(hangingSearch);
    const cancelled = mod.dispatchWebSearch({ conversationId: conv, query: "cancela" });
    mod.cancelWebSearch(cancelled.id);
    expect(mod.getWebSearchJob(cancelled.id)?.activity).toBe("Cancelado pelo usuario.");
  });

  it("carries an empty result when the search answers with nothing", async () => {
    executeWebSearchMock.mockResolvedValueOnce({ text: "" });

    const job = mod.dispatchWebSearch({ conversationId: randomUUID(), query: "x" });
    const event = await waitFor((e) => e.type === "web_search_done" && e.job_id === job.id);

    expect(event.type).toBe("web_search_done");
    if (event.type === "web_search_done") expect(event.result).toBe("");
  });

  it("lets up to the configured cap of searches run at once", async () => {
    executeWebSearchMock.mockImplementation(hangingSearch);

    const conv = randomUUID();
    const first = mod.dispatchWebSearch({ conversationId: conv, query: "a", maxConcurrent: 3 });
    const second = mod.dispatchWebSearch({ conversationId: conv, query: "b", maxConcurrent: 3 });
    const third = mod.dispatchWebSearch({ conversationId: conv, query: "c", maxConcurrent: 3 });
    expect([first.status, second.status, third.status]).toEqual([
      "running",
      "running",
      "running",
    ]);

    let status = 0;
    try {
      mod.dispatchWebSearch({ conversationId: conv, query: "d", maxConcurrent: 3 });
      expect.unreachable("the fourth dispatch should have been refused");
    } catch (err) {
      expect(err).toBeInstanceOf(mod.WebSearchJobError);
      // The cap is spoken back, so the model knows how many are in flight.
      expect((err as InstanceType<typeof mod.WebSearchJobError>).message).toMatch(
        /Ja existem 3 buscas em andamento/,
      );
      status = (err as InstanceType<typeof mod.WebSearchJobError>).status;
    }
    expect(status).toBe(409);

    for (const job of [first, second, third]) expect(mod.cancelWebSearch(job.id)).toBe(true);
  });

  it("keeps the one-at-a-time rule for an explicit cap of 1", async () => {
    executeWebSearchMock.mockImplementationOnce(hangingSearch);

    const conv = randomUUID();
    const first = mod.dispatchWebSearch({
      conversationId: conv,
      query: "a",
      maxConcurrent: 1,
    });

    let status = 0;
    try {
      mod.dispatchWebSearch({ conversationId: conv, query: "b", maxConcurrent: 1 });
      expect.unreachable("the second dispatch should have been refused");
    } catch (err) {
      expect(err).toBeInstanceOf(mod.WebSearchJobError);
      expect((err as InstanceType<typeof mod.WebSearchJobError>).message).toMatch(
        /Ja existe uma busca/,
      );
      status = (err as InstanceType<typeof mod.WebSearchJobError>).status;
    }
    expect(status).toBe(409);

    expect(mod.cancelWebSearch(first.id)).toBe(true);
  });

  it("frees a slot when one of the parallel searches finishes", async () => {
    executeWebSearchMock.mockImplementationOnce(hangingSearch);
    executeWebSearchMock.mockResolvedValueOnce({ text: "ok" });

    const conv = randomUUID();
    const first = mod.dispatchWebSearch({ conversationId: conv, query: "a", maxConcurrent: 2 });
    const second = mod.dispatchWebSearch({ conversationId: conv, query: "b", maxConcurrent: 2 });
    expect(mod.listWebSearchJobs(conv).filter((j) => j.status === "running")).toHaveLength(2);

    await waitFor((e) => e.type === "web_search_done" && e.job_id === second.id);

    const third = mod.dispatchWebSearch({ conversationId: conv, query: "c", maxConcurrent: 2 });
    expect(third.status).toBe("running");

    expect(mod.cancelWebSearch(first.id)).toBe(true);
    expect(mod.cancelWebSearch(third.id)).toBe(true);
  });

  it("never shares the cap between conversations", async () => {
    executeWebSearchMock.mockImplementation(hangingSearch);

    const convA = randomUUID();
    const convB = randomUUID();
    const a1 = mod.dispatchWebSearch({ conversationId: convA, query: "a1", maxConcurrent: 2 });
    const a2 = mod.dispatchWebSearch({ conversationId: convA, query: "a2", maxConcurrent: 2 });
    // convA is at its cap; convB must not feel it, and convB's own search must
    // not lift convA's either.
    const b1 = mod.dispatchWebSearch({ conversationId: convB, query: "b1", maxConcurrent: 2 });
    expect(b1.status).toBe("running");

    let status = 0;
    try {
      mod.dispatchWebSearch({ conversationId: convA, query: "a3", maxConcurrent: 2 });
      expect.unreachable("convA is at its cap");
    } catch (err) {
      expect(err).toBeInstanceOf(mod.WebSearchJobError);
      status = (err as InstanceType<typeof mod.WebSearchJobError>).status;
    }
    expect(status).toBe(409);

    for (const job of [a1, a2, b1]) expect(mod.cancelWebSearch(job.id)).toBe(true);
  });

  it("cancelling one parallel search leaves the others running and free to finish", async () => {
    let resolveSecond: (value: SearchResult) => void = () => undefined;
    executeWebSearchMock.mockImplementationOnce(() => hangingSearch());
    executeWebSearchMock.mockImplementationOnce(
      () => new Promise<SearchResult>((resolve) => { resolveSecond = resolve; }),
    );
    executeWebSearchMock.mockImplementation(hangingSearch);

    const conv = randomUUID();
    const first = mod.dispatchWebSearch({ conversationId: conv, query: "a", maxConcurrent: 2 });
    const second = mod.dispatchWebSearch({ conversationId: conv, query: "b", maxConcurrent: 2 });
    expect(mod.cancelWebSearch(first.id)).toBe(true);
    expect(mod.getWebSearchJob(first.id)?.status).toBe("cancelled");

    // The cancelled job does not eat a slot: the guard counts only `running`
    // jobs, so with `second` alone in flight a third dispatch is accepted.
    const third = mod.dispatchWebSearch({ conversationId: conv, query: "c", maxConcurrent: 2 });
    expect(third.status).toBe("running");

    // The untouched search still concludes normally, and the cancelled job
    // stays cancelled instead of being overwritten by the late arrival.
    resolveSecond({ text: "a segunda chegou" });
    await waitFor((e) => e.type === "web_search_done" && e.job_id === second.id);
    expect(mod.getWebSearchJob(second.id)?.status).toBe("done");
    expect(mod.getWebSearchJob(first.id)?.status).toBe("cancelled");
    expect(mod.getWebSearchJob(third.id)?.status).toBe("running");

    expect(mod.cancelWebSearch(third.id)).toBe(true);
  });

  it("an error in one parallel search does not touch the others", async () => {
    let resolveSecond: (value: SearchResult) => void = () => undefined;
    executeWebSearchMock.mockImplementationOnce(() => Promise.reject(new Error("boom")));
    executeWebSearchMock.mockImplementationOnce(
      () => new Promise<SearchResult>((resolve) => { resolveSecond = resolve; }),
    );
    executeWebSearchMock.mockImplementation(hangingSearch);

    const conv = randomUUID();
    const first = mod.dispatchWebSearch({ conversationId: conv, query: "a", maxConcurrent: 2 });
    const second = mod.dispatchWebSearch({ conversationId: conv, query: "b", maxConcurrent: 2 });
    const failed = await waitFor((e) => e.type === "web_search_error" && e.job_id === first.id);
    if (failed.type === "web_search_error") expect(failed.error).toMatch(/A busca falhou: boom/);
    expect(mod.getWebSearchJob(first.id)?.status).toBe("error");

    // The failed job frees its slot (only `running` counts) and the surviving
    // search keeps running — and still concludes normally afterwards.
    expect(mod.getWebSearchJob(second.id)?.status).toBe("running");
    const third = mod.dispatchWebSearch({ conversationId: conv, query: "c", maxConcurrent: 2 });
    expect(third.status).toBe("running");

    resolveSecond({ text: "a segunda chegou" });
    await waitFor((e) => e.type === "web_search_done" && e.job_id === second.id);
    expect(mod.getWebSearchJob(second.id)?.status).toBe("done");
    expect(mod.getWebSearchJob(first.id)?.status).toBe("error");

    expect(mod.cancelWebSearch(third.id)).toBe(true);
  });

  it("timing one parallel search out does not kill the others", async () => {
    let resolveSecond: (value: SearchResult) => void = () => undefined;
    executeWebSearchMock.mockImplementationOnce(hangingSearch);
    executeWebSearchMock.mockImplementationOnce(
      () => new Promise<SearchResult>((resolve) => { resolveSecond = resolve; }),
    );
    executeWebSearchMock.mockImplementation(hangingSearch);

    const conv = randomUUID();
    const first = mod.dispatchWebSearch({
      conversationId: conv,
      query: "demora",
      maxConcurrent: 2,
      timeoutMs: 1_000,
    });
    const second = mod.dispatchWebSearch({ conversationId: conv, query: "b", maxConcurrent: 2 });
    const timedOut = await waitFor((e) => e.type === "web_search_error" && e.job_id === first.id);
    if (timedOut.type === "web_search_error") expect(timedOut.error).toMatch(/interrompida/);
    expect(mod.getWebSearchJob(first.id)?.status).toBe("error");

    // The timeout freed the slot and the other search is untouched.
    expect(mod.getWebSearchJob(second.id)?.status).toBe("running");
    const third = mod.dispatchWebSearch({ conversationId: conv, query: "c", maxConcurrent: 2 });
    expect(third.status).toBe("running");

    resolveSecond({ text: "a segunda chegou" });
    await waitFor((e) => e.type === "web_search_done" && e.job_id === second.id);
    expect(mod.getWebSearchJob(second.id)?.status).toBe("done");

    expect(mod.cancelWebSearch(third.id)).toBe(true);
  });

  it("speaks the cap back for a fan of six", async () => {
    executeWebSearchMock.mockImplementation(hangingSearch);

    const conv = randomUUID();
    const jobs: WebSearchJob[] = [];
    for (let i = 0; i < 6; i++) {
      jobs.push(mod.dispatchWebSearch({ conversationId: conv, query: `q${i}`, maxConcurrent: 6 }));
    }
    expect(jobs.every((job) => job.status === "running")).toBe(true);

    let status = 0;
    try {
      mod.dispatchWebSearch({ conversationId: conv, query: "setima", maxConcurrent: 6 });
      expect.unreachable("the seventh dispatch should have been refused");
    } catch (err) {
      expect(err).toBeInstanceOf(mod.WebSearchJobError);
      expect((err as InstanceType<typeof mod.WebSearchJobError>).message).toMatch(
        /Ja existem 6 buscas em andamento/,
      );
      status = (err as InstanceType<typeof mod.WebSearchJobError>).status;
    }
    expect(status).toBe(409);

    for (const job of jobs) expect(mod.cancelWebSearch(job.id)).toBe(true);
  });

  it("keeps every running job when the registry overflows with nothing finished", async () => {
    executeWebSearchMock.mockImplementation(hangingSearch);

    // 55 in-flight searches: every dispatch prunes, and the prune has nothing
    // to sacrifice — all of them are `running`, so the retention cap has no
    // victim and none of them disappears.
    const ids: string[] = [];
    for (let i = 0; i < 55; i++) {
      ids.push(mod.dispatchWebSearch({ conversationId: randomUUID(), query: `r${i}` }).id);
    }

    for (const id of ids) expect(mod.getWebSearchJob(id)?.status).toBe("running");

    for (const id of ids) expect(mod.cancelWebSearch(id)).toBe(true);
  });

});
