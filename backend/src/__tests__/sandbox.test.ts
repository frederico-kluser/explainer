import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  isUUID,
  validateConversationPath,
  validateAttachmentPath,
  ensureDir,
  resolveInsideRoot,
  isInsideRoot,
  assertAllowedSourceRoot,
  SandboxError,
} from "../middleware/sandbox.js";

describe("isUUID", () => {
  it("returns true for valid UUID v4", () => {
    // UUID v4 with proper version nibble (4) and variant (8, 9, a, b)
    expect(isUUID("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    expect(isUUID("f47ac10b-58cc-4372-a567-0e02b2c3d479")).toBe(true);
  });

  it("returns false for invalid strings", () => {
    expect(isUUID("hello")).toBe(false);
    expect(isUUID("")).toBe(false);
    expect(isUUID("123")).toBe(false);
    expect(isUUID("not-a-uuid-at-all-folks")).toBe(false);
  });

  it("returns false for a v1 UUID (wrong version nibble)", () => {
    // v1 has '1' in the 13th char position, not '4'
    expect(isUUID("550e8400-e29b-11d4-a716-446655440000")).toBe(false);
  });
});

describe("validateConversationPath", () => {
  it("returns path ending in .json for valid UUID", () => {
    const path = validateConversationPath("550e8400-e29b-41d4-a716-446655440000");
    expect(path.endsWith(".json")).toBe(true);
    expect(path).toContain("conversations");
    expect(path).toContain("550e8400-e29b-41d4-a716-446655440000.json");
  });

  it("throws Error with status 400 for invalid UUID", () => {
    expect(() => validateConversationPath("not-a-uuid")).toThrow();
    try {
      validateConversationPath("not-a-uuid");
    } catch (err: unknown) {
      expect((err as { status: number }).status).toBe(400);
    }
  });

  it("returns conversations directory path (no .json) when convId is undefined", () => {
    const path = validateConversationPath();
    expect(path.endsWith(".json")).toBe(false);
    expect(path.endsWith("conversations")).toBe(true);
    expect(path).toContain("voice-assistant");
  });
});

describe("validateAttachmentPath", () => {
  it("returns path for valid UUID", () => {
    const path = validateAttachmentPath("550e8400-e29b-41d4-a716-446655440000");
    expect(path).toContain("attachments");
    expect(path).toContain("550e8400-e29b-41d4-a716-446655440000");
  });

  it("throws SandboxError for '../etc/passwd' filename (assertPlainFilename)", () => {
    expect(() =>
      validateAttachmentPath(
        "550e8400-e29b-41d4-a716-446655440000",
        "../etc/passwd",
      ),
    ).toThrow("Invalid filename");
  });

  it("throws SandboxError for empty string filename (assertPlainFilename)", () => {
    expect(() =>
      validateAttachmentPath(
        "550e8400-e29b-41d4-a716-446655440000",
        "",
      ),
    ).toThrow();
  });

  it("does not throw for valid filename", () => {
    expect(() =>
      validateAttachmentPath(
        "550e8400-e29b-41d4-a716-446655440000",
        "report.pdf",
      ),
    ).not.toThrow();
  });
});

describe("ensureDir", () => {
  it("creates a directory that does not exist", async () => {
    const tmpBase = mkdtempSync(join(tmpdir(), "sandbox-test-"));
    const newDir = join(tmpBase, "nested", "path");

    try {
      await ensureDir(newDir);
      // Verify by checking if the dir exists (no stat needed — ensureDir returns successfully)
      const { statSync, existsSync } = await import("node:fs");
      expect(existsSync(newDir)).toBe(true);
      const s = statSync(newDir);
      expect(s.isDirectory()).toBe(true);
    } finally {
      rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it("succeeds silently when directory already exists", async () => {
    const tmpBase = mkdtempSync(join(tmpdir(), "sandbox-test-"));
    try {
      await ensureDir(tmpBase); // first call creates
      await ensureDir(tmpBase); // second call should not throw
      const { existsSync } = await import("node:fs");
      expect(existsSync(tmpBase)).toBe(true);
    } finally {
      rmSync(tmpBase, { recursive: true, force: true });
    }
  });
});

describe("resolveInsideRoot", () => {
  it("resolves a relative path against the root", () => {
    expect(resolveInsideRoot("/srv/repo", "src/index.ts")).toBe(
      "/srv/repo/src/index.ts",
    );
  });

  it("treats a leading slash as relative rather than absolute", () => {
    // Without stripping it, resolve() would ignore the root entirely.
    expect(resolveInsideRoot("/srv/repo", "/etc/passwd")).toBe(
      "/srv/repo/etc/passwd",
    );
  });

  it("refuses traversal out of the root", () => {
    expect(() => resolveInsideRoot("/srv/repo", "../../etc/passwd")).toThrow(
      SandboxError,
    );
    expect(() => resolveInsideRoot("/srv/repo", "src/../../../etc")).toThrow(
      SandboxError,
    );
  });

  it("refuses NUL bytes", () => {
    expect(() => resolveInsideRoot("/srv/repo", "a\0b")).toThrow(SandboxError);
  });
});

describe("isInsideRoot", () => {
  it("does not treat a sibling with a shared prefix as inside", () => {
    expect(isInsideRoot("/srv/repo", "/srv/repo-evil/file")).toBe(false);
    expect(isInsideRoot("/srv/repo", "/srv/repo/file")).toBe(true);
    expect(isInsideRoot("/srv/repo", "/srv/repo")).toBe(true);
  });
});

describe("assertAllowedSourceRoot", () => {
  it("accepts a directory under ~/Projects", () => {
    const dir = join(homedir(), "Projects", "anything");
    expect(assertAllowedSourceRoot(dir)).toBe(dir);
  });

  it("rejects a directory outside every allowed root", () => {
    expect(() => assertAllowedSourceRoot("/etc")).toThrow(SandboxError);
  });
});
