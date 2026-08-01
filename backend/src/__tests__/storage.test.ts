import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Message, Attachment } from "../types/index.js";

// Set HOME to a temp dir BEFORE any module loads that calls homedir().
// The storage module imports sandbox.ts which calls homedir() at module level.
const tmpHome = mkdtempSync(join(tmpdir(), "voice-assistant-test-"));
process.env.HOME = tmpHome;

// Now import — the module resolves DATA_ROOT using process.env.HOME
const storage = await import("../services/storage.js");

function makeMessage(role: Message["role"], content: string): Message {
  return {
    id: randomUUID(),
    role,
    content,
    timestamp: new Date().toISOString(),
  };
}

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("storage", () => {
  describe("createConversation", () => {
    it("returns Conversation with id, title, empty messages/attachments", async () => {
      const conv = await storage.createConversation("Test Conversation");
      expect(conv).toHaveProperty("id");
      expect(conv.id).toBeTruthy();
      expect(conv.title).toBe("Test Conversation");
      expect(conv.messages).toEqual([]);
      expect(conv.attachments).toEqual([]);
      expect(conv.created_at).toBeTruthy();
      expect(conv.updated_at).toBeTruthy();
    });
  });

  describe("getConversation", () => {
    it("returns the created conversation", async () => {
      const conv = await storage.createConversation("Find Me");
      const found = await storage.getConversation(conv.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(conv.id);
      expect(found!.title).toBe("Find Me");
    });

    it("returns null for a valid UUID that does not exist", async () => {
      const nonexistentId = randomUUID();
      const result = await storage.getConversation(nonexistentId);
      expect(result).toBeNull();
    });
  });

  describe("appendMessages", () => {
    it("appends messages to the conversation", async () => {
      const conv = await storage.createConversation("Msg Test");
      const msg = makeMessage("user", "Hello world");
      const updated = await storage.appendMessages(conv.id, [msg]);

      expect(updated.messages).toHaveLength(1);
      expect(updated.messages[0]!.content).toBe("Hello world");
      expect(updated.messages[0]!.role).toBe("user");

      // Reload and verify persistence
      const reloaded = await storage.getConversation(conv.id);
      expect(reloaded!.messages).toHaveLength(1);
    });

    it("serializes concurrent appends without clobbering (withConversationLock)", async () => {
      const conv = await storage.createConversation("Lock Test");

      // Fire two concurrent appends
      const [,] = await Promise.all([
        storage.appendMessages(conv.id, [makeMessage("user", "msg-1")]),
        storage.appendMessages(conv.id, [makeMessage("user", "msg-2")]),
      ]);

      // Reload from disk
      const reloaded = await storage.getConversation(conv.id);
      expect(reloaded).not.toBeNull();
      // Both messages should be present — no clobbering
      // Since appends may interleave, the order is not guaranteed, but count must be 2
      expect(reloaded!.messages.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("updateConversation", () => {
    it("updates title, preserves id", async () => {
      const conv = await storage.createConversation("Original");
      const updated = await storage.updateConversation(conv.id, { title: "Updated" });
      expect(updated.title).toBe("Updated");
      expect(updated.id).toBe(conv.id);
    });

    it("deep-merges metadata while preserving existing keys", async () => {
      const conv = await storage.createConversation("Meta Test");

      // Set initial metadata
      const withMeta = await storage.updateConversation(conv.id, {
        metadata: { key1: "val1", key2: "val2" },
      });
      expect(withMeta.metadata).toEqual({ key1: "val1", key2: "val2" });

      // Update: add newKey, keep key1
      const merged = await storage.updateConversation(conv.id, {
        metadata: { newKey: "val" },
      });
      expect(merged.metadata).toEqual({ key1: "val1", key2: "val2", newKey: "val" });
    });

    it("stores summary keys via updateConversation", async () => {
      const conv = await storage.createConversation("Summary Test");
      const updated = await storage.updateConversation(conv.id, {
        metadata: { summary: "This is a summary", summarized_count: 5 },
      });
      expect(updated.metadata!.summary).toBe("This is a summary");
      expect(updated.metadata!.summarized_count).toBe(5);
    });
  });

  describe("appendAttachments", () => {
    it("adds attachment to the conversation", async () => {
      const conv = await storage.createConversation("Attach Test");
      const att: Attachment = {
        id: randomUUID(),
        filename: "doc.pdf",
        original_name: "Document.pdf",
        mime_type: "application/pdf",
        size_bytes: 1024,
        path: "doc.pdf",
        added_at: new Date().toISOString(),
      };

      const updated = await storage.appendAttachments(conv.id, [att]);
      expect(updated.attachments).toHaveLength(1);
      expect(updated.attachments[0]!.filename).toBe("doc.pdf");

      // Reload
      const reloaded = await storage.getConversation(conv.id);
      expect(reloaded!.attachments).toHaveLength(1);
    });
  });

  describe("deleteConversation", () => {
    it("removes the JSON file from disk", async () => {
      const conv = await storage.createConversation("Delete Me");

      // Verify it exists on disk
      const sandbox = await import("../middleware/sandbox.js");
      const filePath = sandbox.validateConversationPath(conv.id);
      expect(existsSync(filePath)).toBe(true);

      await storage.deleteConversation(conv.id);

      // File should be gone
      expect(existsSync(filePath)).toBe(false);

      // getConversation should return null
      const result = await storage.getConversation(conv.id);
      expect(result).toBeNull();
    });
  });

  describe("atomic writes", () => {
    it("writes valid JSON to disk (not half-written)", async () => {
      const conv = await storage.createConversation("Atomic Test");

      // Read the file directly from disk
      const sandbox = await import("../middleware/sandbox.js");
      const filePath = sandbox.validateConversationPath(conv.id);
      const raw = readFileSync(filePath, "utf-8");

      // Must be valid JSON
      const parsed = JSON.parse(raw);
      expect(parsed.id).toBe(conv.id);
      expect(parsed.title).toBe("Atomic Test");
    });
  });

  describe("withConversationLock serialization", () => {
    it("both messages from concurrent appends are present", async () => {
      const conv = await storage.createConversation("Serialize Test");

      await Promise.all([
        storage.appendMessages(conv.id, [makeMessage("user", "concurrent-a")]),
        storage.appendMessages(conv.id, [makeMessage("user", "concurrent-b")]),
      ]);

      const reloaded = await storage.getConversation(conv.id);
      const contents = reloaded!.messages.map((m) => m.content);
      expect(contents).toContain("concurrent-a");
      expect(contents).toContain("concurrent-b");
    });
  });
});
