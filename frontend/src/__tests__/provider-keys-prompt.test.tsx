/** @vitest-environment happy-dom */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderKeysPrompt } from "@/components/ui/ProviderKeysPrompt";

// The one line that decides whether the card is a reminder or a gate is
// `ProviderKeysPrompt`'s own "unknown" phase — the branch that renders
// nothing on a fetch that fails, and the branch that shows the form only
// when both calling keys are absent. The rest of the promise chain worth
// mounting is the save: the two PUTs and the re-read that confirms them.
// `App`'s side — that the card mounts on top of the dashboard instead of in
// place of it — is asserted in `app-setup-gate.test.tsx`.

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

/** Lets the mount's fetches resolve and React commit what they produced. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await act(async () => {});
}

function text(): string {
  return container?.textContent ?? "";
}

function buttonLabelled(label: string): HTMLButtonElement {
  const found = [...(container?.querySelectorAll("button") ?? [])].find(
    (button) => button.textContent?.trim() === label,
  );
  if (!found) throw new Error(`no button labelled "${label}" on screen`);
  return found as HTMLButtonElement;
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/**
 * Types into a React-controlled input.
 *
 * Setting `.value` directly is a no-op for React's onChange; the prototype
 * setter followed by a bubbling `input` event is what React's own test
 * utilities do, without the library.
 */
function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function inputByPlaceholder(placeholder: string): HTMLInputElement {
  const found = container?.querySelector<HTMLInputElement>(
    `input[placeholder="${placeholder}"]`,
  );
  if (!found) throw new Error(`no input with placeholder "${placeholder}"`);
  return found;
}

// ---------------------------------------------------------------------------
// The backend, reduced to what the card asks it
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface BackendState {
  openai: boolean;
  openrouter: boolean;
}

const CONSOLES: Record<string, string> = {
  openai: "https://platform.openai.com/api-keys",
  openrouter: "https://openrouter.ai/keys",
  deepseek: "https://platform.deepseek.com/api_keys",
};

/**
 * The stateful fake: a PUT flips the provider to present, so the re-read the
 * card performs after saving answers with the key "really" there.
 *
 * Works on a copy of the fixture, never the fixture itself: the fake mutates
 * its state on every PUT, and a fixture constant shared by reference would
 * carry one test's saves into every later test's status read.
 */
