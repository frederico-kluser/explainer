/** @vitest-environment happy-dom */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DocumentPanel } from "@/components/ui/DocumentPanel";

// The gaps the first html-document suite left open. The sandbox and the toggle
// are proven there; here the panel is pinned against the document changing
// under it — the model wrote, or another screen saved — and against a
// content/format mismatch, where the markdown branch must escape a file that
// looks like html. The frame's `srcdoc` is an attribute, not a browsing
// context: happy-dom never opens one, so the assertions stay on the attributes.

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

async function rerender(node: ReactNode): Promise<void> {
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

/** Sets a React-controlled textarea's value the way a user would. */
function typeIntoTextarea(value: string): void {
  const textarea = document.querySelector("textarea")!;
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )!.set!;
  setter.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

// React delegates `onFocus`/`onBlur` to `focusin`/`focusout` on the root, so
// the caret-state guard is driven with those two events rather than relying on
// happy-dom's focus() internals.
async function focusEditor(): Promise<void> {
  await act(async () => {
    document
      .querySelector("textarea")!
      .dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  });
}

async function blurEditor(): Promise<void> {
  await act(async () => {
    document
      .querySelector("textarea")!
      .dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
}

const HTML_CONTENT =
  "<!doctype html><html><head><title>Pesquisa</title></head>" +
  "<body><h1>Relatorio</h1><p>Conteudo da pesquisa</p></body></html>";

const NEW_HTML_CONTENT =
  "<!doctype html><html><head><title>Pesquisa</title></head>" +
  "<body><h1>Novo relatorio</h1><p>Segunda versao</p></body></html>";

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

describe("DocumentPanel with format markdown", () => {
  it("shows raw html inside the markdown as escaped text, never as markup", async () => {
    await mount(
      <DocumentPanel
        {...PANEL_PROPS}
        format="markdown"
        content="Antes <b>importante</b> e <script>variavel</script> depois"
        onContentChange={() => {}}
      />,
    );

    expect(document.querySelector("iframe")).toBeNull();
    // The escape happens before any tag is built, so the tags survive only as
    // text — nothing that could run reaches the page DOM.
    expect(document.querySelector("b")).toBeNull();
    expect(document.querySelector("script")).toBeNull();
    expect(document.body.textContent).toContain("<b>importante</b>");
    expect(document.body.textContent).toContain("<script>variavel</script>");
    // The explicit markdown format keeps the reading tab's markdown label.
    expect(document.body.textContent).toContain("Ler");
    expect(document.body.textContent).not.toContain("Ver");
  });

  it("treats a whole html file as markdown when the format says markdown", async () => {
    await mount(
      <DocumentPanel {...PANEL_PROPS} format="markdown" onContentChange={() => {}} />,
    );

    expect(document.querySelector("iframe")).toBeNull();
    expect(document.querySelector("h1")).toBeNull();
    expect(document.body.textContent).toContain("<h1>Relatorio</h1>");
  });
});

describe("the panel keeping up with a document that changes", () => {
  it("reloads the frame with the newest html when the content prop changes", async () => {
    await mount(<DocumentPanel {...PANEL_PROPS} format="html" />);
    expect(document.querySelector("iframe")!.getAttribute("srcdoc")).toContain(
      "Relatorio",
    );

    await rerender(
      <DocumentPanel {...PANEL_PROPS} content={NEW_HTML_CONTENT} format="html" />,
    );

    const frame = document.querySelector("iframe")!;
    expect(frame.getAttribute("srcdoc")).toContain("Novo relatorio");
    expect(frame.getAttribute("srcdoc")).not.toContain("Relatorio");
  });

  it("mounts the frame only when a document actually arrives", async () => {
    await mount(<DocumentPanel {...PANEL_PROPS} content="" format="html" />);

    expect(document.querySelector("iframe")).toBeNull();
    expect(document.body.textContent).toContain("Nenhum documento ainda");

    await rerender(<DocumentPanel {...PANEL_PROPS} format="html" />);

    expect(document.querySelector("iframe")).not.toBeNull();
    expect(document.querySelector("iframe")!.getAttribute("srcdoc")).toContain(
      "Relatorio",
    );
    expect(document.body.textContent).not.toContain("Nenhum documento ainda");
  });

  it("adopts a newer document into the editor while the caret is not there", async () => {
    await mount(<DocumentPanel {...PANEL_PROPS} format="html" />);
    await clickTab("Editar");
    expect(document.querySelector("textarea")!.value).toBe(HTML_CONTENT);

    await rerender(
      <DocumentPanel {...PANEL_PROPS} content={NEW_HTML_CONTENT} format="html" />,
    );

    expect(document.querySelector("textarea")!.value).toBe(NEW_HTML_CONTENT);
  });

  it("lets the writer finish the sentence before adopting an external update", async () => {
    const adopted: string[] = [];
    const putBodies: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.endsWith("/document") && init?.method === "PUT") {
          const body = JSON.parse(String(init.body)) as { content: string };
          putBodies.push(body.content);
          return new Response(JSON.stringify({ content: body.content }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("", { status: 404 });
      }) as unknown as typeof fetch,
    );

    await mount(
      <DocumentPanel
        {...PANEL_PROPS}
        format="html"
        onContentChange={(value) => adopted.push(value)}
      />,
    );
    await clickTab("Editar");
    await focusEditor();
    await act(async () => {
      typeIntoTextarea("minha frase");
    });

    // The model wrote meanwhile: the external update must not eat the sentence.
    await rerender(
      <DocumentPanel
        {...PANEL_PROPS}
        format="html"
        onContentChange={(value) => adopted.push(value)}
      />,
    );
    expect(document.querySelector("textarea")!.value).toBe("minha frase");

    await blurEditor();
    // The save is a fetch round-trip: two act rounds let the continuation
    // settle before the assertions read its results.
    await act(async () => {});
    await act(async () => {});

    expect(putBodies).toEqual(["minha frase"]);
    expect(adopted).toEqual(["minha frase"]);
  });
});
