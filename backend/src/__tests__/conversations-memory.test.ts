import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { Conversation } from "../types/index.js";

// HOME before the first import: sandbox.ts freezes the data root at module load
// and both storage and memory write through it.
const tmpHome = mkdtempSync(join(tmpdir(), "explainer-conversations-memory-"));
process.env.HOME = tmpHome;
delete process.env.OPENAI_API_KEY;

const express = (await import("express")).default;
const conversationsRouter = (await import("../routes/conversations.js")).default;
const { errorHandler } = await import("../middleware/error-handler.js");
const memory = await import("../services/memory.js");

const app = express();
app.use(express.json());
app.use("/api/conversations", conversationsRouter);
app.use(errorHandler);

const server: Server = app.listen(0);
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}/api/conversations`;

afterAll(() => {
  server.close();
  rmSync(tmpHome, { recursive: true, force: true });
});

async function newConversation(): Promise<string> {
  const res = await fetch(base, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Conversa de teste" }),
  });
  return ((await res.json()) as Conversation).id;
}

async function postMessages(id: string, messages: unknown[]): Promise<Response> {
  return fetch(`${base}/${id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  });
}

describe("POST /api/conversations/:id/messages", () => {
  it("writes each spoken turn into the conversation file", async () => {
    const id = await newConversation();

    // Before the first turn the file does not exist — which is the state the
    // reviewer measured, and the one this route is supposed to end.
    expect(await memory.readMemory(id)).toBeNull();

    const res = await postMessages(id, [
      { role: "user", content: "Me explica o sandbox." },
      { role: "assistant", content: "Ele contem todo caminho que o modelo escolhe." },
    ]);
    expect(res.status).toBe(201);

    const file = await memory.readMemory(id);
    expect(file?.events).toHaveLength(2);
    expect(file?.events.map((event) => [event.kind, event.text])).toEqual([
      ["user", "Me explica o sandbox."],
      ["assistant", "Ele contem todo caminho que o modelo escolhe."],
    ]);
  });

  it("keeps the turns in the order they were spoken", async () => {
    const id = await newConversation();

    await postMessages(id, [
      { role: "user", content: "primeira" },
      { role: "assistant", content: "segunda" },
      { role: "user", content: "terceira" },
    ]);

    const file = await memory.readMemory(id);
    expect(file?.events.map((event) => event.text)).toEqual([
      "primeira",
      "segunda",
      "terceira",
    ]);
  });

  it("leaves tool messages to the realtime route, which has the arguments", async () => {
    const id = await newConversation();

    await postMessages(id, [
      { role: "tool", content: "saida de ferramenta" },
      { role: "user", content: "e isso" },
    ]);

    const file = await memory.readMemory(id);
    expect(file?.events).toHaveLength(1);
    expect(file?.events[0]?.kind).toBe("user");
  });

  it("drops a blank turn without being asked to", async () => {
    const id = await newConversation();

    await postMessages(id, [
      { role: "user", content: "   " },
      { role: "assistant", content: null },
      { role: "user", content: "isto conta" },
    ]);

    const file = await memory.readMemory(id);
    expect(file?.events).toHaveLength(1);
    expect(file?.events[0]?.text).toBe("isto conta");
  });
});

describe("DELETE /api/conversations/:id", () => {
  it("forgets the memory along with the conversation", async () => {
    const id = await newConversation();
    await postMessages(id, [{ role: "user", content: "algo dito" }]);
    expect(await memory.readMemory(id)).not.toBeNull();

    const res = await fetch(`${base}/${id}`, { method: "DELETE" });
    expect(res.status).toBe(204);

    // storage.deleteConversation has never heard of the memory file; without the
    // explicit clear it would outlive the conversation on disk forever.
    expect(await memory.readMemory(id)).toBeNull();
  });

  it("deletes a conversation that never had memory", async () => {
    const id = await newConversation();
    const res = await fetch(`${base}/${id}`, { method: "DELETE" });
    expect(res.status).toBe(204);
  });
});
