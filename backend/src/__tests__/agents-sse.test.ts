import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { AgentJob } from "../types/index.js";
import type { AgentJobEvent } from "../services/agent-jobs.js";
import type { DeepThinkEvent, DeepThinkJob, WebSearchEvent, WebSearchJob } from "../types/deep-tools.js";

const tmpHome = mkdtempSync(join(tmpdir(), "explainer-agents-sse-"));
process.env.HOME = tmpHome;

// Both registries are replaced wholesale. A real deep-think round costs a
// planner, N thinkers and a synthesiser; what is under test here is the route's
// replay and fan-out, so the jobs are handed in directly.

const agentJobs = new Map<string, AgentJob>();
const deepThinkJobs = new Map<string, DeepThinkJob>();
let agentListener: ((event: AgentJobEvent) => void) | null = null;
let deepThinkListener: ((event: DeepThinkEvent) => void) | null = null;

vi.mock("../services/agent-jobs.js", () => ({
  getJob: (id: string) => agentJobs.get(id),
  listJobs: (conversationId: string) =>
    [...agentJobs.values()].filter((job) => job.conversation_id === conversationId),
  subscribe: (listener: (event: AgentJobEvent) => void) => {
    agentListener = listener;
    return () => {
      agentListener = null;
    };
  },
  cancelJob: () => false,
}));

vi.mock("../services/deep-think.js", () => ({
  getDeepThinkJob: (id: string) => deepThinkJobs.get(id),
  listDeepThinkJobs: (conversationId: string) =>
    [...deepThinkJobs.values()].filter((job) => job.conversation_id === conversationId),
  subscribeDeepThink: (listener: (event: DeepThinkEvent) => void) => {
    deepThinkListener = listener;
    return () => {
      deepThinkListener = null;
    };
  },
}));

const webSearchJobs = new Map<string, WebSearchJob>();
let webSearchListener: ((event: WebSearchEvent) => void) | null = null;

vi.mock("../services/web-search-jobs.js", () => ({
  getWebSearchJob: (id: string) => webSearchJobs.get(id),
  listWebSearchJobs: (conversationId: string) =>
    [...webSearchJobs.values()].filter((job) => job.conversation_id === conversationId),
  subscribeWebSearch: (listener: (event: WebSearchEvent) => void) => {
    webSearchListener = listener;
    return () => {
      webSearchListener = null;
    };
  },
}));

const express = (await import("express")).default;
const agentsRouter = (await import("../routes/agents.js")).default;

const app = express();
app.use("/api/agents", agentsRouter);

