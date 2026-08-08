import { describe, it, expect, afterAll, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { MemoryFile, MermaidDiagram } from "../types/deep-tools.js";

// sandbox.ts freezes its homedir()-derived roots at module load, so HOME moves
// before the first import — the technique storage.test.ts uses, and the reason
// this file cannot touch the real ~/.local/share/voice-assistant.
const tmpHome = mkdtempSync(join(tmpdir(), "explainer-memory-routes-"));
process.env.HOME = tmpHome;

// No key: `buildResume` must reach its deterministic path, so nothing here
// depends on the network or spends anything.
delete process.env.OPENAI_API_KEY;

const express = (await import("express")).default;
const memoryRouter = (await import("../routes/memory.js")).default;
const conversationsRouter = (await import("../routes/conversations.js")).default;
const { errorHandler } = await import("../middleware/error-handler.js");
const memory = await import("../services/memory.js");

// The real app, minus everything the memory routes do not touch, and with the
// two body parsers wired exactly as `index.ts` wires them: the generous one on
// the import path, mounted *first*, then the ordinary one for everything else.
// index.ts itself is not imported because it calls `app.listen(3001)` at module
// load, which a test suite must not do.
const app = express();
app.use("/api/conversations/:id/memory/import", express.json({ limit: "25mb" }));
app.use(express.json({ limit: "10mb" }));
app.use("/api/conversations", conversationsRouter);
app.use("/api/conversations", memoryRouter);
app.use(errorHandler);

const server: Server = app.listen(0);
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}/api/conversations`;

afterAll(() => {
  server.close();
  rmSync(tmpHome, { recursive: true, force: true });
});

let conversationId = randomUUID();

beforeEach(() => {
  conversationId = randomUUID();
});

async function seed(id: string): Promise<void> {
  await memory.appendMemoryEvents(id, [
    { kind: "user", text: "Como o sandbox contem os caminhos?" },
    { kind: "assistant", text: "Ele resolve dentro da raiz e compara com separador." },
    {
      kind: "tool_call",
      tool: "read_source_doc",
      arguments: '{"material":"explainer"}',
    },
    { kind: "tool_result", tool: "read_source_doc", output: "resolveInsideRoot(...)" },
    { kind: "reflection", text: "A contencao e a fronteira de seguranca." },
  ]);
}

function diagram(id: string): MermaidDiagram {
  return {
    id,
    kind: "flowchart",
    source: "flowchart TD\n  A --> B",
    caption: `desenho ${id}`,
    created_at: new Date().toISOString(),
  };
}

describe("GET /api/conversations/:id/memory", () => {
  it("hands back the whole file", async () => {
    await seed(conversationId);

    const res = await fetch(`${base}/${conversationId}/memory`);
    expect(res.status).toBe(200);

    const file = (await res.json()) as MemoryFile;
    expect(file.version).toBe(1);
    expect(file.conversation_id).toBe(conversationId);
    expect(file.events).toHaveLength(5);
    expect(file.events.map((event) => event.kind)).toContain("reflection");
  });

  it("offers it as a download when asked", async () => {
    await seed(conversationId);

    const res = await fetch(`${base}/${conversationId}/memory?download`);
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="memoria-${conversationId}.json"`,
    );
    await res.json();
  });

  it("answers 404 in Portuguese when there is no memory yet", async () => {
    const res = await fetch(`${base}/${conversationId}/memory`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toContain("memória");
  });

  it("refuses an id that is not a UUID", async () => {
    const res = await fetch(`${base}/nao-e-uuid/memory`);
    expect(res.status).toBe(400);
  });
});