function installBackend(state: BackendState): ReturnType<typeof vi.fn> {
  const current = { ...state };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";

    if (url.endsWith("/api/provider-keys") && method === "GET") {
      return jsonResponse({
        providers: (["openai", "openrouter", "deepseek"] as const).map(
          (provider) => ({
            provider,
            env_var: `OPENAI_API_KEY`,
            present: provider === "deepseek" || current[provider],
            source: provider === "deepseek" || current[provider] ? "env" : null,
            console_url: CONSOLES[provider],
          }),
        ),
      });
    }

    if (url.includes("/api/provider-keys/") && method === "PUT") {
      const provider = url.split("/").pop() ?? "";
      if (provider === "openai" || provider === "openrouter") {
        const body = JSON.parse(String(init?.body)) as { key?: string };
        if (typeof body.key !== "string" || body.key.length < 20) {
          return jsonResponse(
            { error: "Essa chave é curta demais para ser válida." },
            400,
          );
        }
        current[provider] = true;
        return jsonResponse({
          provider,
          env_var: `OPENAI_API_KEY`,
          present: true,
          source: "runtime",
          console_url: CONSOLES[provider],
        });
      }
    }

    return new Response("", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const MISSING: BackendState = { openai: false, openrouter: false };
const PRESENT: BackendState = { openai: true, openrouter: true };

beforeEach(() => {
  installBackend(MISSING);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// The card, mounted
// ---------------------------------------------------------------------------

describe("ProviderKeysPrompt", () => {
  it("shows the form when OpenAI and OpenRouter are both missing keys", async () => {
    await mount(<ProviderKeysPrompt onDismiss={() => {}} />);
    await settle();

    expect(text()).toContain("Faltam as chaves de API");
    expect(inputByPlaceholder("sk-…")).toBeTruthy();
    expect(inputByPlaceholder("sk-or-…")).toBeTruthy();
  });

  it("renders nothing when both keys are present", async () => {
    installBackend(PRESENT);

    await mount(<ProviderKeysPrompt onDismiss={() => {}} />);
    await settle();

    expect(text()).toBe("");
  });

  it("renders nothing when only one provider is missing a key", async () => {
    installBackend({ openai: false, openrouter: true });

    await mount(<ProviderKeysPrompt onDismiss={() => {}} />);
    await settle();

    expect(text()).toBe("");
  });

  it("renders nothing when the status fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 500 })),
    );

    await mount(<ProviderKeysPrompt onDismiss={() => {}} />);
    await settle();

    expect(text()).toBe("");
  });

  it("saves both keys, re-reads the status and confirms", async () => {
    const fetchMock = installBackend(MISSING);
    const onDismiss = vi.fn();

    await mount(<ProviderKeysPrompt onDismiss={onDismiss} />);
    await settle();

    await act(async () => {
      typeInto(inputByPlaceholder("sk-…"), "sk-openai-key-long-enough-12345");
      typeInto(inputByPlaceholder("sk-or-…"), "sk-or-openrouter-key-123456");
    });
    await click(buttonLabelled("Salvar chaves"));
    await settle();

    expect(text()).toContain("Chaves salvas!");
    expect(onDismiss).not.toHaveBeenCalled();

    const puts = fetchMock.mock.calls.filter(
      ([, init]) => String(init?.method).toUpperCase() === "PUT",
    );
    expect(puts).toHaveLength(2);
    expect(String(puts[0]?.[0])).toContain("/api/provider-keys/openai");
    expect(JSON.parse(String(puts[0]?.[1]?.body))).toEqual({
      key: "sk-openai-key-long-enough-12345",
    });
    expect(String(puts[1]?.[0])).toContain("/api/provider-keys/openrouter");
    expect(JSON.parse(String(puts[1]?.[1]?.body))).toEqual({
      key: "sk-or-openrouter-key-123456",
    });

    // The re-read happened after the PUTs — the card learns the same way it
    // first learned the keys were missing.
    const gets = fetchMock.mock.calls.filter(
      ([, init]) => (init?.method ?? "GET") === "GET",
    );
    expect(gets.length).toBeGreaterThanOrEqual(2);
  });

  it("asks for at least one key before saving anything", async () => {
    const fetchMock = installBackend(MISSING);

    await mount(<ProviderKeysPrompt onDismiss={() => {}} />);
    await settle();

    await click(buttonLabelled("Salvar chaves"));
    await settle();

    expect(text()).toContain("Cole ao menos uma chave para salvar.");
    expect(text()).toContain("Faltam as chaves de API");
    expect(
      fetchMock.mock.calls.some(
        ([, init]) => String(init?.method).toUpperCase() === "PUT",
      ),
    ).toBe(false);
  });

  it("reports a refused key and keeps the form open", async () => {
    const fetchMock = installBackend(MISSING);
    const onDismiss = vi.fn();

    await mount(<ProviderKeysPrompt onDismiss={onDismiss} />);
    await settle();

    await act(async () => {
      typeInto(inputByPlaceholder("sk-…"), "sk-too-short");
    });
    await click(buttonLabelled("Salvar chaves"));
    await settle();

    expect(text()).toContain("Não foi possível salvar a chave da OpenAI");
    expect(text()).toContain("Faltam as chaves de API");
    expect(onDismiss).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalled();
  });

  it("lets the user dismiss with the close button", async () => {
    const onDismiss = vi.fn();

    await mount(<ProviderKeysPrompt onDismiss={onDismiss} />);
    await settle();

    const close = [...(container?.querySelectorAll("button") ?? [])].find(
      (button) => button.getAttribute("aria-label") === "Fechar",
    );
    if (!close) throw new Error('no button with aria-label "Fechar"');
    await click(close as HTMLButtonElement);

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("lets the user dismiss with the link", async () => {
    const onDismiss = vi.fn();

    await mount(<ProviderKeysPrompt onDismiss={onDismiss} />);
    await settle();

    await click(buttonLabelled("Agora não"));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("hands the app back from the confirmation", async () => {
    const onDismiss = vi.fn();
    installBackend(MISSING);

    await mount(<ProviderKeysPrompt onDismiss={onDismiss} />);
    await settle();

    await act(async () => {
      typeInto(inputByPlaceholder("sk-…"), "sk-openai-key-long-enough-12345");
    });
    await click(buttonLabelled("Salvar chaves"));
    await settle();

    await click(buttonLabelled("Continuar"));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
