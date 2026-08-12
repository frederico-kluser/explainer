import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// The store on a real disk. `document-tools.test.ts` fakes this module to test
// the editing; this file exists for the half that a fake cannot reproduce — the
// per-conversation lock, and what happens when two writers reach one file.
//
// `sandbox.ts` freezes its roots from `homedir()` at module load, so the temp
// HOME has to be set before the import below.
const tmpHome = mkdtempSync(join(tmpdir(), "explainer-document-store-"));
process.env.HOME = tmpHome;

const {
  DOCUMENT_MAX_CHARS,
  appendDocument,
  deleteDocument,
  readDocument,
  updateDocument,
  writeDocument,
} = await import("../services/document-store.js");

let CONV = randomUUID();

beforeEach(() => {
  CONV = randomUUID();
});

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("the basics", () => {
  it("answers null for a conversation that never wrote one", async () => {
    expect(await readDocument(CONV)).toBeNull();
  });

  it("refuses an id that is not a UUID", async () => {
    // The id reaches this module from a route parameter and from a tool call,
    // so it is the one value here that a caller does not control.
    await expect(readDocument("../../etc/passwd")).rejects.toThrow();
  });

  it("round-trips, replaces, and deletes", async () => {
    await writeDocument(CONV, "# Um");
    expect(await readDocument(CONV)).toBe("# Um");

    await writeDocument(CONV, "# Dois");
    expect(await readDocument(CONV)).toBe("# Dois");

    await deleteDocument(CONV);
    expect(await readDocument(CONV)).toBeNull();
    // Deleting what is already gone is not an error.
    await expect(deleteDocument(CONV)).resolves.toBeUndefined();
  });

  it("truncates at the ceiling and says so in the document", async () => {
    const stored = await writeDocument(CONV, "x".repeat(DOCUMENT_MAX_CHARS + 500));

    expect(stored).toContain("truncado");
    expect(stored).toContain("500");
    expect(await readDocument(CONV)).toBe(stored);
  });
});

describe("the lock", () => {
  it("appends without deadlocking on itself", async () => {
    // THE REGRESSION. `withDocumentLock` chains each operation onto the
    // previous one, so it is not reentrant: `appendDocument` used to call
    // `writeDocument` from inside its own critical section and wait forever on
    // a promise that only resolves when it returns. No error, no timeout — the
    // request never answered. Every locked entry point must wrap the unlocked
    // core, never another entry point.
    await writeDocument(CONV, "# Roteiro");

    await expect(appendDocument(CONV, "## Slides")).resolves.toContain("## Slides");
    expect(await readDocument(CONV)).toBe("# Roteiro\n\n## Slides");
  });

  it("appends to a conversation that had no document", async () => {
    expect(await appendDocument(CONV, "## Slides")).toBe("## Slides");
  });

  it("does not deadlock when a transform is what runs inside the lock", async () => {
    await expect(
      updateDocument(CONV, (current) => `${current ?? ""}ok`),
    ).resolves.toBe("ok");
  });

  it("loses no write when three land at once", async () => {
    // Three writers really do reach this file: the model, this browser, and
    // anybody else with the conversation open. A read-modify-write done outside
    // the lock drops all but the last.
    await writeDocument(CONV, "0");

    await Promise.all([
      appendDocument(CONV, "um"),
      appendDocument(CONV, "dois"),
      appendDocument(CONV, "tres"),
    ]);

    const final = (await readDocument(CONV)) ?? "";
    for (const word of ["um", "dois", "tres"]) {
      expect(final, word).toContain(word);
    }
  });

  it("keeps two conversations out of each other's way", async () => {
    const other = randomUUID();

    await Promise.all([
      writeDocument(CONV, "# Aqui"),
      writeDocument(other, "# Ali"),
    ]);

    expect(await readDocument(CONV)).toBe("# Aqui");
    expect(await readDocument(other)).toBe("# Ali");
  });

  it("survives a failed operation without wedging the queue", async () => {
    // The chain runs the next operation whether or not the previous one
    // rejected; a lock that only advanced on success would strand every later
    // write on this conversation.
    await expect(
      updateDocument(CONV, () => {
        throw new Error("transform ruim");
      }),
    ).rejects.toThrow("transform ruim");

    await expect(writeDocument(CONV, "# depois")).resolves.toBe("# depois");
  });
});