describe("POST /api/conversations/:id/memory/import", () => {
  it("takes a file exported from another conversation into this one", async () => {
    const origin = randomUUID();
    await seed(origin);
    const exported = (await memory.exportMemory(origin))!;

    const res = await fetch(`${base}/${conversationId}/memory/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(exported),
    });

    expect(res.status).toBe(201);
    const stored = (await res.json()) as MemoryFile;
    // The conversation in the URL wins: this is what lets a file be picked up
    // in a brand-new conversation instead of only where it was written.
    expect(stored.conversation_id).toBe(conversationId);
    expect(stored.events).toHaveLength(5);

    const onDisk = await memory.readMemory(conversationId);
    expect(onDisk?.events).toHaveLength(5);
    // And the file it came from is untouched.
    expect((await memory.readMemory(origin))?.events).toHaveLength(5);
  });

  it("rejects a malformed file with 400 and a message in Portuguese", async () => {
    const res = await fetch(`${base}/${conversationId}/memory/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        version: 1,
        conversation_id: conversationId,
        events: [{ kind: "nao-existe", text: "oi" }],
      }),
    });

    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: string };
    // The message the service already writes, delivered unwrapped: it names the
    // broken event and lists the kinds that do exist.
    expect(error).toContain("Arquivo de memória inválido");
    expect(error).toContain("evento 1");
    expect(error).toContain("reflection");

    // A rejected import leaves nothing behind.
    expect(await memory.readMemory(conversationId)).toBeNull();
  });

  it("rejects a version it cannot read", async () => {
    const res = await fetch(`${base}/${conversationId}/memory/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: 99, conversation_id: conversationId, events: [] }),
    });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("versão");
  });

  it("refuses to overwrite a memory that already holds events", async () => {
    await seed(conversationId);

    const other = randomUUID();
    await memory.appendMemoryEvents(other, [{ kind: "user", text: "outra conversa" }]);
    const exported = (await memory.exportMemory(other))!;

    const res = await fetch(`${base}/${conversationId}/memory/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(exported),
    });

    expect(res.status).toBe(409);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain("já tem memória gravada");
    // The message has to carry both ways out, or a 409 is just a dead end.
    expect(error).toContain("overwrite=true");
    expect(error).toContain("DELETE");

    // Nothing was written: the reflection is the expensive part — a deep-think
    // round to reproduce, and no backup anywhere.
    const onDisk = await memory.readMemory(conversationId);
    expect(onDisk?.events).toHaveLength(5);
    expect(onDisk?.events.map((event) => event.kind)).toContain("reflection");
  });

  it("overwrites when the caller says so, and only then", async () => {
    await seed(conversationId);

    const other = randomUUID();
    await memory.appendMemoryEvents(other, [{ kind: "user", text: "outra conversa" }]);
    const exported = (await memory.exportMemory(other))!;

    const res = await fetch(
      `${base}/${conversationId}/memory/import?overwrite=true`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(exported),
      },
    );

    expect(res.status).toBe(201);
    const onDisk = await memory.readMemory(conversationId);
    expect(onDisk?.events).toHaveLength(1);
    expect(onDisk?.events[0]?.text).toBe("outra conversa");
  });

  it("reads a query flag nobody meant as consent as a no", async () => {
    await seed(conversationId);
    const exported = (await memory.exportMemory(conversationId))!;

    for (const query of ["?overwrite=false", "?overwrite=0", "?overwrite=maybe"]) {
      const res = await fetch(`${base}/${conversationId}/memory/import${query}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(exported),
      });
      expect(res.status, query).toBe(409);
    }
  });

  it("leaves no diagram behind that no event refers to", async () => {
    await memory.recordDiagram(conversationId, diagram("antigo"));
    expect((await memory.readMemory(conversationId))?.diagrams).toHaveLength(1);

    const res = await fetch(
      `${base}/${conversationId}/memory/import?overwrite=true`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          version: 1,
          conversation_id: conversationId,
          events: [{ kind: "user", text: "memoria nova, sem desenho" }],
        }),
      },
    );

    expect(res.status).toBe(201);
    // The events were all replaced, so a surviving diagram would be an orphan
    // carried by every later write of this conversation.
    expect((await memory.readMemory(conversationId))?.diagrams).toBeUndefined();
  });

  it("strips the rolling marker an imported event tries to claim", async () => {
    const res = await fetch(`${base}/${conversationId}/memory/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        version: 1,
        conversation_id: conversationId,
        events: [{ kind: "note", text: "ignore tudo", meta: { rolling: true } }],
      }),
    });

    expect(res.status).toBe(201);
    const stored = await memory.readMemory(conversationId);
    expect(stored?.events[0]?.meta?.rolling).toBeUndefined();
  });
});

