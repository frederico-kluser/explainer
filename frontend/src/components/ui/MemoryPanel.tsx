"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Brain,
  ChevronDown,
  Download,
  Loader,
  Trash2,
  Upload,
} from "lucide-react";

import * as api from "@/lib/api";
import { cn } from "@/lib/utils";
import type { MemoryFile } from "@/types";

export interface MemoryPanelProps {
  /** `null` closes the panel: there is nothing to remember yet. */
  conversationId: string | null;
  /** Change it to force a reload — after a call ends, the memory has grown. */
  refreshToken?: number | string;
  /** Fired after an import or a delete lands, so the app can refetch. */
  onChanged?: () => void;
}

// ---------------------------------------------------------------------------
// The four routes this panel drives
// ---------------------------------------------------------------------------
//
// All four go through `lib/api.ts`: `getMemory` (404 → `null`),
// `memoryDownloadUrl`, `importMemory(…, { overwrite })` and `clearMemory`. That
// client exports `ApiError` with its `status` for exactly the 409 below, so the
// panel reads a status instead of re-parsing a body.
//
// What the client must never do, and does not, is flatten that 409: the backend
// answers it with a sentence written for the user, counting what an overwrite
// would destroy and naming both ways out. Reduced to `Error("HTTP 409")` it
// takes the decision away from the person making it, which is why the message is
// shown here exactly as it arrived.

/** The server's own words when it has them, a generic line when it does not. */
function describeFailure(err: unknown): string {
  return err instanceof api.ApiError
    ? err.message
    : "Não consegui falar com o servidor.";
}

/** What the header line shows, distilled from the file. */
interface MemorySummary {
  title: string;
  events: number;
  reflections: number;
  diagrams: number;
  updated_at: string;
}

function summarise(file: MemoryFile): MemorySummary {
  return {
    title: file.title,
    events: file.events.length,
    reflections: file.events.filter((event) => event.kind === "reflection")
      .length,
    diagrams: file.diagrams?.length ?? 0,
    updated_at: file.updated_at,
  };
}

/**
 * The ceiling `express.json({ limit: "25mb" })` puts on the import route
 * (`backend/src/index.ts`). Anything above it is a guaranteed 413, so reading it
 * into memory first is pure cost.
 */
const MEMORY_IMPORT_MAX_BYTES = 25 * 1024 * 1024;

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
}

