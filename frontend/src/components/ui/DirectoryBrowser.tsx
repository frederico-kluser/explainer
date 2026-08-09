"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ChevronRight,
  CornerLeftUp,
  FileText,
  Folder,
  GitBranch,
  Home,
  Loader,
} from "lucide-react";

import { cn } from "@/lib/utils";
import * as api from "@/lib/api";
import { Button } from "@/components/ui/button";
import type { BrowseResult } from "@/types";

export interface DirectoryBrowserProps {
  /** Called with the absolute path of the directory the user settled on. */
  onPick: (path: string) => void;
  busy?: boolean;
}

/**
 * The boxes a finger has to hit, held as data so the suite can measure them.
 *
 * There is no jsdom here, so a rendered row cannot be measured; the class list
 * it is built from can. Read the unprefixed half of each string as the phone
 * and the `md:` half as the desktop this browser already had — the phone floor
 * is 44px, the size of a fingertip, and every string below clears it.
 *
 * The row used to be a single navigate button with a 20px `usar` glued to its
 * right edge. Both actions are irreversible in opposite directions — one walks
 * away from the folder you wanted, the other ends the browse on the wrong one —
 * so they are now two full targets with a rule drawn between them.
 */
export const DIRECTORY_TARGETS = {
  /** "raízes" and "subir". */
  breadcrumb:
    "inline-flex min-h-11 shrink-0 items-center gap-1 rounded-md border border-border px-3 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:min-h-0 md:px-2 md:py-1",
  /** Tapping the name walks into the folder. */
  navigate:
    "flex min-h-11 min-w-0 flex-1 items-center gap-2 px-3 text-left md:min-h-0 md:px-2 md:py-1.5",
  /** The one tap that ends the browse. */
  pick: "inline-flex h-11 min-w-11 shrink-0 items-center justify-center rounded-md border border-border px-3 text-xs text-muted-foreground transition-colors hover:bg-primary hover:text-primary-foreground disabled:opacity-50 md:h-6 md:min-w-0 md:px-1.5 md:text-[10px]",
  /** "Usar esta pasta" — the shared `Button` ships 28px at size `sm`. */
  useCurrent: "h-11 w-full md:h-7",
} as const;

/**
 * Walk the machine to find a repository.
 *
 * Typing an absolute path from memory is the worst part of pointing a tool at a
 * local repo. Directories that are git working trees float to the top and are
 * marked, so the thing you came for is usually the first row.
 */
export function DirectoryBrowser({ onPick, busy = false }: DirectoryBrowserProps) {
  const [result, setResult] = useState<BrowseResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (path?: string) => {
    setLoading(true);
    setError(null);
    try {
      setResult(await api.browse(path));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível listar a pasta.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const current = result?.path ?? null;

  return (
    <div className="space-y-2">
      {/* Where we are, and the ways back */}
      <div className="flex items-center gap-2 text-xs">
        {current && (
          <button
            type="button"
            onClick={() => void load()}
            className={DIRECTORY_TARGETS.breadcrumb}
            title="Voltar aos pontos de partida"
          >
            <Home className="size-3" />
            raízes
          </button>
        )}
        {result?.parent && (
          <button
            type="button"
            onClick={() => void load(result.parent ?? undefined)}
            className={DIRECTORY_TARGETS.breadcrumb}
          >
            <CornerLeftUp className="size-3" />
            subir
          </button>
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
          {current ?? "escolha um ponto de partida"}
        </span>
        {loading && <Loader className="size-3.5 shrink-0 animate-spin text-muted-foreground" />}
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {/* Taller rows show fewer folders in the same box, so the phone gets a
          taller box; the desktop rows did not change and neither does theirs. */}
      <div className="max-h-72 overflow-y-auto rounded-md border border-border bg-background md:max-h-56">
        {result && result.entries.length === 0 && !loading ? (
          <p className="px-3 py-4 text-center text-xs text-muted-foreground">
            Nenhuma subpasta aqui.
          </p>
        ) : (
          <ul className="divide-y divide-border/60">
            {result?.entries.map((entry) => (
              <li key={entry.path}>
                <div className="flex items-center gap-2 pr-2 text-xs hover:bg-accent/40 md:gap-1.5 md:pr-1.5">
                  <button
                    type="button"
                    onClick={() => void load(entry.path)}
                    className={DIRECTORY_TARGETS.navigate}
                    title={entry.path}
                  >
                    {entry.is_repo ? (
                      <GitBranch className="size-3.5 shrink-0 text-primary" />
                    ) : (
                      <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate",
                        entry.is_repo ? "text-foreground" : "text-muted-foreground",
                      )}
                    >
                      {entry.name}
                    </span>
                    {entry.has_doc && (
                      <FileText
                        className="size-3 shrink-0 text-muted-foreground/70"
                        aria-label="tem README"
                      />
                    )}
                    <ChevronRight className="size-3 shrink-0 text-muted-foreground/50" />
                  </button>

                  {/* The rule is the only thing on screen that says the row
                      and the button are two different answers. */}
                  <span
                    aria-hidden
                    className="my-2 w-px shrink-0 self-stretch bg-border md:my-1"
                  />

                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onPick(entry.path)}
                    className={DIRECTORY_TARGETS.pick}
                    title={`Usar ${entry.name}`}
                  >
                    usar
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {current && (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => onPick(current)}
          className={DIRECTORY_TARGETS.useCurrent}
        >
          {busy ? (
            <Loader className="size-4 animate-spin" />
          ) : (
            <>Usar esta pasta{result?.self?.is_repo ? " (repositório)" : ""}</>
          )}
        </Button>
      )}
    </div>
  );
}