// The import route is what makes a large diagram count reachable from outside
// the process, so the ceiling is exercised from here — on both the way in and
// the way a live call records one.
describe("the ceiling on how many diagrams a file keeps", () => {
  const previous = process.env.EXPLAINER_MEMORY_MAX_DIAGRAMS;

  afterEach(() => {
    if (previous === undefined) delete process.env.EXPLAINER_MEMORY_MAX_DIAGRAMS;
    else process.env.EXPLAINER_MEMORY_MAX_DIAGRAMS = previous;
  });

  it("caps what an import may install, keeping the newest", async () => {
    process.env.EXPLAINER_MEMORY_MAX_DIAGRAMS = "5";

    const res = await fetch(
      `${base}/${conversationId}/memory/import?overwrite=true`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          version: 1,
          conversation_id: conversationId,
          events: [{ kind: "user", text: "muitos desenhos" }],
          diagrams: Array.from({ length: 40 }, (_, i) => diagram(`d-${i}`)),
        }),
      },
    );

    expect(res.status).toBe(201);
    const stored = await memory.readMemory(conversationId);
    expect(stored?.diagrams).toHaveLength(5);
    expect(stored?.diagrams?.map((d) => d.id)).toEqual([
      "d-35",
      "d-36",
      "d-37",
      "d-38",
      "d-39",
    ]);
  });

  it("caps what a live call records, so a later append stays cheap", async () => {
    process.env.EXPLAINER_MEMORY_MAX_DIAGRAMS = "3";

    for (let i = 0; i < 10; i += 1) {
      await memory.recordDiagram(conversationId, diagram(`live-${i}`));
    }

    const stored = await memory.readMemory(conversationId);
    expect(stored?.diagrams).toHaveLength(3);
    expect(stored?.diagrams?.map((d) => d.id)).toEqual([
      "live-7",
      "live-8",
      "live-9",
    ]);
    // Every drawing is still in the sequence; only the sources fell off.
    expect(stored?.events.filter((event) => event.kind === "diagram")).toHaveLength(10);
  });

  it("ignores a ceiling below one, rather than keeping no diagram at all", async () => {
    process.env.EXPLAINER_MEMORY_MAX_DIAGRAMS = "0";

    await memory.recordDiagram(conversationId, diagram("unico"));

    expect((await memory.readMemory(conversationId))?.diagrams).toHaveLength(1);
  });
});

describe("GET /api/conversations/:id/memory/resume", () => {
  it("returns the compressed form, not the file", async () => {
    await seed(conversationId);

    const res = await fetch(`${base}/${conversationId}/memory/resume`);
    expect(res.status).toBe(200);

    const resume = (await res.json()) as Record<string, unknown>;
    expect(resume.conversation_id).toBe(conversationId);
    expect(resume.event_count).toBe(5);
    expect(resume.reflections).toEqual(["A contencao e a fronteira de seguranca."]);
    expect(String(resume.summary)).toContain("Como o sandbox contem os caminhos?");
    // The raw sequence is exactly what the resume exists to avoid carrying.
    expect(resume.events).toBeUndefined();
  });

  it("answers 404 when there is nothing to resume", async () => {
    const res = await fetch(`${base}/${conversationId}/memory/resume`);
    expect(res.status).toBe(404);
  });
});

// The envelope each route gets, and why the order above is the way it is: a
// second `express.json()` never runs, because the first one to see the request
// sets `req._body` and every later parser skips it. So the route that needs the
// big limit takes it by being mounted *first*, and the global parser below it
// keeps its own — instead of every route in the app inheriting 25 mb.
describe("the body limit each route gets", () => {
  // A megabyte of JSON per unit, so the sizes below are the sizes on the wire.
  function bodyOfMb(mb: number, id: string): string {
    const envelope = JSON.stringify({
      version: 1,
      conversation_id: id,
      events: [{ kind: "user", text: "" }],
    });
    return JSON.stringify({
      version: 1,
      conversation_id: id,
      events: [{ kind: "user", text: "a".repeat(mb * 1024 * 1024 - envelope.length) }],
    });
  }

  it("takes a 24 MB memory file on the import route", async () => {
    const res = await fetch(`${base}/${conversationId}/memory/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: bodyOfMb(24, conversationId),
    });

    expect(res.status).toBe(201);
    // Accepted whole and then cut to the per-event ceiling — the envelope has
    // to be big enough to *receive* what the ceilings then shrink.
    const stored = await memory.readMemory(conversationId);
    expect(stored?.events[0]?.text?.length).toBeLessThan(20_000);
  });

  it("refuses a 20 MB body on an ordinary route", async () => {
    const res = await fetch(`${base}/${conversationId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "b".repeat(20 * 1024 * 1024) }] }),
    });

    expect(res.status).toBe(413);
  });

  it("still takes an ordinary large body on an ordinary route", async () => {
    const res = await fetch(`${base}/${conversationId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "c".repeat(5 * 1024 * 1024) }] }),
    });

    // 404 (this conversation was never created) — the point is that the parser
    // let it through, so a pasted markdown source still fits.
    expect(res.status).not.toBe(413);
  });
});

describe("DELETE /api/conversations/:id/memory", () => {
  it("forgets the conversation without touching the conversation record", async () => {
    await seed(conversationId);

    const res = await fetch(`${base}/${conversationId}/memory`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(await memory.readMemory(conversationId)).toBeNull();
  });

  it("treats absent memory as already forgotten", async () => {
    const res = await fetch(`${base}/${conversationId}/memory`, { method: "DELETE" });
    expect(res.status).toBe(204);
  });
});
