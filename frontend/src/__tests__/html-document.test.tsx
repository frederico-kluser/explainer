/** @vitest-environment happy-dom */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DocumentPanel } from "@/components/ui/DocumentPanel";
import { DocumentSidebar } from "@/components/ui/DocumentSidebar";

// The html-explainer document is LLM-generated input, so the claim that
// matters is the sandbox attribute itself: happy-dom never opens a real
// browsing context for `srcDoc`, so the frame's internal document would prove
// nothing. What is provable here is the contract — the frame may run its own
// scripts and nothing else, and the whole file arrives as `srcdoc`.

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

async function clickTab(label: string): Promise<void> {
  const tab = [...document.querySelectorAll('[role="tab"]')].find(
    (element) => element.textContent === label,
  );
  if (!tab) throw new Error(`no tab labelled ${label}`);
  await act(async () => (tab as HTMLButtonElement).click());
}

const HTML_CONTENT =
  "<!doctype html><html><head><title>Pesquisa</title></head>" +
  "<body><h1>Relatorio</h1><p>Conteudo da pesquisa</p></body></html>";

const PANEL_PROPS = {
  conversationId: "550e8400-e29b-41d4-a716-446655440000",
  content: HTML_CONTENT,
  onContentChange: () => {},
};

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("DocumentPanel with an html document", () => {
  it("renders the document in a script-only sandboxed iframe", async () => {
    await mount(<DocumentPanel {...PANEL_PROPS} format="html" />);

    const frame = document.querySelector("iframe");
    expect(frame).not.toBeNull();

    // The whole point of the sandbox: the document's own runtime may run —
    // tabs, syntax highlight, copy buttons — but the frame is a stranger.
    const sandbox = frame!.getAttribute("sandbox") ?? "";
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-same-origin");

    expect(frame!.getAttribute("srcdoc")).toContain("<h1>Relatorio</h1>");
  });

  it("keeps the html out of the page DOM", async () => {
    // The markdown renderer escapes markup, so a leaked html branch would show
    // the tags as page text. Inside the iframe they live in `srcdoc` instead.
    await mount(<DocumentPanel {...PANEL_PROPS} format="html" />);

    expect(document.body.textContent).not.toContain("<h1>");
    expect(document.body.textContent).not.toContain("Relatorio");
  });

  it("keeps the raw editor one tab away", async () => {
    await mount(<DocumentPanel {...PANEL_PROPS} format="html" />);

    expect(document.querySelector("textarea")).toBeNull();

    await clickTab("Editar");
    expect(document.querySelector("textarea")).not.toBeNull();
    expect(document.querySelector("textarea")!.value).toBe(HTML_CONTENT);

    await clickTab("Ver");
    expect(document.querySelector("textarea")).toBeNull();
    expect(document.querySelector("iframe")).not.toBeNull();
  });
});

describe("DocumentPanel without a format", () => {
  it("keeps the markdown flow untouched", async () => {
    await mount(
      <DocumentPanel
        {...PANEL_PROPS}
        content="# Titulo\n\ntexto"
        onContentChange={() => {}}
      />,
    );

    expect(document.querySelector("iframe")).toBeNull();
    // The heading rule consumed the "# ", so the rendered text is what proves
    // the markdown branch is the one rendering — and no raw markup leaks.
    expect(document.body.textContent).toContain("Titulo");
    expect(document.body.textContent).not.toContain("<h1>");
  });
});

describe("the sidebar forwards the format", () => {
  it("renders an html document through the sandboxed iframe", async () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    });
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1440,
    });

    await mount(
      <DocumentSidebar
        conversationId={PANEL_PROPS.conversationId}
        title="Pesquisa"
        placeholder="A pesquisa aparece aqui."
        format="html"
        content={HTML_CONTENT}
        onContentChange={() => {}}
        open
        onOpenChange={() => {}}
        compact={false}
      />,
    );

    const frame = document.querySelector("iframe");
    expect(frame).not.toBeNull();
    expect(frame!.getAttribute("sandbox")).toContain("allow-scripts");
    expect(frame!.getAttribute("srcdoc")).toContain("Conteudo da pesquisa");
  });
});
