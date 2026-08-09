/** @vitest-environment happy-dom */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SetupBoundary,
  SetupScreen,
  electronBridge,
  hasSetupBridge,
  isSetupDismissed,
  resetSetupDismissed,
  shouldShowSetup,
} from "@/components/SetupScreen";
import type {
  ApiKeyConfig,
  AppSettings,
  ExplainerElectronApi,
} from "@/types/electron";

// The first-launch gate is the one piece of this app that can hide all of it.
// Every case below is a way that used to end — or could end — with a window the
// user cannot get out of: a browser shown a screen meant for the desktop, a key
// that is saved and still not recognised, a settings read that never answers, a
// skip link that leads nowhere. The rule under test is that there is no such
// exit: the setup is optional, the app is not.

// ---------------------------------------------------------------------------
// Harness — React 19 renders through `act`; there is no testing-library here.
// ---------------------------------------------------------------------------

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

/** Lets the settings-read promise resolve and React commit what it produced. */
async function flush(): Promise<void> {
  await act(async () => {});
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

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  delete window.api;
  // The dismissal is module state by design, so it outlives the component and
  // would otherwise leak into the next case.
  resetSetupDismissed();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function settingsWith(openai: Partial<ApiKeyConfig> = {}): AppSettings {
  return {
    version: 1,
    apiKeys: {
      openai: { key: "", validationStatus: "idle", ...openai },
      openaiAdmin: { key: "", validationStatus: "idle" },
    },
    language: "pt-BR",
    theme: "dark",
    updatedAt: 0,
  };
}

type SettingsApi = ExplainerElectronApi["settings"];

/** Puts a complete preload bridge on the window, with the settings calls the
 *  case cares about swapped in. */
function installBridge(settings: Partial<SettingsApi> = {}): ExplainerElectronApi {
  const api: ExplainerElectronApi = {
    isElectron: true,
    app: {
      platform: "linux",
      openExternal: vi.fn(async () => ({ success: true })),
    },
    settings: {
      get: vi.fn(async () => ({ success: true, data: settingsWith() })),
      saveApiKey: vi.fn(async () => ({ success: true })),
      removeApiKey: vi.fn(async () => ({ success: true })),
      validateApiKey: vi.fn(async () => ({
        success: true,
        data: { valid: true },
      })),
      set: vi.fn(async () => ({ success: true })),
      ...settings,
    },
  };
  window.api = api;
  return api;
}

// ---------------------------------------------------------------------------
// The rule itself
// ---------------------------------------------------------------------------

describe("shouldShowSetup", () => {
  it("never opens in a browser", () => {
    // The browser build has no key store at all, so the screen has nothing to
    // ask for and nothing to save. `window.api` is simply absent there.
    expect(shouldShowSetup({ bridge: undefined, dismissed: false })).toBe(false);
  });

  it("never opens on a half-injected bridge", () => {
    // `contextBridge.exposeInMainWorld` runs inside a try in the preload: a
    // failure partway through leaves the flag without the calls. Believing the
    // flag put a screen over the app that then died on its first IPC call.
    expect(shouldShowSetup({ bridge: { isElectron: true }, dismissed: false })).toBe(
      false,
    );
    expect(
      shouldShowSetup({
        bridge: { isElectron: true, settings: { get: () => Promise.resolve({}) } },
        dismissed: false,
      }),
    ).toBe(false);
  });

  it("never opens on a bridge that cannot open the browser", () => {
    // The settings half arrived and `app.openExternal` did not. The screen
    // dereferences it from the "Onde encontro minha chave?" handler, where a
    // TypeError is not a render error and the boundary above never sees it —
    // so the button would simply be dead on a screen with no way out.
    const complete = installBridge();

    expect(
      shouldShowSetup({
        bridge: { ...complete, app: { platform: "linux" } },
        dismissed: false,
      }),
    ).toBe(false);
    expect(
      shouldShowSetup({ bridge: { ...complete, app: undefined }, dismissed: false }),
    ).toBe(false);
    expect(shouldShowSetup({ bridge: complete, dismissed: false })).toBe(true);
  });

  it("survives the shapes a bridge is never supposed to be", () => {
    for (const bridge of [null, undefined, 0, "", "api", [], true]) {
      expect(hasSetupBridge(bridge)).toBe(false);
    }
  });

  it("opens once, for a complete bridge that has not been answered", () => {
    const api = installBridge();
    expect(shouldShowSetup({ bridge: api, dismissed: false })).toBe(true);
    expect(shouldShowSetup({ bridge: api, dismissed: true })).toBe(false);
  });

  it("reads the window only when there is one to read", () => {
    expect(electronBridge()).toBeUndefined();
    const api = installBridge();
    expect(electronBridge()).toBe(api);
  });
});

// ---------------------------------------------------------------------------
// The browser must never see the setup
// ---------------------------------------------------------------------------

describe("outside Electron", () => {
  it("renders the app and not the setup", async () => {
    const done = vi.fn();
    await mount(
      <SetupScreen onComplete={done}>
        <p>a interface do app</p>
      </SetupScreen>,
    );

    expect(text()).toContain("a interface do app");
    expect(text()).not.toContain("Bem-vindo ao Explainer");
    expect(done).not.toHaveBeenCalled();
  });

  it("renders the app when the bridge is there but unusable", async () => {
    // Only the flag arrived. Reading it was the whole of the old gate.
    window.api = { isElectron: true } as ExplainerElectronApi;
    await mount(
      <SetupScreen onComplete={vi.fn()}>
        <p>a interface do app</p>
      </SetupScreen>,
    );

    expect(text()).toContain("a interface do app");
    expect(text()).not.toContain("Bem-vindo ao Explainer");
  });

  it("renders the app when the bridge cannot open the browser", async () => {
    const api = installBridge();
    window.api = { ...api, app: { platform: "linux" } } as ExplainerElectronApi;

    await mount(
      <SetupScreen onComplete={vi.fn()}>
        <p>a interface do app</p>
      </SetupScreen>,
    );
    await flush();

    expect(text()).toContain("a interface do app");
    expect(text()).not.toContain("OPENAI_API_KEY");
  });
});

// ---------------------------------------------------------------------------
// The one call the screen makes outside the settings store
// ---------------------------------------------------------------------------

describe("the key help link", () => {
  it("goes through the bridge the gate checked", async () => {
    const api = installBridge();

    await mount(<SetupScreen onComplete={vi.fn()} />);
    await flush();
    await click(buttonLabelled("Onde encontro minha chave?"));

    expect(api.app.openExternal).toHaveBeenCalledWith(
      "https://platform.openai.com/api-keys",
    );
  });
});

// ---------------------------------------------------------------------------
// A key that is already saved
// ---------------------------------------------------------------------------

describe("with a key already in the store", () => {
  it("opens the app without asking again, even though the store says 'idle'", async () => {
    // The falsifying case. `settings:save-api-key` persists with
    // `validationStatus: 'idle'` and nothing in the main process ever writes
    // 'valid', so a gate that demanded 'valid' showed the form to a configured
    // user on every single launch, for good.
    vi.useFakeTimers();
    installBridge({
      get: async () => ({
        success: true,
        data: settingsWith({ key: "sk-already-saved", validationStatus: "idle" }),
      }),
    });
    const done = vi.fn();

    await mount(<SetupScreen onComplete={done} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(text()).toContain("Chave configurada");
    expect(text()).not.toContain("OPENAI_API_KEY");
    expect(done).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(done).toHaveBeenCalledTimes(1);
    expect(isSetupDismissed()).toBe(true);
  });

  it("still asks when the store calls the key invalid", async () => {
    // 'invalid' is the one status that is a statement about the key rather than
    // the absence of one, and it is worth a second attempt.
    installBridge({
      get: async () => ({
        success: true,
        data: settingsWith({ key: "sk-rejected", validationStatus: "invalid" }),
      }),
    });

    await mount(<SetupScreen onComplete={vi.fn()} />);
    await flush();

    expect(text()).toContain("OPENAI_API_KEY");
  });

  it("hands over even if the parent re-renders faster than the pause", async () => {
    // `App` passes an inline arrow and re-renders on its own schedule —
    // conversations landing, credits arriving, a toast expiring. With
    // `onComplete` in the effect's dependencies each of those cancelled and
    // restarted the one-second timer, so the checkmark never became the app.
    vi.useFakeTimers();
    installBridge({
      get: async () => ({
        success: true,
        data: settingsWith({ key: "sk-already-saved" }),
      }),
    });
    const done = vi.fn();

    await mount(<SetupScreen onComplete={() => done()} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      await rerender(<SetupScreen onComplete={() => done()} />);
    }

    expect(done).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Every visible way out
// ---------------------------------------------------------------------------

describe("skipping", () => {
  it("drops into the app from the form", async () => {
    installBridge();
    const done = vi.fn();

    await mount(<SetupScreen onComplete={done} />);
    await flush();
    expect(text()).toContain("Bem-vindo ao Explainer");

    await click(buttonLabelled("Pular configuração"));

    expect(done).toHaveBeenCalledTimes(1);
    expect(isSetupDismissed()).toBe(true);
    expect(shouldShowSetup({ bridge: window.api, dismissed: isSetupDismissed() })).toBe(
      false,
    );
  });

  it("drops into the app from the failed read", async () => {
    installBridge({ get: async () => ({ success: false, error: "keyring fechado" }) });
    const done = vi.fn();

    await mount(<SetupScreen onComplete={done} />);
    await flush();
    expect(text()).toContain("Não foi possível ler as configurações");
    expect(text()).toContain("keyring fechado");

    await click(buttonLabelled("Pular configuração"));
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("drops into the app from the skeleton", async () => {
    // Four seconds of bones with no explanation is long enough that a user who
    // never wanted the setup should not have to wait the read out.
    vi.useFakeTimers();
    installBridge({ get: () => new Promise<never>(() => {}) });
    const done = vi.fn();

    await mount(<SetupScreen onComplete={done} />);
    await click(buttonLabelled("Pular configuração"));

    expect(done).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// The read that fails, and the read that never answers
// ---------------------------------------------------------------------------

describe("when the settings store will not answer", () => {
  it("offers a retry that actually re-reads", async () => {
    const get = vi
      .fn<SettingsApi["get"]>()
      .mockRejectedValueOnce(new Error("no handler registered"))
      .mockResolvedValueOnce({ success: true, data: settingsWith() });
    installBridge({ get });

    await mount(<SetupScreen onComplete={vi.fn()} />);
    await flush();
    expect(text()).toContain("Não foi possível ler as configurações");

    await click(buttonLabelled("Tentar novamente"));
    await flush();

    expect(get).toHaveBeenCalledTimes(2);
    expect(text()).toContain("OPENAI_API_KEY");
  });

  it("opens the app rather than waiting on an invoke that never settles", async () => {
    // `ipcRenderer.invoke` on a channel the main process never registered
    // neither resolves nor rejects. Without a bound, the skeleton is the app.
    vi.useFakeTimers();
    installBridge({ get: () => new Promise<never>(() => {}) });
    const done = vi.fn();

    await mount(<SetupScreen onComplete={done} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3999);
    });
    expect(done).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2);
    });
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("does not yank the user off a form it managed to show", async () => {
    // The timeout covers the read, not the screen. A user typing a key at the
    // four-second mark keeps the form.
    vi.useFakeTimers();
    installBridge();
    const done = vi.fn();

    await mount(<SetupScreen onComplete={done} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(done).not.toHaveBeenCalled();
    expect(text()).toContain("OPENAI_API_KEY");
  });
});

// ---------------------------------------------------------------------------
// The crash
// ---------------------------------------------------------------------------

describe("when the screen itself throws", () => {
  function Bomb(): never {
    throw new Error("bridge revoked mid-render");
  }

  it("hands the app over instead of leaving a blank window", async () => {
    // React unmounts the whole tree on an error thrown during render, and
    // before the boundary that tree was the entire application: a white window
    // with no setup, no app and nothing to press.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const done = vi.fn();

    await mount(
      <SetupBoundary onFail={done}>
        <Bomb />
      </SetupBoundary>,
    );

    expect(done).toHaveBeenCalledTimes(1);
    expect(text()).toBe("");
    logged.mockRestore();
  });
});
