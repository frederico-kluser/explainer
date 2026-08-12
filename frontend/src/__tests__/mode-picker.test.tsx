/** @vitest-environment happy-dom */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ModePicker } from "@/components/ui/ModePicker";

// The claim under test is the one the modularity of this feature rests on: the
// browser holds no list of modes. Everything on this screen comes off
// `GET /api/modes`, so a mode added on the server appears here without a line
// changing — and a mode naming an icon this build has never heard of still
// renders.

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

function modeButtons(): HTMLButtonElement[] {
  return [...document.querySelectorAll("button")].filter((button) =>
    button.textContent?.includes("—") === false && button.querySelector("span"),
  ) as HTMLButtonElement[];
}

function buttonLabelled(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((button) =>
    button.textContent?.includes(text),
  );
  if (!found) throw new Error(`no button containing ${text}`);
  return found as HTMLButtonElement;
}

const ENVELOPE = {
  modes: [
    {
      id: "conversation",
      label: "Conversa",
      description: "Tire dúvidas sobre um material.",
      icon: "MessagesSquare",
      requires_material: true,
      document: { title: "Anotações", placeholder: "…", open_by_default: false },
    },
    {
      id: "presentation",
      label: "Criar apresentação",
      description: "Monte o roteiro slide a slide.",
      icon: "Presentation",
      requires_material: false,
      document: { title: "Roteiro", placeholder: "…", open_by_default: true },
    },
    {
      id: "futuro",
      label: "Um modo que ainda não existe",
      description: "Com um ícone que este build nunca viu.",
      icon: "IconeQueNaoExiste",
      requires_material: true,
      document: null,
    },
  ],
  default: "conversation",
};

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ENVELOPE,
      text: async () => JSON.stringify(ENVELOPE),
    })) as unknown as typeof fetch,
  );
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ModePicker", () => {
  it("renders whatever the server sent, including a mode it has never heard of", async () => {
    await mount(<ModePicker open onClose={() => {}} onChoose={() => {}} />);

    expect(document.body.textContent).toContain("Conversa");
    expect(document.body.textContent).toContain("Criar apresentação");
    // The point of the third one: a mode this build predates still shows up,
    // with a fallback icon instead of a crash.
    expect(document.body.textContent).toContain("Um modo que ainda não existe");
    expect(modeButtons().length).toBeGreaterThanOrEqual(3);
  });

  it("says which modes can start with nothing attached", async () => {
    await mount(<ModePicker open onClose={() => {}} onChoose={() => {}} />);

    const presentation = buttonLabelled("Criar apresentação");
    expect(presentation.textContent).toContain("não precisa de material");
    expect(buttonLabelled("Tire dúvidas").textContent).not.toContain(
      "não precisa de material",
    );
  });

  it("hands the chosen id back and nothing else", async () => {
    const chosen: string[] = [];
    await mount(
      <ModePicker open onClose={() => {}} onChoose={(id) => chosen.push(id)} />,
    );

    await act(async () => {
      buttonLabelled("Criar apresentação").click();
    });

    expect(chosen).toEqual(["presentation"]);
  });

  it("asks for nothing while it is closed", async () => {
    await mount(<ModePicker open={false} onClose={() => {}} onChoose={() => {}} />);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("says so when the list cannot be read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    );

    await mount(<ModePicker open onClose={() => {}} onChoose={() => {}} />);
    await act(async () => {});

    expect(document.body.textContent).toContain("Não foi possível carregar os modos");
  });
});
