/** @vitest-environment happy-dom */
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ModelSelect } from "@/components/ui/ModelSelect";
import type {
  CatalogResult,
  ModelChoice,
  ThinkerProvider,
} from "@/types";

// The combobox renders its popup in a portal under document.body, so the row
// is asserted inside `container` and the popup inside `document.body`. The
// catalogue is fetched lazily — the first assertion in the suite is that a
// mounted row has asked the backend NOTHING yet.

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

/** Flushes the fetch-effect's `setTimeout` (0ms on first open, 250ms after a
 * keystroke) and the microtasks the response resolution schedules. */
async function settle(waitMs = 0): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  });
  for (let i = 0; i < 5; i += 1) await act(async () => {});
}

function inputByAriaLabel(label: string): HTMLInputElement {
  const found = container?.querySelector<HTMLInputElement>(
    `input[aria-label="${label}"]`,
  );
  if (!found) throw new Error(`no input with aria-label "${label}"`);
  return found;
}

function triggerButton(): HTMLButtonElement {
  const found = [...(container?.querySelectorAll("button") ?? [])].find(
    (button) => button.getAttribute("aria-label") === "Abrir lista de modelos",
  );
  if (!found) throw new Error('no combobox trigger "Abrir lista de modelos"');
  return found as HTMLButtonElement;
}

async function click(button: HTMLElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/** Sets a React-controlled input's value the way a user would. */
function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function popupText(): string {
  return document.body.textContent ?? "";
}

function optionByText(fragment: string): HTMLElement {
  const found = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (option) => option.textContent?.includes(fragment),
  );
  if (!found) throw new Error(`no option containing "${fragment}"`);
  return found;
}

function popupButtonByText(label: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === label,
  );
  if (!found) throw new Error(`no popup button labelled "${label}"`);
  return found;
}

// ---------------------------------------------------------------------------
// The catalogue endpoint, reduced to a configurable fixture
// ---------------------------------------------------------------------------

const CATALOG: CatalogResult = {
  models: [
    {
      id: "gpt-5.2",
      label: "GPT-5.2",
      context_window: 128_000,
      max_output_tokens: null,
      supports_tools: true,
      rate: { input: 1.25, cached_input: 0.625, output: 10 },
      released_at: "2026-03-01T00:00:00.000Z",
      year: 2026,
      // In the roster already, and only on screen because `keep` asked for it.
      kept_by_selection: true,
    },
    {
      id: "deepseek-chat",
      label: "DeepSeek Chat",
      context_window: 64_000,
      max_output_tokens: null,
      supports_tools: true,
      rate: { input: 0.27, cached_input: 0.27, output: 1.1 },
      // The provider published no date: "sem data", never a year.
      released_at: null,
      year: null,
      kept_by_selection: false,
    },
    {
      id: "gpt-4o",
      label: "GPT-4o",
      context_window: 128_000,
      max_output_tokens: null,
      supports_tools: false,
      rate: null,
      released_at: "2024-05-13T00:00:00.000Z",
      year: 2024,
      kept_by_selection: false,
    },
  ],
  providers: [
    { provider: "openai", status: "ok", count: 3 },
    { provider: "openrouter", status: "skipped", count: 0, note: "Catalogue da OpenRouter precisa de chave — coloque OPENROUTER_API_KEY para ver os modelos." },
  ],
  min_year: 2026,
  total: 3,
  filtered: 3,
};

