import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Conversation, ResolvedSource } from "../types/index.js";

// The store persists into conversation JSON; only the disk half is faked, so the
// list semantics and the legacy migration are exercised for real.
const stored: { conv: Conversation | null } = { conv: null };

vi.mock("../services/storage.js", () => ({
  getConversation: async () => stored.conv,
  updateConversation: async (_id: string, patch: Partial<Conversation>) => {
    stored.conv = { ...(stored.conv as Conversation), ...patch };
    return stored.conv;
  },
}));

const { addSource, forgetSources, listSources, pickSource, removeSource, MAX_MATERIALS } =
  await import("../services/source-store.js");

const CONV = "550e8400-e29b-41d4-a716-446655440000";

function material(overrides: Partial<ResolvedSource> = {}): ResolvedSource {
  return {
    id: overrides.id ?? `id-${Math.random().toString(36).slice(2, 8)}`,
    kind: "repo",
    label: "algum-repo",
    root: "/tmp/algum-repo",
    origin: "https://github.com/dono/algum-repo",
    resolved_at: new Date().toISOString(),
    ...overrides,
  };
}

function blankConversation(metadata: Record<string, unknown> = {}): Conversation {
  return {
    id: CONV,
    title: "Nova conversa",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    messages: [],
    attachments: [],
    metadata,
  };
}

beforeEach(() => {
  forgetSources(CONV);
  stored.conv = blankConversation();
});

describe("addSource / listSources", () => {
  it("accumulates materials in the order they were added", async () => {
    await addSource(CONV, material({ id: "a", label: "primeiro" }));
    const sources = await addSource(CONV, material({ id: "b", label: "segundo", origin: "x" }));

    expect(sources.map((s) => s.label)).toEqual(["primeiro", "segundo"]);
    expect(await listSources(CONV)).toHaveLength(2);
  });

  it("replaces a material added twice instead of duplicating it", async () => {
    // Re-adding the same repository is how a user asks for a refresh.
    await addSource(CONV, material({ id: "a", label: "antigo" }));
    const sources = await addSource(CONV, material({ id: "b", label: "novo" }));

    expect(sources).toHaveLength(1);
    expect(sources[0]?.label).toBe("novo");
  });

  it("treats the machine docs as a single material", async () => {
    await addSource(CONV, material({ kind: "machine", label: "Este computador", origin: "/a" }));
    const sources = await addSource(
      CONV,
      material({ kind: "machine", label: "Este computador", origin: "/b" }),
    );
    expect(sources).toHaveLength(1);
  });

  it("refuses to go past the limit", async () => {
    for (let i = 0; i < MAX_MATERIALS; i++) {
      await addSource(CONV, material({ id: `m${i}`, origin: `origin-${i}` }));
    }
    await expect(
      addSource(CONV, material({ id: "one-too-many", origin: "extra" })),
    ).rejects.toThrow(/no máximo/i);
  });
});

describe("removeSource", () => {
  it("drops exactly the material asked for", async () => {
    await addSource(CONV, material({ id: "a", origin: "a" }));
    await addSource(CONV, material({ id: "b", origin: "b" }));

    const sources = await removeSource(CONV, "a");
    expect(sources.map((s) => s.id)).toEqual(["b"]);
  });

  it("is a no-op for an id that is not there", async () => {
    await addSource(CONV, material({ id: "a", origin: "a" }));
    expect(await removeSource(CONV, "ghost")).toHaveLength(1);
  });
});

describe("legacy metadata", () => {
  it("reads a conversation saved before materials could be plural", async () => {
    stored.conv = blankConversation({
      source: {
        kind: "machine",
        label: "Este computador",
        root: "/home/x/Projects/config",
        resolved_at: new Date().toISOString(),
      },
    });

    const sources = await listSources(CONV);
    expect(sources).toHaveLength(1);
    // Records from before ids existed still need one to be removable.
    expect(sources[0]?.id).toBeTruthy();
  });
});

describe("pickSource", () => {
  const sources = [
    material({ id: "aaa", label: "meu-repo", origin: "https://github.com/x/meu-repo" }),
    material({ id: "bbb", label: "Este computador", kind: "machine", origin: "/cfg" }),
  ];

  it("defaults to the first material", () => {
    expect(pickSource(sources, undefined)?.id).toBe("aaa");
    expect(pickSource(sources, "")?.id).toBe("aaa");
  });

  it("matches by id, position, label and kind", () => {
    expect(pickSource(sources, "bbb")?.id).toBe("bbb");
    expect(pickSource(sources, "2")?.id).toBe("bbb");
    expect(pickSource(sources, "Este computador")?.id).toBe("bbb");
    expect(pickSource(sources, "machine")?.id).toBe("bbb");
    expect(pickSource(sources, "meu-repo")?.id).toBe("aaa");
  });

  it("falls back to the first material rather than failing the tool call", () => {
    // The reference comes from a model, so "whatever it said" is a real input.
    expect(pickSource(sources, "o de ontem")?.id).toBe("aaa");
  });

  it("returns null only when there is nothing at all", () => {
    expect(pickSource([], "anything")).toBeNull();
  });
});
