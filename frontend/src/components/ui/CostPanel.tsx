"use client";

import { useState } from "react";
import { ChevronDown, RefreshCw, Wallet } from "lucide-react";

import { cn } from "@/lib/utils";
import type { CostSummary, ProviderCredit } from "@/types";

export interface CostPanelProps {
  /** Spent in the session currently open, priced live from `response.done`. */
  sessionUsd: number;
  /** Everything this conversation has ever cost, from the server's ledger. */
  costs: CostSummary | null;
  credits: ProviderCredit[];
  refreshing: boolean;
  onRefresh: () => void;
}

const SOURCE_LABELS: Record<string, string> = {
  realtime: "conversa por voz",
  web_search: "busca na web",
  pi_agent: "agentes pi",
  text: "texto",
};

/** Fractions of a cent are the normal case here, so never round them away. */
function usd(value: number | null): string {
  if (value === null) return "—";
  if (value === 0) return "$0";
  if (Math.abs(value) < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

export function CostPanel({
  sessionUsd,
  costs,
  credits,
  refreshing,
  onRefresh,
}: CostPanelProps) {
  const [open, setOpen] = useState(false);

  const total = Math.max(costs?.total_usd ?? 0, sessionUsd);
  const breakdown = Object.entries(costs?.by_source ?? {}).filter(
    ([, value]) => value > 0,
  );

  return (
    <div className="border-t border-border px-3 py-2">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <Wallet className="size-3.5" />
        <span className="font-medium">Custo</span>
        <span className="ml-auto tabular-nums text-foreground">{usd(total)}</span>
        <ChevronDown
          className={cn("size-3.5 transition-transform", open && "rotate-180")}
        />
      </button>

      {open && (
        <div className="space-y-3 px-1 pb-2 pt-2">
          <div className="space-y-1">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Esta conversa
            </p>
            {breakdown.length === 0 ? (
              <p className="text-xs text-muted-foreground">Nada gasto ainda.</p>
            ) : (
              breakdown.map(([source, value]) => (
                <div key={source} className="flex justify-between text-xs">
                  <span className="text-muted-foreground">
                    {SOURCE_LABELS[source] ?? source}
                  </span>
                  <span className="tabular-nums text-foreground">{usd(value)}</span>
                </div>
              ))
            )}
          </div>

          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Saldo dos provedores
              </p>
              <button
                type="button"
                onClick={onRefresh}
                className="text-muted-foreground transition-colors hover:text-foreground"
                aria-label="Atualizar saldos"
                title="Atualizar saldos"
              >
                <RefreshCw
                  className={cn("size-3", refreshing && "animate-spin")}
                />
              </button>
            </div>

            {credits.length === 0 ? (
              <p className="text-xs text-muted-foreground">Carregando…</p>
            ) : (
              credits.map((credit) => (
                <div key={credit.provider} className="text-xs">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-muted-foreground">{credit.label}</span>
                    <span
                      className={cn(
                        "tabular-nums",
                        credit.status === "ok"
                          ? "text-foreground"
                          : "text-muted-foreground",
                      )}
                    >
                      {credit.remaining_usd !== null
                        ? usd(credit.remaining_usd)
                        : credit.used_usd !== null
                          ? `${usd(credit.used_usd)} gastos`
                          : "—"}
                    </span>
                  </div>
                  {credit.status !== "ok" && credit.note && (
                    <p className="pt-0.5 text-[10px] leading-snug text-muted-foreground/70">
                      {credit.note}
                    </p>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