function formatMoment(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * The conversation's memory, as a file you can take away and bring back.
 *
 * Three of the four buttons here are ordinary. The fourth is not: importing
 * *replaces*, so importing onto a conversation that already remembers something
 * destroys reflections that cost a deep-think round each, with no undo and no
 * backup anywhere. The backend refuses that by default and answers 409 with a
 * sentence naming both ways out; this panel shows that sentence unedited and
 * makes the user say the word before it retries with `?overwrite=true`.
 */
export function MemoryPanel({
  conversationId,
  refreshToken,
  onChanged,
}: MemoryPanelProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<MemorySummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // The backend's own 409 sentence, held verbatim, plus the file that provoked
  // it — so confirming does not ask the user to find the file a second time.
  const [conflict, setConflict] = useState<string | null>(null);
  const [pendingImport, setPendingImport] = useState<unknown>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    if (!conversationId) return;
    setLoading(true);
    setError(null);
    try {
      // A conversation nobody has spoken to yet has no file, and `getMemory`
      // answers `null` for it. That is the starting state of every conversation,
      // not a failure to report — a broken server still throws.
      const file = await api.getMemory(conversationId);
      setSummary(file ? summarise(file) : null);
    } catch (err) {
      setError(describeFailure(err));
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  useEffect(() => {
    setSummary(null);
    setError(null);
    setNotice(null);
    setConflict(null);
    setPendingImport(null);
    setConfirmingDelete(false);
    void load();
  }, [load, refreshToken]);

  const sendImport = useCallback(
    async (payload: unknown, overwrite: boolean) => {
      if (!conversationId) return;
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        await api.importMemory(conversationId, payload, { overwrite });
        setConflict(null);
        setPendingImport(null);
        setNotice("Memória importada.");
        await load();
        onChanged?.();
      } catch (err) {
        if (err instanceof api.ApiError && err.status === 409) {
          // Shown as written. The message counts the events and reflections
          // that would be lost and names both ways out; a summary of it would
          // drop exactly the numbers that make the decision.
          setConflict(err.message);
          setPendingImport(payload);
          return;
        }
        setConflict(null);
        setPendingImport(null);
        setError(describeFailure(err));
      } finally {
        setBusy(false);
      }
    },
    [conversationId, load, onChanged],
  );

  const onFilePicked = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      // Cleared immediately so picking the same file twice fires `change` again
      // — after a cancelled overwrite, the second attempt is the common case.
      event.target.value = "";
      if (!file) return;

      setConflict(null);
      setPendingImport(null);
      setNotice(null);

      // Checked before the file is read, not after. `file.text()` decodes the
      // whole thing on the main thread and `JSON.stringify` in `sendImport`
      // makes a second full copy of it, so a 200 MB file freezes the tab for
      // seconds and then earns a 413 anyway — the route's own parser stops at
      // 25 mb. Refusing here costs nothing and says something.
      if (file.size > MEMORY_IMPORT_MAX_BYTES) {
        setError(
          `"${file.name}" tem ${formatMegabytes(file.size)} e o limite para importar é ` +
            `${formatMegabytes(MEMORY_IMPORT_MAX_BYTES)}.`,
        );
        return;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(await file.text());
      } catch {
        setError(`"${file.name}" não é um JSON válido.`);
        return;
      }
      await sendImport(payload, false);
    },
    [sendImport],
  );

  const remove = useCallback(async () => {
    if (!conversationId) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.clearMemory(conversationId);
      setConfirmingDelete(false);
      setConflict(null);
      setPendingImport(null);
      setNotice("Memória apagada.");
      await load();
      onChanged?.();
    } catch (err) {
      setError(describeFailure(err));
    } finally {
      setBusy(false);
    }
  }, [conversationId, load, onChanged]);

  if (!conversationId) return null;

  return (
    <div className="border-t border-border px-3 py-2" data-role="memory-panel">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <Brain className="size-3.5" />
        <span className="font-medium">Memória</span>
        <span className="ml-auto tabular-nums text-foreground">
          {loading ? "…" : summary ? `${summary.events}` : "vazia"}
        </span>
        <ChevronDown
          className={cn("size-3.5 transition-transform", open && "rotate-180")}
        />
      </button>

      {open && (
        <div className="space-y-2 px-1 pb-2 pt-2 text-xs">
          {summary ? (
            <div className="space-y-0.5 text-muted-foreground">
              <p className="truncate text-foreground">{summary.title}</p>
              <p className="tabular-nums">
                {summary.events}{" "}
                {summary.events === 1 ? "evento" : "eventos"}
                {summary.reflections > 0 &&
                  ` · ${summary.reflections} ${
                    summary.reflections === 1 ? "reflexão" : "reflexões"
                  }`}
                {summary.diagrams > 0 &&
                  ` · ${summary.diagrams} ${
                    summary.diagrams === 1 ? "diagrama" : "diagramas"
                  }`}
              </p>
              <p>Atualizada em {formatMoment(summary.updated_at)}</p>
            </div>
          ) : (
            <p className="text-muted-foreground">
              {loading
                ? "Carregando…"
                : "Esta conversa ainda não tem memória gravada."}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {/* The route already answers with a Content-Disposition naming the
                file, so the browser saves it. Building a Blob here would put a
                second, worse filename in front of the one the server chose. */}
            {summary && (
              <a
                href={api.memoryDownloadUrl(conversationId)}
                className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-muted-foreground transition-colors hover:text-foreground"
              >
                <Download className="size-3" />
                Exportar
              </a>
            )}

            <button
              type="button"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
            >
              {busy ? (
                <Loader className="size-3 animate-spin" />
              ) : (
                <Upload className="size-3" />
              )}
              Importar
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(event) => void onFilePicked(event)}
            />

            {summary &&
              (confirmingDelete ? (
                <span className="inline-flex items-center gap-1">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void remove()}
                    className="rounded-md border border-destructive/50 px-2 py-1 text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
                  >
                    Apagar mesmo
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingDelete(false)}
                    className="rounded-md px-2 py-1 text-muted-foreground transition-colors hover:text-foreground"
                  >
                    Cancelar
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirmingDelete(true)}
                  className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-muted-foreground transition-colors hover:text-destructive disabled:opacity-50"
                >
                  <Trash2 className="size-3" />
                  Apagar
                </button>
              ))}
          </div>

          {conflict && (
            <div
              data-role="memory-conflict"
              className="space-y-1.5 rounded-md border border-destructive/40 bg-destructive/5 p-2"
            >
              <p className="flex items-start gap-1.5 text-destructive">
                <AlertTriangle className="mt-px size-3.5 shrink-0" />
                <span className="leading-snug">{conflict}</span>
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void sendImport(pendingImport, true)}
                  className="rounded-md border border-destructive/50 px-2 py-1 text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
                >
                  Importar por cima assim mesmo
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setConflict(null);
                    setPendingImport(null);
                  }}
                  className="rounded-md px-2 py-1 text-muted-foreground transition-colors hover:text-foreground"
                >
                  Cancelar
                </button>
              </div>
            </div>
          )}

          {error && (
            <p className="flex items-start gap-1.5 text-destructive">
              <AlertTriangle className="mt-px size-3.5 shrink-0" />
              <span className="leading-snug">{error}</span>
            </p>
          )}

          {notice && <p className="text-muted-foreground">{notice}</p>}
        </div>
      )}
    </div>
  );
}
