import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import express from "express";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Message } from "../types/index.js";

// Set HOME to a temp dir BEFORE any module loads that calls homedir().
const tmpHome = mkdtempSync(join(tmpdir(), "voice-assistant-test-conv-"));
process.env.HOME = tmpHome;

// Dynamic imports — sandbox.ts reads HOME at module load.
const storage = await import("../services/storage.js");
const conversationsRouter = await import("../routes/conversations.js");
const { errorHandler } = await import("../middleware/error-handler.js");

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test app
// ---------------------------------------------------------------------------

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/conversations", conversationsRouter.default);
  app.use(errorHandler);

  await new Promise<void>((resolve) => {
    server = createServer(app);
    server.listen(0, () => {
      const addr = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage(
  role: Message["role"],
  content: string,
  timestamp?: string,
): Message {
  return {
    id: randomUUID(),
    role,
    content,
    timestamp: timestamp ?? new Date().toISOString(),
  };
}

async function createConvWithMessages(
  title: string,
  msgs: Message[],
): Promise<string> {
  const conv = await storage.createConversation(title);
  if (msgs.length > 0) {
    await storage.appendMessages(conv.id, msgs);
  }
  return conv.id;
}

async function fetchJSON(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/conversations/:id/messages", () => {
  it("returns messages from a conversation that has them", async () => {
    const msg1 = makeMessage("user", "Olá");
    const msg2 = makeMessage("assistant", "Oi! Como posso ajudar?");
    const convId = await createConvWithMessages("Messages Test", [msg1, msg2]);

    const { status, body } = await fetchJSON(
      `${baseUrl}/api/conversations/${convId}/messages`,
    );

    expect(status).toBe(200);
    const messages = body.messages as Message[];
    expect(messages).toHaveLength(2);
    expect(messages[0]!.content).toBe("Olá");
    expect(messages[1]!.content).toBe("Oi! Como posso ajudar?");
    expect(body.total).toBe(2);
    expect(body.has_more).toBe(false);
  });

  it("returns empty messages array for a fresh conversation", async () => {
    const convId = await createConvWithMessages("Empty Test", []);

    const { status, body } = await fetchJSON(
      `${baseUrl}/api/conversations/${convId}/messages`,
    );

    expect(status).toBe(200);
    expect(body.messages).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.has_more).toBe(false);
  });

  it("returns 404 for a non-existent conversation", async () => {
    const fakeId = randomUUID();
    const { status, body } = await fetchJSON(
      `${baseUrl}/api/conversations/${fakeId}/messages`,
    );

    expect(status).toBe(404);
    expect(body.error).toBe("Conversation not found");
  });

  it("returns 400 for an invalid UUID", async () => {
    const { status } = await fetchJSON(
      `${baseUrl}/api/conversations/not-a-uuid/messages`,
    );

    expect(status).toBe(400);
  });
});

describe("GET /api/conversations/:id/messages pagination", () => {
  it("limits results with ?limit=N", async () => {
    const msgs = [
      makeMessage("user", "msg-1"),
      makeMessage("assistant", "msg-2"),
      makeMessage("user", "msg-3"),
      makeMessage("assistant", "msg-4"),
      makeMessage("user", "msg-5"),
    ];
    const convId = await createConvWithMessages("Limit Test", msgs);

    const { status, body } = await fetchJSON(
      `${baseUrl}/api/conversations/${convId}/messages?limit=2`,
    );

    expect(status).toBe(200);
    const messages = body.messages as Message[];
    expect(messages).toHaveLength(2);
    expect(messages[0]!.content).toBe("msg-1");
    expect(body.total).toBe(5);
    expect(body.has_more).toBe(true);
  });

  it("filters results with ?before=ISO_DATE", async () => {
    const t1 = "2025-01-01T00:00:00.000Z";
    const t2 = "2025-01-02T00:00:00.000Z";
    const t3 = "2025-01-03T00:00:00.000Z";

    const msgs = [
      makeMessage("user", "old", t1),
      makeMessage("assistant", "mid", t2),
      makeMessage("user", "new", t3),
    ];
    const convId = await createConvWithMessages("Before Test", msgs);

    // Only messages before t3 (exclusive)
    const { status, body } = await fetchJSON(
      `${baseUrl}/api/conversations/${convId}/messages?before=${encodeURIComponent(t3)}`,
    );

    expect(status).toBe(200);
    const messages = body.messages as Message[];
    expect(messages).toHaveLength(2);
    expect(messages[0]!.content).toBe("old");
    expect(messages[1]!.content).toBe("mid");
    expect(body.total).toBe(2);
    expect(body.has_more).toBe(false);
  });

  it("combines ?limit and ?before", async () => {
    const t1 = "2025-01-01T00:00:00.000Z";
    const t2 = "2025-01-02T00:00:00.000Z";
    const t3 = "2025-01-03T00:00:00.000Z";
    const t4 = "2025-01-04T00:00:00.000Z";
    const t5 = "2025-01-05T00:00:00.000Z";

    const msgs = [
      makeMessage("user", "oldest", t1),
      makeMessage("assistant", "older", t2),
      makeMessage("user", "mid", t3),
      makeMessage("assistant", "newer", t4),
      makeMessage("user", "newest", t5),
    ];
    const convId = await createConvWithMessages("Combine Test", msgs);

    // Before t5, limit 2 — should return t1, t2 (the oldest two before t5)
    const { status, body } = await fetchJSON(
      `${baseUrl}/api/conversations/${convId}/messages?before=${encodeURIComponent(t5)}&limit=2`,
    );

    expect(status).toBe(200);
    const messages = body.messages as Message[];
    expect(messages).toHaveLength(2);
    expect(messages[0]!.content).toBe("oldest");
    expect(messages[1]!.content).toBe("older");
    expect(body.total).toBe(4); // 4 messages before t5
    expect(body.has_more).toBe(true);
  });

  it("handles invalid limit gracefully by returning all", async () => {
    const msgs = [makeMessage("user", "only")];
    const convId = await createConvWithMessages("BadLimit Test", msgs);

    const { status, body } = await fetchJSON(
      `${baseUrl}/api/conversations/${convId}/messages?limit=xyz`,
    );

    expect(status).toBe(200);
    expect((body.messages as Message[])).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(body.has_more).toBe(false);
  });

  it("handles negative limit gracefully by returning all", async () => {
    const msgs = [makeMessage("user", "only")];
    const convId = await createConvWithMessages("NegLimit Test", msgs);

    const { status, body } = await fetchJSON(
      `${baseUrl}/api/conversations/${convId}/messages?limit=-5`,
    );

    expect(status).toBe(200);
    expect((body.messages as Message[])).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(body.has_more).toBe(false);
  });
});


  it("computes has_more correctly when limit equals the filtered total", async () => {
    const msgs = [
      makeMessage("user", "msg-1"),
      makeMessage("assistant", "msg-2"),
      makeMessage("user", "msg-3"),
    ];
    const convId = await createConvWithMessages("ExactLimit Test", msgs);

    const { status, body } = await fetchJSON(
      `${baseUrl}/api/conversations/${convId}/messages?limit=3`,
    );

    expect(status).toBe(200);
    expect(body.total).toBe(3);
    expect((body.messages as Message[])).toHaveLength(3);
    expect(body.has_more).toBe(false);
  });

  it("computes has_more correctly when limit is larger than total", async () => {
    const msgs = [makeMessage("user", "only")];
    const convId = await createConvWithMessages("OversizeLimit Test", msgs);

    const { status, body } = await fetchJSON(
      `${baseUrl}/api/conversations/${convId}/messages?limit=100`,
    );

    expect(status).toBe(200);
    expect(body.total).toBe(1);
    expect(body.has_more).toBe(false);
  });

  it("returns messages with tool role", async () => {
    const t1 = "2025-06-01T00:00:00.000Z";
    const t2 = "2025-06-01T00:00:01.000Z";
    const t3 = "2025-06-01T00:00:02.000Z";
    const msgs = [
      makeMessage("user", "user msg", t1),
      makeMessage("assistant", undefined as unknown as string, t2),
      makeMessage("tool", "tool result", t3),
    ];
    const convId = await createConvWithMessages("ToolMsg Test", msgs);

    const { status, body } = await fetchJSON(
      `${baseUrl}/api/conversations/${convId}/messages`,
    );

    expect(status).toBe(200);
    const messages = body.messages as Message[];
    expect(messages).toHaveLength(3);
    expect(messages[0]!.role).toBe("user");
    expect(messages[1]!.role).toBe("assistant");
    expect(messages[2]!.role).toBe("tool");
  });

  it("respects before filter with exact boundary timestamp", async () => {
    const t1 = "2025-07-01T10:00:00.000Z";
    const t2 = "2025-07-01T10:00:00.000Z";
    const t3 = "2025-07-01T11:00:00.000Z";

    const msgs = [
      makeMessage("user", "dup-a", t1),
      makeMessage("assistant", "dup-b", t2),
      makeMessage("user", "later", t3),
    ];
    const convId = await createConvWithMessages("BeforeExact Test", msgs);

    const { status, body } = await fetchJSON(
      `${baseUrl}/api/conversations/${convId}/messages?before=${encodeURIComponent(t3)}`,
    );

    expect(status).toBe(200);
    const messages = body.messages as Message[];
    expect(messages).toHaveLength(2);
    expect(messages[0]!.content).toBe("dup-a");
    expect(messages[1]!.content).toBe("dup-b");
  });

  it("returns has_more=true when limit trims the result after before filter", async () => {
    const t1 = "2025-01-01T00:00:00.000Z";
    const t2 = "2025-01-02T00:00:00.000Z";
    const t3 = "2025-01-03T00:00:00.000Z";
    const msgs = [
      makeMessage("user", "a", t1),
      makeMessage("assistant", "b", t2),
      makeMessage("user", "c", t3),
    ];
    const convId = await createConvWithMessages("HasMore Test", msgs);

    const { status, body } = await fetchJSON(
      `${baseUrl}/api/conversations/${convId}/messages?before=${encodeURIComponent(t3)}&limit=1`,
    );

    expect(status).toBe(200);
    const messages = body.messages as Message[];
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toBe("a");
    expect(body.total).toBe(2);
    expect(body.has_more).toBe(true);
  });

  it("ignores before filter when it is an array (not a string)", async () => {
    const msgs = [
      makeMessage("user", "first"),
      makeMessage("assistant", "second"),
    ];
    const convId = await createConvWithMessages("BeforeArray Test", msgs);

    const { status, body } = await fetchJSON(
      `${baseUrl}/api/conversations/${convId}/messages?before=a&before=b`,
    );

    expect(status).toBe(200);
    expect(body.total).toBe(2);
  });

  it("excludes messages matching the before timestamp (exclusive comparison)", async () => {
    const t1 = "2025-11-15T00:00:00.000Z";
    const t2 = "2025-11-16T00:00:00.000Z";

    const msgs = [
      makeMessage("user", "keep", t1),
      makeMessage("assistant", "drop", t2),
    ];
    const convId = await createConvWithMessages("ExclusiveBefore Test", msgs);

    const { status, body } = await fetchJSON(
      `${baseUrl}/api/conversations/${convId}/messages?before=${encodeURIComponent(t2)}`,
    );

    expect(status).toBe(200);
    const messages = body.messages as Message[];
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toBe("keep");
    expect(body.total).toBe(1);
    expect(body.has_more).toBe(false);
  });

  it("returns the expected response shape", async () => {
    const msg = makeMessage("user", "shape test");
    const convId = await createConvWithMessages("Shape Test", [msg]);

    const { status, body } = await fetchJSON(
      `${baseUrl}/api/conversations/${convId}/messages`,
    );

    expect(status).toBe(200);
    expect(body).toHaveProperty("messages");
    expect(body).toHaveProperty("total");
    expect(body).toHaveProperty("has_more");
    expect(Array.isArray(body.messages)).toBe(true);
    expect(typeof body.total).toBe("number");
    expect(typeof body.has_more).toBe("boolean");
  });
describe("GET /api/conversations/:id (includes messages)", () => {
  it("returns the full conversation with messages array", async () => {
    const msg = makeMessage("user", "Full conv test");
    const convId = await createConvWithMessages("Full Conv", [msg]);

    const { status, body } = await fetchJSON(
      `${baseUrl}/api/conversations/${convId}`,
    );

    expect(status).toBe(200);
    expect(body.id).toBe(convId);
    expect(body.title).toBe("Full Conv");
    const messages = body.messages as Message[];
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toBe("Full conv test");
    expect(messages[0]!.role).toBe("user");
  });
});