const server: Server = app.listen(0);
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}/api/agents`;

afterAll(() => {
  server.close();
  rmSync(tmpHome, { recursive: true, force: true });
});

let conversationId = randomUUID();

beforeEach(() => {
  conversationId = randomUUID();
  agentJobs.clear();
  deepThinkJobs.clear();
  webSearchJobs.clear();
  agentListener = null;
  deepThinkListener = null;
  webSearchListener = null;
});

function deepThinkJob(overrides: Partial<DeepThinkJob> = {}): DeepThinkJob {
  const id = randomUUID();
  const job: DeepThinkJob = {
    id,
    conversation_id: conversationId,
    scenario: "Vale a pena trocar o banco?",
    status: "done",
    activity: "Sintetizando.",
    thinkers: [
      { id: "t1", angle: "custo", status: "done", thinking: "Sai caro." },
    ],
    synthesis: "Nao vale agora.",
    started_at: new Date().toISOString(),
    ...overrides,
  };
  deepThinkJobs.set(id, job);
  return job;
}

function webSearchJob(overrides: Partial<WebSearchJob> = {}): WebSearchJob {
  const id = randomUUID();
  const job: WebSearchJob = {
    id,
    conversation_id: conversationId,
    query: "preco do petroleo",
    status: "done",
    activity: "concluido",
    result: "O petroleo subiu. Fontes:\n[1] Exemplo",
    started_at: new Date().toISOString(),
    ...overrides,
  };
  webSearchJobs.set(id, job);
  return job;
}

/** Read SSE frames until `count` of them have arrived, then drop the stream. */
async function readEvents(
  count: number,
  after?: () => void,
): Promise<Record<string, unknown>[]> {
  const controller = new AbortController();
  const res = await fetch(`${base}/events?conversation_id=${conversationId}`, {
    signal: controller.signal,
  });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();

  const events: Record<string, unknown>[] = [];
  let buffer = "";

  // The subscriptions are registered by the time the response headers are out,
  // so anything emitted from here on reaches this reader.
  after?.();

  while (events.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const line = frame.trim();
      if (!line.startsWith("data:")) continue;
      events.push(JSON.parse(line.slice("data:".length)) as Record<string, unknown>);
    }
  }

  controller.abort();
  return events;
}

describe("GET /api/agents/events", () => {
  it("replays a finished deep-think round marked as a replay", async () => {
    const job = deepThinkJob({ cost_usd: 0.42 });

    const [event] = await readEvents(1);

    expect(event).toMatchObject({
      type: "deep_think_done",
      job_id: job.id,
      synthesis: "Nao vale agora.",
      cost_usd: 0.42,
      // Without this the client narrates an hour-old synthesis on every
      // reconnect — and pays for the audio.
      replay: true,
    });
    expect(event!.thinkers).toHaveLength(1);
  });

  it("replays a failed round as an error, also marked", async () => {
    deepThinkJob({ status: "error", error: "A rodada estourou o prazo.", synthesis: undefined });

    const [event] = await readEvents(1);

    expect(event).toMatchObject({
      type: "deep_think_error",
      error: "A rodada estourou o prazo.",
      replay: true,
    });
  });

  it("replays a cancelled round as an error", async () => {
    deepThinkJob({ status: "cancelled", error: "Cancelado pelo usuario." });

    const [event] = await readEvents(1);
    expect(event).toMatchObject({ type: "deep_think_error", replay: true });
  });

  it("does not replay a round that is still running", async () => {
    deepThinkJob({ status: "running", synthesis: undefined });
    const finished = deepThinkJob();

    const [event] = await readEvents(1);
    expect(event).toMatchObject({ job_id: finished.id, type: "deep_think_done" });
  });

  it("carries live rounds on the same stream, without the replay flag", async () => {
    const job = deepThinkJob({ status: "running", synthesis: undefined });

    const events = await readEvents(1, () => {
      deepThinkListener?.({
        type: "deep_think_activity",
        job_id: job.id,
        activity: "Quatro pensadores lendo a web.",
        thinkers: job.thinkers,
      });
    });

    expect(events[0]).toMatchObject({
      type: "deep_think_activity",
      activity: "Quatro pensadores lendo a web.",
    });
    expect(events[0]!.replay).toBeUndefined();
  });

  it("keeps another conversation's round off this stream", async () => {
    const round = deepThinkJob({ status: "running", synthesis: undefined });
    const foreign: DeepThinkJob = {
      id: randomUUID(),
      conversation_id: randomUUID(),
      scenario: "outra conversa",
      status: "running",
      activity: "Quatro pensadores lendo a web.",
      thinkers: [],
      started_at: new Date().toISOString(),
    };
    deepThinkJobs.set(foreign.id, foreign);

    // The foreign event is delivered first and the stream is read until two of
    // our own events arrive: reading one event would abort before a leaked
    // foreign frame was consumed, so the filter could be deleted unnoticed.
    const events = await readEvents(2, () => {
      deepThinkListener?.({
        type: "deep_think_activity",
        job_id: foreign.id,
        activity: "Quatro pensadores lendo a web.",
        thinkers: [],
      });
      deepThinkListener?.({
        type: "deep_think_activity",
        job_id: round.id,
        activity: "Quatro pensadores lendo a web.",
        thinkers: round.thinkers,
      });
      deepThinkListener?.({
        type: "deep_think_activity",
        job_id: round.id,
        activity: "Sintetizando.",
        thinkers: round.thinkers,
      });
    });

    expect(events.map((event) => event.job_id)).toEqual([round.id, round.id]);
  });

  it("subscribes to all three buses on one connection", async () => {
    deepThinkJob();
    await readEvents(1);

    // One EventSource, three registries: a browser cannot end up connected for
    // agent jobs and disconnected for deep-think or web search.
    expect(agentListener).toBeTypeOf("function");
    expect(deepThinkListener).toBeTypeOf("function");
    expect(webSearchListener).toBeTypeOf("function");
  });

  it("still replays pi agent jobs, and still marks them", async () => {
    const id = randomUUID();
    agentJobs.set(id, {
      id,
      conversation_id: conversationId,
      prompt: "explique o modulo",
      cwd: "/srv/explainer",
      status: "done",
      activity: "Pronto.",
      result: "resposta antiga",
      started_at: new Date().toISOString(),
    });

    const [event] = await readEvents(1);
    expect(event).toMatchObject({ type: "done", result: "resposta antiga", replay: true });
  });

  it("replays a finished web search marked as a replay, cost included", async () => {
    const job = webSearchJob({ cost_usd: 0.0123 });

    const [event] = await readEvents(1);

    expect(event).toMatchObject({
      type: "web_search_done",
      job_id: job.id,
      result: "O petroleo subiu. Fontes:\n[1] Exemplo",
      cost_usd: 0.0123,
      // Without this the client narrates an old result on every reconnect.
      replay: true,
    });
  });

  it("replays a failed search as an error, also marked", async () => {
    webSearchJob({ status: "error", activity: "", error: "A busca falhou: boom", result: undefined });

    const [event] = await readEvents(1);

    expect(event).toMatchObject({
      type: "web_search_error",
      error: "A busca falhou: boom",
      replay: true,
    });
  });

  it("leaves the cost off a replayed done search that cost nothing", async () => {
    webSearchJob(); // done, without cost_usd

    const [event] = await readEvents(1);

    expect(event).toMatchObject({ type: "web_search_done", replay: true });
    expect(event).not.toHaveProperty("cost_usd");
  });

  it("replays a cancelled search as an error", async () => {
    webSearchJob({ status: "cancelled", activity: "", error: "Cancelado pelo usuario." });

    const [event] = await readEvents(1);
    expect(event).toMatchObject({ type: "web_search_error", replay: true });
  });

  it("does not replay a search that is still running", async () => {
    webSearchJob({ status: "running", activity: "buscando na web", result: undefined });
    const finished = webSearchJob();

    const [event] = await readEvents(1);
    expect(event).toMatchObject({ job_id: finished.id, type: "web_search_done" });
  });

  it("carries live searches on the same stream, without the replay flag", async () => {
    const job = webSearchJob({ status: "running", activity: "buscando na web", result: undefined });

    const events = await readEvents(1, () => {
      webSearchListener?.({
        type: "web_search_activity",
        job_id: job.id,
        activity: "formatando os resultados",
      });
    });

    expect(events[0]).toMatchObject({
      type: "web_search_activity",
      activity: "formatando os resultados",
    });
    expect(events[0]!.replay).toBeUndefined();
  });

  it("keeps another conversation's search off this stream", async () => {
    const job = webSearchJob({ status: "running", activity: "buscando na web", result: undefined });
    const foreign: WebSearchJob = {
      id: randomUUID(),
      conversation_id: randomUUID(),
      query: "outra conversa",
      status: "running",
      activity: "buscando na web",
      result: undefined,
      started_at: new Date().toISOString(),
    };
    webSearchJobs.set(foreign.id, foreign);

    // The foreign event is delivered first and the stream is read until two of
    // our own events arrive: reading one event would abort before a leaked
    // foreign frame was consumed, so the filter could be deleted unnoticed.
    const events = await readEvents(2, () => {
      webSearchListener?.({
        type: "web_search_activity",
        job_id: foreign.id,
        activity: "formatando os resultados",
      });
      webSearchListener?.({
        type: "web_search_activity",
        job_id: job.id,
        activity: "buscando na web",
      });
      webSearchListener?.({
        type: "web_search_activity",
        job_id: job.id,
        activity: "formatando os resultados",
      });
    });

    expect(events.map((event) => event.job_id)).toEqual([job.id, job.id]);
  });

  it("answers 400 when the conversation_id is not a UUID", async () => {
    const res = await fetch(`${base}/events?conversation_id=nao-eh-uuid`);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: "Invalid conversation_id",
    });
  });

  it("carries a live cancelled search as an error, without the replay flag", async () => {
    // The job sits in the registry as running so the replay loop has nothing to
    // say; the cancel arrives live, the way the registry emits it.
    const job = webSearchJob({ status: "running", activity: "buscando na web", result: undefined });

    const events = await readEvents(1, () => {
      webSearchJobs.set(job.id, { ...job, status: "cancelled", activity: "", error: "Cancelado pelo usuario." });
      webSearchListener?.({
        type: "web_search_error",
        job_id: job.id,
        error: "Cancelado pelo usuario.",
      });
    });

    expect(events[0]).toMatchObject({
      type: "web_search_error",
      error: "Cancelado pelo usuario.",
    });
    expect(events[0]!.replay).toBeUndefined();
  });

  it("carries agent, deep-think and web-search events on the same connection", async () => {
    const agentId = randomUUID();
    agentJobs.set(agentId, {
      id: agentId,
      conversation_id: conversationId,
      prompt: "explique o modulo",
      cwd: "/srv/explainer",
      status: "running",
      activity: "trabalhando",
      started_at: new Date().toISOString(),
    });
    const round = deepThinkJob({ status: "running", synthesis: undefined });
    const search = webSearchJob({ status: "running", result: undefined });

    const events = await readEvents(3, () => {
      agentListener?.({ type: "done", job_id: agentId, result: "resposta do agente" });
      deepThinkListener?.({
        type: "deep_think_activity",
        job_id: round.id,
        activity: "Quatro pensadores lendo a web.",
        thinkers: round.thinkers,
      });
      webSearchListener?.({
        type: "web_search_activity",
        job_id: search.id,
        activity: "formatando os resultados",
      });
    });

    // One EventSource carries all three subsystems; an agent result and a
    // search stage do not need separate connections to reach the browser.
    expect(events.map((event) => event.type)).toEqual([
      "done",
      "deep_think_activity",
      "web_search_activity",
    ]);
  });

  it("cleans up all three subscriptions when the client leaves", async () => {
    webSearchJob(); // a replay so the stream is demonstrably subscribed
    const controller = new AbortController();
    const res = await fetch(`${base}/events?conversation_id=${conversationId}`, {
      signal: controller.signal,
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!buffer.includes("web_search_done")) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }
    expect(webSearchListener).toBeTypeOf("function");

    controller.abort();

    let cleared = false;
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (
        agentListener === null &&
        deepThinkListener === null &&
        webSearchListener === null
      ) {
        cleared = true;
        break;
      }
    }

    // A dead connection must not keep paying for events no browser renders.
    expect(cleared).toBe(true);
  });

  it("writes a keep-alive comment every 25s while the stream is open", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    try {
      webSearchJob();
      const controller = new AbortController();
      const res = await fetch(`${base}/events?conversation_id=${conversationId}`, {
        signal: controller.signal,
      });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!buffer.includes("web_search_done")) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
      }

      vi.advanceTimersByTime(25_000);

      let frame = "";
      while (!frame.includes("keep-alive")) {
        const { value, done } = await reader.read();
        if (done) break;
        frame += decoder.decode(value, { stream: true });
      }
      expect(frame).toContain(": keep-alive");

      controller.abort();
    } finally {
      vi.useRealTimers();
    }
  });
});
