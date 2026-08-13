/** @vitest-environment happy-dom */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { WebSearchCard } from "@/components/ui/WebSearchCard";
import type { WebSearchJob } from "@/types";

// The card is the part of the web-search feature the browser actually renders,
// and it draws `activity`/`status`/`cost_usd`/`error` straight from the fold's
// state — the same fields the fold's tests feed it. These cases pin the
// render-side contract: a running search with no phase yet, a finished one
// with and without a price, a failure with and without words, and a status
// nothing in this codebase emits.

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

function text(): string {
  return container?.textContent ?? "";
}

function job(overrides: Partial<WebSearchJob> = {}): WebSearchJob {
  return {
    id: "s1",
    conversation_id: "550e8400-e29b-41d4-a716-446655440000",
    query: "",
    status: "running",
    activity: "",
    started_at: "2026-08-13T12:00:00.000Z",
    ...overrides,
  };
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  document.body.innerHTML = "";
});

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

describe("a running search", () => {
  it("falls back to the status when no phase has arrived yet", async () => {
    await mount(<WebSearchCard job={job()} />);

    expect(text()).toContain("Busca web — running");
    // The spinner is the Loader; a finished search swaps it for the Globe.
    expect(container?.querySelector("svg.animate-spin")).not.toBeNull();
    expect(text()).not.toContain("$");
  });

  it("shows the phase the stream reported", async () => {
    await mount(<WebSearchCard job={job({ activity: "pesquisando" })} />);

    expect(text()).toContain("Busca web — pesquisando");
    expect(text()).not.toContain("running");
  });
});

// ---------------------------------------------------------------------------
// Done
// ---------------------------------------------------------------------------

describe("a finished search", () => {
  it("shows the price on both the desktop span and the mobile line", async () => {
    await mount(
      <WebSearchCard
        job={job({ status: "done", activity: "concluido", result: "achei", cost_usd: 0.02 })}
      />,
    );

    expect(text()).toContain("Busca web — concluido");
    // `hidden md:inline` and `md:hidden` are CSS, not mounting decisions: the
    // price is rendered twice so each breakpoint has its own line.
    expect(text().match(/\$0\.0200/g)).toHaveLength(2);
    expect(container?.querySelector("svg.animate-spin")).toBeNull();
  });

  it("renders a zero cost — the guard is presence, not truthiness", async () => {
    await mount(<WebSearchCard job={job({ status: "done", cost_usd: 0 })} />);

    expect(text()).toContain("$0.0000");
  });

  it("shows no price when the search never reported one", async () => {
    await mount(<WebSearchCard job={job({ status: "done", activity: "concluido" })} />);

    expect(text()).toContain("Busca web — concluido");
    expect(text()).not.toContain("$");
  });
});

// ---------------------------------------------------------------------------
// Failed
// ---------------------------------------------------------------------------

describe("a failed search", () => {
  it("shows the reason the server gave", async () => {
    await mount(
      <WebSearchCard job={job({ status: "error", activity: "falhou", error: "sem credito" })} />,
    );

    expect(text()).toContain("Busca web — falhou");
    expect(text()).toContain("sem credito");
  });

  it("shows no reason paragraph when the server said nothing", async () => {
    await mount(<WebSearchCard job={job({ status: "error", activity: "falhou" })} />);

    expect(text()).toContain("Busca web — falhou");
    // Only the error paragraph carries the raw reason; an absent one renders
    // as an empty card, never as a stray undefined on screen.
    expect(text()).not.toContain("undefined");
  });
});

// ---------------------------------------------------------------------------
// Unknown states and the test hook
// ---------------------------------------------------------------------------

describe("a status nothing emits", () => {
  it("renders it as the phase instead of exploding", async () => {
    await mount(<WebSearchCard job={job({ status: "queued" as WebSearchJob["status"] })} />);

    expect(text()).toContain("Busca web — queued");
  });
});

describe("the card's test hook", () => {
  // The line shows `activity || status`, and the states below arrived with no
  // activity — so each one pins the raw status ("cancelled" included) as the
  // text a real search with no phase would render.
  it.each(["running", "done", "error", "cancelled"] as const)(
    'renders "Busca web — %s" and carries data-role="web-search" in the %s state',
    async (status) => {
      await mount(<WebSearchCard job={job({ status })} />);

      expect(text()).toContain(`Busca web — ${status}`);
      expect(container?.querySelector('[data-role="web-search"]')).not.toBeNull();
    },
  );
});
