/** @vitest-environment happy-dom */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ThinkerRosterPanel } from "@/components/ui/ThinkerRosterPanel";
import type {
  ModelChoice,
  ProviderKeyStatus,
  RosterEnvelope,
  RosterWarning,
  ThinkerRoster,
  ThinkerSlot,
} from "@/types";

// The panel is the part of the roster feature the browser actually runs, so
// the suite mounts it against a stateful fake of the two routes. The fake
// NORMALISES on PUT exactly the way `services/thinker-roster.ts` does for the
// fields the UI cares about — an empty model id falls back to the default —
// so "re-render from the response, not the draft" is asserted against
// something that behaves like the backend, not like a stub that echoes.

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

async function clickCheckbox(box: HTMLInputElement): Promise<void> {
  await act(async () => {
    box.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function inputByAriaLabel(label: string): HTMLInputElement {
  const found = container?.querySelector<HTMLInputElement>(
    `input[aria-label="${label}"]`,
  );
  if (!found) throw new Error(`no input with aria-label "${label}"`);
  return found;
}

/** Sets a React-controlled select's value the way a user would. */
function selectInto(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLSelectElement.prototype,
    "value",
  )!.set!;
  setter.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

function providerSelect(ariaLabel: string): HTMLSelectElement {
  const found = [...(container?.querySelectorAll("select") ?? [])].find(
    (select) => select.getAttribute("aria-label") === ariaLabel,
  );
  if (!found) throw new Error(`no select with aria-label "${ariaLabel}"`);
  return found as HTMLSelectElement;
}

// ---------------------------------------------------------------------------
// The backend, reduced to the two roster routes
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const PROVIDER_STATUSES: ProviderKeyStatus[] = [
  {
    provider: "openai",
    env_var: "OPENAI_API_KEY",
    present: true,
    source: "env",
    console_url: "https://platform.openai.com/api-keys",
  },
  {
    provider: "openrouter",
    env_var: "OPENROUTER_API_KEY",
    present: false,
    source: null,
    console_url: "https://openrouter.ai/keys",
  },
  {
    provider: "deepseek",
    env_var: "DEEPSEEK_API_KEY",
    present: true,
    source: "env",
    console_url: "https://platform.deepseek.com/api_keys",
  },
];

function choice(
  provider: ModelChoice["provider"],
  model: string,
  context_window: number | null = 128_000,
): ModelChoice {
  return {
    provider,
    model,
    context_window,
    supports_tools: true,
    rate: { input: 1, cached_input: 0.5, output: 4 },
  };
}

function slotsWith(enabled: number[], modelId: string): ThinkerSlot[] {
  const slots: ThinkerSlot[] = [];
  for (let index = 1; index <= 10; index += 1) {
    slots.push({
      index,
      enabled: enabled.includes(index),
      model: choice("openai", modelId),
    });
  }
  return slots;
}

const STORED_ROSTER: ThinkerRoster = {
  version: 1,
  master: choice("openai", "gpt-5.2"),
  planner: choice("openai", "gpt-5.2-mini"),
  slots: slotsWith([1, 2, 3, 4], "gpt-5.2-mini"),
  updated_at: "2026-08-09T00:00:00.000Z",
};

const RESET_ROSTER: ThinkerRoster = {
  ...STORED_ROSTER,
  master: choice("openai", "gpt-5.2-padrao"),
};

const MASTER_WARNING: RosterWarning = {
  code: "provider_key_missing",
  role: "master",
  provider: "openrouter",
  message:
    "O master usa openrouter, mas OPENROUTER_API_KEY não está configurada — " +
    "essa chamada vai falhar. Crie uma chave em https://openrouter.ai/keys " +
    "e cole na tela de configuração.",
};

const SLOT_WARNING: RosterWarning = {
  code: "provider_key_missing",
  role: "thinker",
  provider: "deepseek",
  slot_index: 3,
  message:
    "O pensador 3 usa deepseek, mas DEEPSEEK_API_KEY não está configurada — " +
    "essa chamada vai falhar. Crie uma chave em " +
    "https://platform.deepseek.com/api_keys e cole na tela de configuração.",
};

function envelope(
  roster: ThinkerRoster,
  warnings: RosterWarning[] = [],
): RosterEnvelope {
  return { roster, providers: PROVIDER_STATUSES, warnings };
}

/** Mimics `normalizeModelId`: an empty id falls back to the default model. */
function normalizeChoice(candidate: ModelChoice): ModelChoice {
  return {
    ...candidate,
    model: candidate.model.trim() === "" ? "gpt-5.2-normalizado" : candidate.model,
  };
}

interface BackendState {
  roster: ThinkerRoster;
  warnings: RosterWarning[];
}

function installBackend(state: BackendState): ReturnType<typeof vi.fn> {
  const current: BackendState = { ...state, roster: structuredClone(state.roster) };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";

    if (url.endsWith("/api/thinkers") && method === "GET") {
      return jsonResponse(envelope(current.roster, current.warnings));
    }
    if (url.endsWith("/api/thinkers") && method === "PUT") {
      const body = JSON.parse(String(init?.body)) as ThinkerRoster;
      current.roster = {
        ...body,
        version: 1,
        master: normalizeChoice(body.master),
        planner: normalizeChoice(body.planner),
        slots: body.slots.map((slot) => ({ ...slot, model: normalizeChoice(slot.model) })),
        updated_at: "2026-08-09T00:00:00.000Z",
      };
      current.warnings = [];
      return jsonResponse(envelope(current.roster));
    }
    if (url.endsWith("/api/thinkers/reset") && method === "POST") {
      current.roster = structuredClone(RESET_ROSTER);
      current.warnings = [];
      return jsonResponse(envelope(current.roster));
    }
    return new Response("", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  installBackend({
    roster: STORED_ROSTER,
    warnings: [MASTER_WARNING, SLOT_WARNING],
  });
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
// The panel, mounted
// ---------------------------------------------------------------------------

describe("ThinkerRosterPanel", () => {
  it("loads the roster on open and renders master, planner and the ten slots", async () => {
    await mount(<ThinkerRosterPanel />);
    await settle();

    expect(text()).toContain("Master");
    expect(text()).toContain("Planner");
    for (let index = 1; index <= 10; index += 1) {
      expect(text()).toContain(`Pensador ${index}`);
    }
    // The loaded choices are in the row inputs, straight from the GET.
    expect(inputByAriaLabel("Master").value).toBe("gpt-5.2");
    expect(inputByAriaLabel("Planner").value).toBe("gpt-5.2-mini");
    // Clean state: nothing to save.
    expect(buttonLabelled("Salvar").disabled).toBe(true);
  });

  it("renders warnings verbatim, one per row, with the disabled slots skipped", async () => {
    await mount(<ThinkerRosterPanel />);
    await settle();

    // Both warnings come from the server; the panel maps them to rows.
    expect(text()).toContain(MASTER_WARNING.message);
    expect(text()).toContain(SLOT_WARNING.message);
    expect(text()).toContain("OPENROUTER_API_KEY");
    expect(text()).toContain("https://platform.deepseek.com/api_keys");
  });

  it("saves with a PUT and re-renders from the response, not the draft", async () => {
    const fetchMock = installBackend({
      roster: STORED_ROSTER,
      warnings: [MASTER_WARNING, SLOT_WARNING],
    });
    await mount(<ThinkerRosterPanel />);
    await settle();

    // Repoint the master at deepseek: the old model id dies with the old
    // provider, so the row must be forced back to a fresh pick.
    await act(async () => {
      selectInto(providerSelect("Provedor do master"), "deepseek");
    });
    expect(inputByAriaLabel("Master").value).toBe("");
    expect(buttonLabelled("Salvar").disabled).toBe(false);

    await click(buttonLabelled("Salvar"));
    await settle();

    const put = fetchMock.mock.calls.find(
      ([, init]) => init?.method === "PUT",
    );
    if (!put) throw new Error("no PUT call");
    const body = JSON.parse(String(put[1]?.body)) as ThinkerRoster;
    expect(body).toMatchObject({ version: 1 });
    expect(body.master.provider).toBe("deepseek");
    expect(body.master.model).toBe("");
    expect(body.slots).toHaveLength(10);

    // The response is the new source of truth: the backend repaired the empty
    // model id, and the screen shows the repaired roster.
    expect(inputByAriaLabel("Master").value).toBe("gpt-5.2-normalizado");
    expect(text()).toContain("Salvo.");
    expect(buttonLabelled("Salvar").disabled).toBe(true);
  });

  it("keeps a disabled slot's model and sends it anyway", async () => {
    const fetchMock = installBackend({ roster: STORED_ROSTER, warnings: [] });
    await mount(<ThinkerRosterPanel />);
    await settle();

    // Slot 2 is enabled in the stored roster; switch it off.
    const boxes = [...(container?.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    ) ?? [])];
    const slot2 = boxes.find((box) =>
      box.parentElement?.textContent?.includes("Pensador 2"),
    );
    if (!slot2) throw new Error('no checkbox for "Pensador 2"');
    expect(slot2.checked).toBe(true);
    await clickCheckbox(slot2);

    await click(buttonLabelled("Salvar"));
    await settle();

    const put = fetchMock.mock.calls.find(
      ([, init]) => init?.method === "PUT",
    );
    if (!put) throw new Error("no PUT call");
    const body = JSON.parse(String(put[1]?.body)) as ThinkerRoster;
    const slot2body = body.slots[1];
    expect(slot2body?.enabled).toBe(false);
    // Off keeps the model: the payload must still carry it.
    expect(slot2body?.model.model).toBe("gpt-5.2-mini");
  });

  it("edits an angle and sends it", async () => {
    const fetchMock = installBackend({ roster: STORED_ROSTER, warnings: [] });
    await mount(<ThinkerRosterPanel />);
    await settle();

    const angle = container?.querySelector<HTMLInputElement>(
      'input[placeholder="Ângulo próprio (opcional)"]',
    );
    if (!angle) throw new Error("no angle input");
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    await act(async () => {
      setter.call(angle, "riscos");
      angle.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await click(buttonLabelled("Salvar"));
    await settle();

    const put = fetchMock.mock.calls.find(
      ([, init]) => init?.method === "PUT",
    );
    if (!put) throw new Error("no PUT call");
    const body = JSON.parse(String(put[1]?.body)) as ThinkerRoster;
    expect(body.slots[0]?.angle).toBe("riscos");
  });

  it("resets through POST /api/thinkers/reset after a confirmation", async () => {
    const fetchMock = installBackend({ roster: STORED_ROSTER, warnings: [] });
    await mount(<ThinkerRosterPanel />);
    await settle();

    await click(buttonLabelled("Padrão"));
    await click(buttonLabelled("Confirmar"));
    await settle();

    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          String(url).endsWith("/api/thinkers/reset") && init?.method === "POST",
      ),
    ).toBe(true);
    expect(inputByAriaLabel("Master").value).toBe("gpt-5.2-padrao");
    expect(text()).toContain("Restaurado para o padrão.");
  });

  it("shows the failure and retries the load", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 500 })),
    );

    await mount(<ThinkerRosterPanel />);
    await settle();

    expect(text()).toContain("Não foi possível carregar o roster de pensadores");

    installBackend({ roster: STORED_ROSTER, warnings: [] });
    await click(buttonLabelled("Tentar de novo"));
    await settle();

    expect(text()).toContain("Master");
    expect(inputByAriaLabel("Master").value).toBe("gpt-5.2");
  });

  it("keeps the draft while the save fails, with the message on screen", async () => {
    const fetchMock = installBackend({ roster: STORED_ROSTER, warnings: [] });
    await mount(<ThinkerRosterPanel />);
    await settle();

    // Break the PUT only.
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return jsonResponse(
          { error: "Este servidor fala a versão 1 do roster de pensadores." },
          422,
        );
      }
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/api/thinkers") && !init?.method) {
        return jsonResponse(envelope(STORED_ROSTER));
      }
      return new Response("", { status: 404 });
    });

    await act(async () => {
      selectInto(providerSelect("Provedor do master"), "deepseek");
    });
    await click(buttonLabelled("Salvar"));
    await settle();

    expect(text()).toContain(
      "Este servidor fala a versão 1 do roster de pensadores.",
    );
    // The draft survives: the operator can fix the problem and save again.
    expect(providerSelect("Provedor do master").value).toBe("deepseek");
    expect(buttonLabelled("Salvar").disabled).toBe(false);
  });
});
