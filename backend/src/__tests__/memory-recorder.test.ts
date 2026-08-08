import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { DeepThinkEvent, DeepThinkJob, MemoryEvent } from "../types/deep-tools.js";

// Set HOME to a temp dir BEFORE any module loads that calls homedir().
// memory-recorder.ts imports memory.ts, which imports sandbox.ts, which freezes
// DATA_ROOT at module level — the same technique memory.test.ts uses, and the
// reason these tests cannot touch the real ~/.local/share/voice-assistant.
const tmpHome = mkdtempSync(join(tmpdir(), "voice-assistant-recorder-test-"));
process.env.HOME = tmpHome;

// No key: nothing in this file may reach the network.
delete process.env.OPENAI_API_KEY;

// deep-think is stubbed rather than driven. Emitting a real `deep_think_done`
// means running a real round, and a round means the network; what this file
// tests is the recorder's reaction to the event, not how the event is produced.
const deepThink = vi.hoisted(() => {
  const listeners = new Set<(event: DeepThinkEvent) => void>();
  const jobs = new Map<string, DeepThinkJob>();

  return {
    listeners,
    jobs,
    /** Synchronous, exactly like the EventEmitter deep-think emits on. */
    emit(event: DeepThinkEvent): void {
      for (const listener of [...listeners]) listener(event);
    },
    subscribe(listener: (event: DeepThinkEvent) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get(id: string): DeepThinkJob | undefined {
      return jobs.get(id);
    },
  };
});

vi.mock("../services/deep-think.js", () => ({
  subscribeDeepThink: deepThink.subscribe,
  getDeepThinkJob: deepThink.get,
}));

const recorder = await import("../services/memory-recorder.js");
const memory = await import("../services/memory.js");

/**
 * Wait for every write already queued for this conversation.
 *
 * `appendMemoryEvents` serialises per conversation from the moment it is called,
 * and the recorder queues its write before its first `await`. So a mutation
 * started after an emission resolves strictly later than that emission's write —
 * which turns "did the listener write?" into a deterministic question instead of
 * a polling one. Passing no fields makes this a no-op mutation.
 */
async function flush(conversationId: string): Promise<void> {
  await memory.setMemoryMeta(conversationId, {});
}

async function eventsOf(conversationId: string): Promise<MemoryEvent[]> {
  const file = await memory.readMemory(conversationId);
  return file?.events ?? [];
}

/** A finished round, registered so the recorder can find its conversation. */
function registerJob(conversationId: string): DeepThinkJob {
  const job: DeepThinkJob = {
    id: randomUUID(),
    conversation_id: conversationId,
    scenario: "Vale a pena migrar?",
    status: "done",
    activity: "concluido",
    thinkers: [],
    started_at: new Date().toISOString(),
  };
  deepThink.jobs.set(job.id, job);
  return job;
}

function doneEvent(
  job: DeepThinkJob,
  extra: Partial<Extract<DeepThinkEvent, { type: "deep_think_done" }>> = {},
): DeepThinkEvent {
  return {
    type: "deep_think_done",
    job_id: job.id,
    synthesis: "Migrar compensa, mas só depois de resolver o gargalo do disco.",
    thinkers: [],
    ...extra,
  };
}

beforeEach(() => {
  // The listener set is deliberately *not* cleared: the recorder holds its own
  // reference to the live subscription, so wiping this behind its back would
  // desync the two. Every test detaches in a `finally` instead.
  deepThink.jobs.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.EXPLAINER_MEMORY_MAX_EVENTS;
});

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("memory-recorder", () => {
  describe("turns", () => {
    it("records both sides of the conversation, in order", async () => {
      const id = randomUUID();

      await recorder.recordTurn(id, "user", "Como isso funciona?");
      await recorder.recordTurn(id, "assistant", "Funciona assim.");

      const events = await eventsOf(id);
      expect(events.map((e) => [e.kind, e.text])).toEqual([
        ["user", "Como isso funciona?"],
        ["assistant", "Funciona assim."],
      ]);
    });

    it("drops a blank turn instead of writing an empty event", async () => {
      const id = randomUUID();

      await recorder.recordTurn(id, "user", "   \n  ");
      await recorder.recordTurn(id, "assistant", "");

      // Nothing was written at all: the file does not even exist yet.
      expect(await memory.readMemory(id)).toBeNull();
    });

    it("stores a reflection as the kind pruning protects", async () => {
      const id = randomUUID();

      await recorder.recordReflection(id, "O gargalo real é o disco.", {
        source: "usuario",
      });

      const events = await eventsOf(id);
      expect(events).toHaveLength(1);
      expect(events[0]!.kind).toBe("reflection");
      expect(events[0]!.text).toBe("O gargalo real é o disco.");
      expect(events[0]!.meta).toEqual({ source: "usuario" });
    });
  });

  describe("tools", () => {
    it("keeps a call and its result adjacent even under a concurrent turn", async () => {
      const id = randomUUID();

      // Both started before either is awaited. A second write for the result
      // would let the turn — queued right after the pair — land between them.
      const exchange = recorder.recordToolExchange(
        id,
        "search_source",
        '{"query":"pipeline"}',
        "achou 3 arquivos",
      );
      const turn = recorder.recordTurn(id, "assistant", "Achei três arquivos.");
      await Promise.all([exchange, turn]);

      const events = await eventsOf(id);
      expect(events.map((e) => e.kind)).toEqual([
        "tool_call",
        "tool_result",
        "assistant",
      ]);
      expect(events[0]!.arguments).toBe('{"query":"pipeline"}');
      expect(events[1]!.output).toBe("achou 3 arquivos");
    });

    it("records a call and a result written separately", async () => {
      const id = randomUUID();

      await recorder.recordToolCall(id, "read_file", '{"path":"a.ts"}');
      await recorder.recordToolResult(id, "read_file", "export const a = 1;");

      const events = await eventsOf(id);
      expect(events.map((e) => [e.kind, e.tool])).toEqual([
        ["tool_call", "read_file"],
        ["tool_result", "read_file"],
      ]);
      // Nothing invented when the caller gives no id.
      expect(events[0]!.meta).toBeUndefined();
      expect(events[1]!.meta).toBeUndefined();
    });

    it("lets a reader reassociate a pair the file interleaved", async () => {
      const id = randomUUID();

      // The exact order the browser produces: it fires a turn's tool calls
      // through `Promise.all`, so the same tool runs twice at once and the
      // second one answers first.
      await recorder.recordToolCall(id, "search_source", '{"q":"PRIMEIRA"}', "call_1");
      await recorder.recordToolCall(id, "search_source", '{"q":"SEGUNDA"}', "call_2");
      await recorder.recordToolResult(id, "search_source", "resposta da SEGUNDA", "call_2");
      await recorder.recordToolResult(id, "search_source", "resposta da PRIMEIRA", "call_1");

      const events = await eventsOf(id);

      // The damage the id exists to undo: the first result in the file belongs
      // to the *second* call, so anyone pairing by position gets it backwards.
      expect(events[0]!.arguments).toContain("PRIMEIRA");
      expect(events[2]!.output).toContain("SEGUNDA");

      const pairs = new Map<string, { args?: string; output?: string }>();
      for (const event of events) {
        const callId = event.meta?.call_id;
        expect(typeof callId).toBe("string");
        const pair = pairs.get(callId as string) ?? {};
        if (event.kind === "tool_call") pair.args = event.arguments;
        else pair.output = event.output;
        pairs.set(callId as string, pair);
      }

      expect(pairs.get("call_1")).toEqual({
        args: '{"q":"PRIMEIRA"}',
        output: "resposta da PRIMEIRA",
      });
      expect(pairs.get("call_2")).toEqual({
        args: '{"q":"SEGUNDA"}',
        output: "resposta da SEGUNDA",
      });
    });

    it("does not clip a huge output before memory's own ceiling", async () => {
      const id = randomUUID();
      const huge = "x".repeat(50_000);

      await recorder.recordToolResult(id, "search_source", huge);

      const events = await eventsOf(id);
      const output = events[0]!.output!;
      // memory.ts truncates at MEMORY_MAX_OUTPUT_CHARS and says how much it
      // dropped. Any clipping in the recorder would change that count — this
      // asserts the exact arithmetic of 50 000 - 8 000 rather than "it is long".
      expect(output.startsWith(huge.slice(0, memory.MEMORY_MAX_OUTPUT_CHARS))).toBe(true);
      expect(output).toContain(
        `[truncado: ${50_000 - memory.MEMORY_MAX_OUTPUT_CHARS} caracteres omitidos]`,
      );
    });

    it("names an anonymous tool instead of merging every result under one key", async () => {
      const id = randomUUID();

      await recorder.recordToolResult(id, "  ", "algo aconteceu");

      const events = await eventsOf(id);
      expect(events[0]!.tool).toBe("ferramenta desconhecida");
    });
  });

  describe("a failed write never reaches the route", () => {
    it("swallows and logs an invalid conversation id", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      // `validateMemoryPath` throws on anything that is not a UUID, which is the
      // containment boundary. The route asking for it must still survive.
      await expect(
        recorder.recordTurn("../../etc/passwd", "user", "olá"),
      ).resolves.toBeUndefined();
      await expect(
        recorder.recordToolExchange("not-a-uuid", "read_file", "{}", "conteúdo"),
      ).resolves.toBeUndefined();
      await expect(
        recorder.recordReflection("not-a-uuid", "uma conclusão"),
      ).resolves.toBeUndefined();

      expect(warn).toHaveBeenCalledTimes(3);
    });
  });

  describe("attachDeepThinkToMemory", () => {
    it("stores the synthesis as a reflection and the angles as a note", async () => {
      const id = randomUUID();
      const job = registerJob(id);
      const stop = recorder.attachDeepThinkToMemory();

      try {
        deepThink.emit(
          doneEvent(job, {
            thinkers: [
              { id: "t1", angle: "riscos", status: "done", thinking: "O risco é a migração de dados." },
              { id: "t2", angle: "custo", status: "error", error: "estourou o tempo" },
            ],
          }),
        );
        await flush(id);

        const events = await eventsOf(id);
        expect(events.map((e) => e.kind)).toEqual(["reflection", "note"]);

        const reflection = events[0]!;
        expect(reflection.text).toBe(
          "Migrar compensa, mas só depois de resolver o gargalo do disco.",
        );
        expect(reflection.meta).toEqual({ source: "deep_think", job_id: job.id });

        // The angles are a trace, not ten more reflections competing for the
        // slots pruning reserves and for the resume's twelve.
        expect(events[1]!.text).toContain("riscos: O risco é a migração de dados.");
        expect(events[1]!.text).toContain("custo: falhou — estourou o tempo");
      } finally {
        stop();
      }
    });

    it("carries the reflection into the resume verbatim", async () => {
      const id = randomUUID();
      const job = registerJob(id);
      const stop = recorder.attachDeepThinkToMemory();

      try {
        deepThink.emit(doneEvent(job));
        await flush(id);

        const resume = await memory.buildResume(id);
        expect(resume!.reflections).toEqual([
          "Migrar compensa, mas só depois de resolver o gargalo do disco.",
        ]);
      } finally {
        stop();
      }
    });

    it("ignores a replay, so a reconnect cannot record the same round twice", async () => {
      const id = randomUUID();
      const job = registerJob(id);
      const stop = recorder.attachDeepThinkToMemory();

      try {
        deepThink.emit(doneEvent(job, { replay: true }));
        // Queued after whatever the replay might have started, so this resolving
        // proves the replay wrote nothing rather than merely not having run yet.
        await recorder.recordTurn(id, "user", "e agora?");

        const events = await eventsOf(id);
        expect(events.map((e) => e.kind)).toEqual(["user"]);
      } finally {
        stop();
      }
    });

    it("records a round once even when the same event arrives twice unflagged", async () => {
      const id = randomUUID();
      const job = registerJob(id);
      const stop = recorder.attachDeepThinkToMemory();

      try {
        deepThink.emit(doneEvent(job));
        deepThink.emit(doneEvent(job));
        await flush(id);

        const events = await eventsOf(id);
        expect(events.filter((e) => e.kind === "reflection")).toHaveLength(1);
      } finally {
        stop();
      }
    });

    it("attaches once however many times it is called", async () => {
      const id = randomUUID();
      const job = registerJob(id);

      const first = recorder.attachDeepThinkToMemory();
      const second = recorder.attachDeepThinkToMemory();
      expect(second).toBe(first);
      expect(deepThink.listeners.size).toBe(1);

      try {
        deepThink.emit(doneEvent(job));
        await flush(id);

        const events = await eventsOf(id);
        expect(events.filter((e) => e.kind === "reflection")).toHaveLength(1);
      } finally {
        first();
      }
    });

    it("stops recording once the returned function is called", async () => {
      const id = randomUUID();
      const stop = recorder.attachDeepThinkToMemory();
      stop();
      // Calling it again must be inert rather than throwing or detaching a
      // later subscription.
      stop();
      expect(deepThink.listeners.size).toBe(0);

      const job = registerJob(id);
      deepThink.emit(doneEvent(job));
      await recorder.recordTurn(id, "user", "sozinho");

      const events = await eventsOf(id);
      expect(events.map((e) => e.kind)).toEqual(["user"]);
    });

    it("can be attached again after being stopped", async () => {
      const id = randomUUID();
      recorder.attachDeepThinkToMemory()();
      const stop = recorder.attachDeepThinkToMemory();

      try {
        expect(deepThink.listeners.size).toBe(1);
        const job = registerJob(id);
        deepThink.emit(doneEvent(job));
        await flush(id);

        expect((await eventsOf(id)).filter((e) => e.kind === "reflection")).toHaveLength(1);
      } finally {
        stop();
      }
    });

    it("keeps progress and failures out of the file", async () => {
      const id = randomUUID();
      const job = registerJob(id);
      const stop = recorder.attachDeepThinkToMemory();

      try {
        deepThink.emit({
          type: "deep_think_activity",
          job_id: job.id,
          activity: "planejando os angulos",
          thinkers: [],
        });
        deepThink.emit({
          type: "deep_think_error",
          job_id: job.id,
          error: "a rodada estourou o tempo",
        });
        await recorder.recordTurn(id, "user", "deu certo?");

        const events = await eventsOf(id);
        expect(events.map((e) => e.kind)).toEqual(["user"]);
      } finally {
        stop();
      }
    });

    it("says so when the round's job is gone instead of guessing a conversation", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const stop = recorder.attachDeepThinkToMemory();

      try {
        deepThink.emit({
          type: "deep_think_done",
          job_id: randomUUID(),
          synthesis: "uma conclusão órfã",
          thinkers: [],
        });

        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0]![0])).toContain("has no conversation");
      } finally {
        stop();
      }
    });

    it("records the round even when the synthesis came back empty", async () => {
      const id = randomUUID();
      const job = registerJob(id);
      const stop = recorder.attachDeepThinkToMemory();

      try {
        deepThink.emit(
          doneEvent(job, {
            synthesis: "   ",
            thinkers: [
              { id: "t1", angle: "riscos", status: "done", thinking: "Ainda assim, isso ficou dito." },
            ],
          }),
        );
        await flush(id);

        // No reflection to keep, but the round did happen and its angles are
        // the only trace left of it.
        const events = await eventsOf(id);
        expect(events.map((e) => e.kind)).toEqual(["note"]);
      } finally {
        stop();
      }
    });

    it("is awaitable on its own, for a caller that already holds the event", async () => {
      const id = randomUUID();
      const job = registerJob(id);

      // No subscription involved: `recordDeepThinkEvent` resolves once the write
      // is on disk, which is what a route needs if it must answer *after* the
      // round is recorded rather than fire-and-forget like the boot listener.
      await recorder.recordDeepThinkEvent(doneEvent(job));

      const events = await eventsOf(id);
      expect(events.map((e) => e.kind)).toEqual(["reflection"]);
    });

    it("leaves the round retryable when the write is what failed", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      // A job pointing at a conversation id `validateMemoryPath` rejects: the
      // write fails for a reason that has nothing to do with the event.
      const job = registerJob("not-a-uuid");
      const stop = recorder.attachDeepThinkToMemory();

      try {
        deepThink.emit(doneEvent(job));
        await recorder.recordTurn("not-a-uuid", "user", "queued after it");
        expect(warn).toHaveBeenCalled();

        // The round must not be marked as recorded — nothing retries it, so a
        // burnt id loses the reflection for good. Same job, same event, now
        // with somewhere to land.
        const id = randomUUID();
        job.conversation_id = id;
        deepThink.emit(doneEvent(job));
        await flush(id);

        const events = await eventsOf(id);
        expect(events.map((e) => e.kind)).toEqual(["reflection"]);
        expect(events[0]!.text).toBe(
          "Migrar compensa, mas só depois de resolver o gargalo do disco.",
        );
      } finally {
        stop();
      }
    });

    it("never rejects, whatever type the event's fields arrive with", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);

      // The listener discards this promise with `void`. One rejection escaping
      // is an unhandled rejection, and Node's default
      // `--unhandled-rejections=throw` turns that into a dead backend — so this
      // asserts the absence of a rejection, not merely a resolved value.
      const rejections: string[] = [];
      const collect = (err: unknown): void => {
        rejections.push(err instanceof Error ? err.message : String(err));
      };
      process.on("unhandledRejection", collect);

      const stop = recorder.attachDeepThinkToMemory();
      try {
        // Every shape that reaches a field before the write does. `synthesis`
        // and `thinkers` are typed by `DeepThinkEvent`, but the producer is on
        // the far side of an EventEmitter and nothing checks it at runtime.
        const malformed: unknown[] = [
          { synthesis: 123, thinkers: [] },
          { synthesis: { texto: "objeto" }, thinkers: [] },
          { synthesis: null, thinkers: [] },
          { synthesis: "ok", thinkers: { nao: "iteravel" } },
          { synthesis: "ok", thinkers: 7 },
          { synthesis: "ok", thinkers: [null] },
          { synthesis: "ok", thinkers: ["texto solto"] },
          { synthesis: "ok", thinkers: [{ id: 1, angle: 2, thinking: 3 }] },
        ];

        for (const extra of malformed) {
          const viaListener = registerJob(randomUUID());
          deepThink.emit({
            type: "deep_think_done",
            job_id: viaListener.id,
            ...(extra as object),
          } as DeepThinkEvent);

          // And the form documented as awaitable, which throws straight into a
          // caller this module promises to shield.
          const direct = registerJob(randomUUID());
          await expect(
            recorder.recordDeepThinkEvent({
              type: "deep_think_done",
              job_id: direct.id,
              ...(extra as object),
            } as DeepThinkEvent),
          ).resolves.toBeUndefined();
        }

        // And events that are not objects at all: the guard must not depend on
        // `event` being readable, including from inside its own catch.
        for (const garbage of [null, undefined, 42, "deep_think_done"]) {
          deepThink.emit(garbage as unknown as DeepThinkEvent);
          await expect(
            recorder.recordDeepThinkEvent(garbage as unknown as DeepThinkEvent),
          ).resolves.toBeUndefined();
        }

        // An unhandled rejection is reported on a later macrotask, once the
        // microtask queue has drained with no handler attached.
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(rejections).toEqual([]);
      } finally {
        stop();
        process.off("unhandledRejection", collect);
      }
    });

    it("drops only the field that is unreadable, not the round", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);

      const withBadSynthesis = randomUUID();
      const bad = registerJob(withBadSynthesis);
      await recorder.recordDeepThinkEvent({
        type: "deep_think_done",
        job_id: bad.id,
        thinkers: [{ id: "t1", angle: "riscos", status: "done", thinking: "O risco é o disco." }],
        synthesis: 42,
      } as unknown as DeepThinkEvent);

      // The angles are still worth keeping; only the unreadable field is gone.
      const first = await eventsOf(withBadSynthesis);
      expect(first.map((e) => e.kind)).toEqual(["note"]);
      expect(first[0]!.text).toContain("riscos: O risco é o disco.");

      const withBadThinkers = randomUUID();
      const other = registerJob(withBadThinkers);
      await recorder.recordDeepThinkEvent({
        type: "deep_think_done",
        job_id: other.id,
        synthesis: "A conclusão sobrevive.",
        thinkers: { nao: "iteravel" },
      } as unknown as DeepThinkEvent);

      const second = await eventsOf(withBadThinkers);
      expect(second.map((e) => e.kind)).toEqual(["reflection"]);
      expect(second[0]!.text).toBe("A conclusão sobrevive.");
    });

    it("writes nothing at all for a round with neither synthesis nor thinking", async () => {
      const id = randomUUID();
      const job = registerJob(id);
      const stop = recorder.attachDeepThinkToMemory();

      try {
        deepThink.emit(doneEvent(job, { synthesis: "", thinkers: [] }));
        expect(await memory.readMemory(id)).toBeNull();
      } finally {
        stop();
      }
    });
  });
});