const CHOICE: ModelChoice = {
  provider: "openai",
  model: "gpt-5.2",
  context_window: 128_000,
  supports_tools: true,
  rate: { input: 1.25, cached_input: 0.625, output: 10 },
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function installCatalog(fetchMock = vi.fn(async () => jsonResponse(CATALOG))): void {
  vi.stubGlobal("fetch", fetchMock);
}

let onChange: ReturnType<typeof vi.fn>;
let onProviderChange: ReturnType<typeof vi.fn>;

/**
 * The row the roster panel actually renders: the panel owns the provider state
 * and threads it back into the `provider` prop, so a popup provider switch
 * changes what the next query asks. A bare ModelSelect cannot show that — its
 * `provider` prop is inert — so the provider-sensitive cases mount this.
 */
function StatefulRow(props: {
  value: ModelChoice | null;
  keep: string[];
  onChange: (choice: ModelChoice) => void;
  onProviderChange: (provider: ThinkerProvider) => void;
}) {
  const [provider, setProvider] = useState<ThinkerProvider>("openai");
  return (
    <ModelSelect
      {...props}
      provider={provider}
      onProviderChange={(next) => {
        props.onProviderChange(next);
        setProvider(next);
      }}
      label="Master"
    />
  );
}

beforeEach(() => {
  onChange = vi.fn();
  onProviderChange = vi.fn();
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

describe("ModelSelect", () => {
  it("fetches nothing until the popup opens", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(CATALOG));
    installCatalog(fetchMock);
    await mount(
      <ModelSelect
        value={CHOICE}
        onChange={onChange}
        keep={["gpt-5.2"]}
        provider="openai"
        onProviderChange={onProviderChange}
        label="Master"
      />,
    );
    await settle();

    expect(fetchMock).not.toHaveBeenCalled();

    await click(triggerButton());
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("asks the catalogue with the row's provider, the keep list and the undated toggle", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(CATALOG),
    );
    installCatalog(fetchMock);
    await mount(
      <ModelSelect
        value={CHOICE}
        onChange={onChange}
        keep={["gpt-5.2", "gpt-5.2-mini"]}
        provider="openai"
        onProviderChange={onProviderChange}
        label="Master"
      />,
    );

    await click(triggerButton());
    await settle();

    const [url] = fetchMock.mock.calls[0]!;
    const params = new URL(String(url), "http://localhost").searchParams;
    expect(params.get("provider")).toBe("openai");
    expect(params.get("include_undated")).toBe("1");
    expect(params.getAll("keep")).toEqual(["gpt-5.2", "gpt-5.2-mini"]);
  });

  it("marks kept models and undated models on their rows", async () => {
    installCatalog();
    await mount(
      <ModelSelect
        value={CHOICE}
        onChange={onChange}
        keep={["gpt-5.2"]}
        provider="openai"
        onProviderChange={onProviderChange}
        label="Master"
      />,
    );

    await click(triggerButton());
    await settle();

    expect(optionByText("GPT-5.2").textContent).toContain("(selecionado)");
    // `null` year renders as "sem data", never as the filter's floor.
    expect(optionByText("DeepSeek Chat").textContent).toContain("sem data");
    expect(optionByText("DeepSeek Chat").textContent).not.toContain("2026");
    expect(optionByText("GPT-4o").textContent).toContain("2024");
  });

  it("picks a model and hands the row a full choice", async () => {
    installCatalog();
    await mount(
      <ModelSelect
        value={CHOICE}
        onChange={onChange}
        keep={["gpt-5.2"]}
        provider="openai"
        onProviderChange={onProviderChange}
        label="Master"
      />,
    );

    await click(triggerButton());
    await settle();

    await click(optionByText("DeepSeek Chat"));
    await settle();

    expect(onChange).toHaveBeenCalledWith({
      provider: "openai",
      model: "deepseek-chat",
      context_window: 64_000,
      supports_tools: true,
      rate: { input: 0.27, cached_input: 0.27, output: 1.1 },
    });
    // released_at is the catalogue-entry date, not a release: it travels as
    // discovered_at, and "lançado em" must never appear anywhere.
    const picked = onChange.mock.calls[0]![0] as ModelChoice;
    expect(picked).not.toHaveProperty("released_at");
    expect(popupText()).not.toContain("lançado em");
  });

  it("debounces the search and re-asks with the text", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(CATALOG),
    );
    installCatalog(fetchMock);
    await mount(
      <ModelSelect
        value={CHOICE}
        onChange={onChange}
        keep={["gpt-5.2"]}
        provider="openai"
        onProviderChange={onProviderChange}
        label="Master"
      />,
    );

    await click(triggerButton());
    await settle();

    await act(async () => {
      typeInto(inputByAriaLabel("Master"), "gpt-4");
    });
    // A keystroke waits the debounce before asking; nothing fires mid-wait.
    await settle(100);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await settle(250);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url] = fetchMock.mock.calls[1]!;
    expect(new URL(String(url), "http://localhost").searchParams.get("q")).toBe("gpt-4");
  });

  it("switches provider from inside the popup and re-asks that catalogue", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(CATALOG),
    );
    installCatalog(fetchMock);
    await mount(
      <StatefulRow
        value={CHOICE}
        keep={["gpt-5.2"]}
        onChange={onChange}
        onProviderChange={onProviderChange}
      />,
    );

    await click(triggerButton());
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await click(popupButtonByText("OpenRouter"));
    await settle();

    expect(onProviderChange).toHaveBeenCalledWith("openrouter");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url] = fetchMock.mock.calls[1]!;
    expect(new URL(String(url), "http://localhost").searchParams.get("provider")).toBe(
      "openrouter",
    );
  });

  it("reports the active provider's key status", async () => {
    installCatalog();
    await mount(
      <StatefulRow
        value={CHOICE}
        keep={["gpt-5.2"]}
        onChange={onChange}
        onProviderChange={onProviderChange}
      />,
    );

    await click(triggerButton());
    await settle();

    // The note belongs to openrouter's status, and openai is the active
    // provider — the row only reports the provider it is browsing.
    expect(popupText()).not.toContain("OPENROUTER_API_KEY");

    await click(popupButtonByText("OpenRouter"));
    await settle();
    expect(popupText()).toContain("OPENROUTER_API_KEY");
  });

  it("reports a failed catalogue with a retry that works", async () => {
    const failing = vi.fn(async () => new Response("", { status: 500 }));
    installCatalog(failing);
    await mount(
      <ModelSelect
        value={CHOICE}
        onChange={onChange}
        keep={["gpt-5.2"]}
        provider="openai"
        onProviderChange={onProviderChange}
        label="Master"
      />,
    );

    await click(triggerButton());
    await settle();

    expect(popupText()).toContain("HTTP 500");

    installCatalog();
    await click(popupButtonByText("Tentar de novo"));
    await settle();

    expect(popupText()).toContain("GPT-5.2");
  });
});
