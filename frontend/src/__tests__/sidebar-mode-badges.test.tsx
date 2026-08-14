/** @vitest-environment happy-dom */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { Sidebar } from "@/components/ui/Sidebar";
import type { Conversation } from "@/types";

// The rail's rows used to be indistinguishable — every conversation wore the
// same generic icon. Now the row shows the mode it was created in, resolved
// against the same allowlist the picker renders, and a conversation that
// predates the feature keeps the generic icon byte for byte.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function mount(node: ReactNode): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(node);
  });
}

const CONVERSATIONS: Conversation[] = [
  {
    id: "research-1",
    title: "Rota de fuga",
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    metadata: { mode: "research" },
  },
  {
    id: "legacy-1",
    title: "Anotação antiga",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  },
];

const MODES_BY_ID = new Map<string, { icon: string; label: string }>([
  ["research", { icon: "Compass", label: "Pesquisa" }],
]);

async function mountSidebar(
  modesById?: ReadonlyMap<string, { icon: string; label: string }>,
): Promise<void> {
  await mount(
    <Sidebar
      conversations={CONVERSATIONS}
      activeId={null}
      onSelect={() => {}}
      onCreate={() => {}}
      onDelete={() => {}}
      onRename={() => {}}
      onOpenPalette={() => {}}
      modesById={modesById}
    />,
  );
}

/** The row button whose text is the conversation's title. */
function rowButton(title: string): HTMLButtonElement {
  const found = [...(container?.querySelectorAll("button") ?? [])].find(
    (button) => button.textContent?.includes(title) ?? false,
  );
  if (!found) throw new Error(`no row button for "${title}"`);
  return found as HTMLButtonElement;
}

const PLAIN_TITLE = "Clique para abrir, dois cliques para renomear";

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  document.body.innerHTML = "";
});

describe("Sidebar's per-conversation mode icon", () => {
  it("shows the mode's own icon and title for a known metadata.mode", async () => {
    await mountSidebar(MODES_BY_ID);

    const row = rowButton("Rota de fuga");
    expect(row.getAttribute("title")).toBe(
      "Conversa · Pesquisa — clique para abrir, dois cliques para renomear",
    );
    expect(row.querySelector("svg")?.getAttribute("class") ?? "").toContain(
      "lucide-compass",
    );
  });

  it("keeps the generic icon and the plain title without metadata.mode", async () => {
    await mountSidebar(MODES_BY_ID);

    const row = rowButton("Anotação antiga");
    expect(row.getAttribute("title")).toBe(PLAIN_TITLE);
    expect(row.querySelector("svg")?.getAttribute("class") ?? "").toContain(
      "lucide-message-square",
    );
  });

  it("keeps the generic icon when modesById is absent", async () => {
    await mountSidebar();

    expect(rowButton("Rota de fuga").getAttribute("title")).toBe(PLAIN_TITLE);
    expect(rowButton("Rota de fuga").querySelector("svg")?.getAttribute("class") ?? "").toContain(
      "lucide-message-square",
    );
  });

  it("falls back when the metadata names a mode the map does not have", async () => {
    const unknown = new Map<string, { icon: string; label: string }>();
    await mountSidebar(unknown);

    expect(rowButton("Rota de fuga").getAttribute("title")).toBe(PLAIN_TITLE);
  });
});
