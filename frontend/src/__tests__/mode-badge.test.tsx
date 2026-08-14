/** @vitest-environment happy-dom */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { ModeBadge } from "@/components/ui/ModeBadge";

// The badge is the same allowlist the picker uses, rendered as a pill: the
// server sends an icon *name*, and the badge resolves it against the list or
// falls back to Sparkles — a mode this build predates looks plain, never
// crashes.

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

function badge(): HTMLSpanElement {
  const found = container?.querySelector("span");
  if (!found) throw new Error("no badge span on screen");
  return found as HTMLSpanElement;
}

function badgeIconClass(): string {
  return badge().querySelector("svg")?.getAttribute("class") ?? "";
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  document.body.innerHTML = "";
});

describe("ModeBadge", () => {
  it("renders the label with the allowlisted icon for its name", async () => {
    await mount(<ModeBadge icon="MessagesSquare" label="Conversa" />);

    expect(container?.textContent).toContain("Conversa");
    expect(badgeIconClass()).toContain("lucide-messages-square");
  });

  it("falls back to Sparkles for a name this build has never seen", async () => {
    await mount(<ModeBadge icon="IconeQueNaoExiste" label="Modo novo" />);

    expect(container?.textContent).toContain("Modo novo");
    expect(badgeIconClass()).toContain("lucide-sparkles");
  });

  it("sizes the pill for the list (xs) and the header (sm)", async () => {
    await mount(<ModeBadge icon="Compass" label="Pesquisa" size="xs" />);
    expect(badge().className).toContain("text-[10px]");
    expect(badgeIconClass()).toContain("size-3");

    await act(async () => root!.unmount());
    await mount(<ModeBadge icon="Compass" label="Pesquisa" size="sm" />);
    expect(badge().className).toContain("text-xs");
    expect(badgeIconClass()).toContain("size-3.5");
  });

  it("carries the optional tooltip", async () => {
    await mount(
      <ModeBadge icon="Sparkles" label="Conversa" title="Modo: Conversa" />,
    );

    expect(badge().getAttribute("title")).toBe("Modo: Conversa");
  });
});
