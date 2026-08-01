import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SourceError,
  findPrimaryDoc,
  firstHeading,
  inferKind,
  parseGitHubRef,
  resolveSource,
} from "../services/sources.js";

describe("parseGitHubRef", () => {
  it("parses full GitHub URLs", () => {
    expect(parseGitHubRef("https://github.com/openai/openai-node")).toEqual({
      owner: "openai",
      repo: "openai-node",
      url: "https://github.com/openai/openai-node.git",
    });
  });

  it("strips .git and deep paths", () => {
    expect(parseGitHubRef("https://github.com/vercel/next.js.git")?.repo).toBe(
      "next.js",
    );
    expect(
      parseGitHubRef("https://github.com/vercel/next.js/blob/main/readme.md")?.repo,
    ).toBe("next.js");
  });

  it("accepts owner/repo shorthand", () => {
    expect(parseGitHubRef("openai/openai-node")?.owner).toBe("openai");
  });

  it("rejects local paths", () => {
    expect(parseGitHubRef("/home/user/projects/thing")).toBeNull();
    expect(parseGitHubRef("./relative/path")).toBeNull();
    expect(parseGitHubRef("https://gitlab.com/a/b")).toBeNull();
  });
});

describe("inferKind", () => {
  it("treats a ref as a repo and bare text as markdown", () => {
    expect(inferKind({ kind: "auto" as never, ref: "openai/openai-node" })).toBe("repo");
    expect(inferKind({ kind: "auto" as never, markdown: "# oi" })).toBe("markdown");
  });

  it("honours an explicit kind", () => {
    expect(inferKind({ kind: "machine" })).toBe("machine");
  });
});

describe("firstHeading", () => {
  it("takes the first markdown heading as a label", () => {
    expect(firstHeading("# Titulo\n\ncorpo")).toBe("Titulo");
    expect(firstHeading("corpo sem titulo")).toBeNull();
  });
});

describe("findPrimaryDoc", () => {
  it("prefers README.md, then falls back to the first markdown file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "explainer-src-"));
    try {
      writeFileSync(join(dir, "notes.md"), "# notes");
      expect(await findPrimaryDoc(dir)).toBe(join(dir, "notes.md"));

      writeFileSync(join(dir, "README.md"), "# readme");
      expect(await findPrimaryDoc(dir)).toBe(join(dir, "README.md"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null for a directory with no documents", async () => {
    const dir = mkdtempSync(join(tmpdir(), "explainer-src-"));
    try {
      mkdirSync(join(dir, "src"));
      expect(await findPrimaryDoc(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveSource", () => {
  it("resolves a markdown source and labels it from the first heading", async () => {
    const resolved = await resolveSource({
      kind: "markdown",
      markdown: "# Guia de deploy\n\nPasso um.",
    });
    expect(resolved.kind).toBe("markdown");
    expect(resolved.label).toBe("Guia de deploy");
    expect(resolved.root).toBeUndefined();
  });

  it("rejects an empty markdown source", async () => {
    await expect(resolveSource({ kind: "markdown", markdown: "  " })).rejects.toThrow(
      SourceError,
    );
  });

  it("rejects a repo source with no ref", async () => {
    await expect(resolveSource({ kind: "repo" })).rejects.toThrow(SourceError);
  });

  it("refuses a local directory outside the allowed roots", async () => {
    const dir = mkdtempSync(join(tmpdir(), "explainer-outside-"));
    try {
      writeFileSync(join(dir, "README.md"), "# nope");
      await expect(resolveSource({ kind: "repo", ref: dir })).rejects.toThrow(
        /outside the allowed roots/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
