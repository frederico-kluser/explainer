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
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
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
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
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

      <div className="max-h-56 overflow-y-auto rounded-md border border-border bg-background">
        {result && result.entries.length === 0 && !loading ? (
          <p className="px-3 py-4 text-center text-xs text-muted-foreground">
            Nenhuma subpasta aqui.
          </p>
        ) : (
          <ul className="divide-y divide-border/60">
            {result?.entries.map((entry) => (
              <li key={entry.path}>
                <div className="flex items-center gap-2 px-2 py-1.5 text-xs hover:bg-accent/40">
                  <button
                    type="button"
                    onClick={() => void load(entry.path)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
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

                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onPick(entry.path)}
                    className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-primary hover:text-primary-foreground disabled:opacity-50"
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
          className="w-full"
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
