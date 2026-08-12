/** @vitest-environment happy-dom */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DocumentSidebar } from "@/components/ui/DocumentSidebar";
import { MIN_WIDTH, WIDTH_KEY, maxWidth } from "@/components/ui/document-sidebar";

// The three shells the pane has — dragged open on a desktop, collapsed to a
// rail, and a full overlay on a phone — plus the part of the drag a suite
// without a pointer can still reach: the keyboard, which is also the only way
// somebody who cannot hold a mouse button resizes it at all.

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

function separator(): HTMLElement {
  const found = document.querySelector('[role="separator"]');
  if (!found) throw new Error("no separator on screen");
  return found as HTMLElement;
}

function pane(): HTMLElement {
  const found = document.querySelector("aside");
  if (!found) throw new Error("no pane on screen");
  return found as HTMLElement;
}

function buttonLabelled(label: string): HTMLButtonElement {
  const found = document.querySelector(`[aria-label="${label}"]`);
  if (!found) throw new Error(`no control labelled ${label}`);
  return found as HTMLButtonElement;
}

async function press(key: string): Promise<void> {
  await act(async () => {
    separator().dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  });
}

const PROPS = {
  conversationId: "550e8400-e29b-41d4-a716-446655440000",
  title: "Roteiro",
  placeholder: "O roteiro aparece aqui.",
  content: "# Roteiro\n\n## Slides\n",
  onContentChange: () => {},
  compact: false,
};

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  });
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("the pane on a desktop", () => {
  it("is a labelled separator a keyboard can move", async () => {
    await mount(<DocumentSidebar {...PROPS} open onOpenChange={() => {}} />);

    const handle = separator();
    expect(handle.getAttribute("aria-orientation")).toBe("vertical");
    expect(handle.getAttribute("tabindex")).toBe("0");

    const before = Number(handle.getAttribute("aria-valuenow"));
    await press("ArrowLeft");
    expect(Number(separator().getAttribute("aria-valuenow"))).toBeGreaterThan(before);

    await press("ArrowRight");
    await press("ArrowRight");
    expect(Number(separator().getAttribute("aria-valuenow"))).toBeLessThan(before);
  });

  it("stops at both ends rather than swallowing the transcript", async () => {
    await mount(<DocumentSidebar {...PROPS} open onOpenChange={() => {}} />);

    await press("Home");
    expect(pane().style.width).toBe(`${maxWidth(1440)}px`);

    await press("End");
    expect(pane().style.width).toBe(`${MIN_WIDTH}px`);
  });

  it("remembers the width it was left at", async () => {
    await mount(<DocumentSidebar {...PROPS} open onOpenChange={() => {}} />);
    await press("End");

    expect(store.get(WIDTH_KEY)).toBe(String(MIN_WIDTH));
  });

  it("leaves a rail behind when it is closed", async () => {
    // A document the assistant is writing into while nothing on screen says so
    // is the one state this feature cannot afford.
    const opened: boolean[] = [];
    await mount(
      <DocumentSidebar {...PROPS} open={false} onOpenChange={(v) => opened.push(v)} />,
    );

    expect(document.querySelector('[role="separator"]')).toBeNull();
    const rail = buttonLabelled("Abrir Roteiro");
    expect(rail.textContent).toContain("Roteiro");

    await act(async () => rail.click());
    expect(opened).toEqual([true]);
  });
});

describe("the pane on a phone", () => {
  it("takes the screen instead of a share of it", async () => {
    // There is no width to negotiate at 360px: it is the screen or it is
    // nothing, so there is no separator to drag either.
    await mount(<DocumentSidebar {...PROPS} compact open onOpenChange={() => {}} />);

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.getAttribute("aria-label")).toBe("Roteiro");
    expect(document.querySelector('[role="separator"]')).toBeNull();
  });

  it("renders nothing at all while it is closed", async () => {
    // The way in is the button on the top bar, not a rail stealing 36px from a
    // 360px screen.
    await mount(
      <DocumentSidebar {...PROPS} compact open={false} onOpenChange={() => {}} />,
    );

    expect(container!.innerHTML).toBe("");
  });

  it("closes from its own header", async () => {
    const closed: boolean[] = [];
    await mount(
      <DocumentSidebar
        {...PROPS}
        compact
        open
        onOpenChange={(value) => closed.push(value)}
      />,
    );

    await act(async () => buttonLabelled("Fechar").click());
    expect(closed).toEqual([false]);
  });
});

describe("what the pane shows", () => {
  it("uses the mode's own empty state", async () => {
    // The panel never learns that presentations exist: the copy arrives as a
    // prop, from the mode, through the App.
    await mount(
      <DocumentSidebar {...PROPS} content="" open onOpenChange={() => {}} />,
    );

    expect(document.body.textContent).toContain("O roteiro aparece aqui.");
  });

  it("reads by default and edits on request", async () => {
    await mount(<DocumentSidebar {...PROPS} open onOpenChange={() => {}} />);

    // Reading is what the person does most; the assistant is the one writing.
    expect(document.querySelector("textarea")).toBeNull();

    const edit = [...document.querySelectorAll('[role="tab"]')].find(
      (tab) => tab.textContent === "Editar",
    ) as HTMLButtonElement;
    await act(async () => edit.click());

    expect(document.querySelector("textarea")).not.toBeNull();
  });
});
