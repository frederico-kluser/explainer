"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import * as api from "@/lib/api";

export interface DocumentPanelProps {
  conversationId: string | null;
  /** Server truth — the latest content known to the session hook. */
  content: string;
  /**
   * What to say while the document is empty. Comes from the mode, so a
   * presentation conversation explains a script and a normal one explains
   * notes, without this component knowing either exists.
   */
  placeholder?: string;
  /** Called when the user's edit was saved so the App can adopt the stored text. */
  onContentChange: (content: string) => void;
}

const DEFAULT_PLACEHOLDER =
  "Nenhum documento ainda. Peça ao assistente para começar, ou escreva você — o primeiro texto salvo cria o documento.";

// ---------------------------------------------------------------------------
// Tiny markdown → HTML renderer (no dependency)
// ---------------------------------------------------------------------------

function renderMarkdown(text: string): string {
  if (!text) return "";

  let html = text
    // Escape HTML first — everything else is safe after this
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Code blocks ```...```
  html = html.replace(
    /```(\w*)\n([\s\S]*?)```/g,
    (_: string, lang: string, code: string) =>
      `<pre class="rounded-md bg-muted/50 p-3 overflow-x-auto text-xs"><code>${
        lang ? `<span class="text-muted-foreground">${lang}</span>\n` : ""
      }${code.trim()}</code></pre>`,
  );

  // Inline code `...`
  html = html.replace(
    /`([^`]+)`/g,
    '<code class="rounded bg-muted/50 px-1 py-0.5 text-xs">$1</code>',
  );

  // Headings
  html = html.replace(/^#### (.+)$/gm, '<h4 class="text-sm font-semibold mt-4 mb-1">$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3 class="text-base font-semibold mt-4 mb-1">$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2 class="text-lg font-semibold mt-5 mb-2">$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1 class="text-xl font-bold mt-5 mb-2">$1</h1>');

  // Bold and italic
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");

  // Links [text](url)
  html = html.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" class="text-primary underline" target="_blank" rel="noopener noreferrer">$1</a>',
  );

  // Unordered lists — lines starting with "- " or "* "
  html = html.replace(/^[-*] (.+)$/gm, '<li class="ml-4 list-disc">$1</li>');

  // Paragraphs: double newlines
  html = html.replace(/\n\n+/g, "</p><p>");
  // Single newlines inside a paragraph
  html = html.replace(/\n/g, "<br>");

  return `<p>${html}</p>`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * The markdown, read or edited, one at a time.
 *
 * Reading and editing are two views rather than two halves of a split, and that
 * is a consequence of where this lives: a sidebar is 300 to 700 pixels wide,
 * and a split at that width gives each side less than a paragraph. Reading is
 * the default because it is what the person does most — the assistant is the
 * one writing.
 *
 * A debounced PUT saves the draft. When the document changes from the outside —
 * the model wrote, or somebody on another screen did — the textarea adopts it,
 * unless the caret is currently in it, in which case the update waits for blur
 * rather than eating a sentence mid-word.
 */
export function DocumentPanel({
  conversationId,
  content,
  placeholder,
  onContentChange,
}: DocumentPanelProps) {
  const [view, setView] = useState<"read" | "edit">("read");
  const [draft, setDraft] = useState(content);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedLabel, setSavedLabel] = useState<string | null>(null);
  const focusedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  // Sync from outside when the textarea is not focused.
  useEffect(() => {
    if (!focusedRef.current && content !== draftRef.current) {
      setDraft(content);
    }
  }, [content]);

  // Clear saved label after 2 s.
  useEffect(() => {
    if (!savedLabel) return;
    const t = setTimeout(() => setSavedLabel(null), 2000);
    return () => clearTimeout(t);
  }, [savedLabel]);

  const flush = useCallback(
    async (text: string) => {
      if (!conversationId) return;
      setSaving(true);
      setSaveError(null);
      try {
        const stored = await api.updateDocument(conversationId, text);
        onContentChange(stored);
        setSavedLabel("Salvo");
      } catch {
        setSaveError("Erro ao salvar");
      } finally {
        setSaving(false);
      }
    },
    [conversationId, onContentChange],
  );

  const onChange = useCallback(
    (value: string) => {
      setDraft(value);
      setSavedLabel(null);
      setSaveError(null);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        void flush(value);
      }, 700);
    },
    [flush],
  );

  const onBlur = useCallback(() => {
    focusedRef.current = false;
    // Flush immediately on blur so no keystroke is lost.
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    void flush(draftRef.current);
  }, [flush]);

  // Cleanup timer on unmount.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const previewHtml = renderMarkdown(draft);

  const empty = draft.trim().length === 0;

  return (
    <div className="flex h-full flex-col">
      {/* Status bar */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
        <div
          className="flex items-center gap-0.5 rounded-md bg-muted/40 p-0.5"
          role="tablist"
          aria-label="Ver ou editar"
        >
          {(["read", "edit"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={view === value}
              onClick={() => setView(value)}
              className={cn(
                "rounded px-2 py-0.5 text-[11px] font-medium transition-colors",
                view === value
                  ? "bg-background text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {value === "read" ? "Ler" : "Editar"}
            </button>
          ))}
        </div>

        <span className="text-[11px] tabular-nums text-muted-foreground">
          {draft.length.toLocaleString("pt-BR")}
        </span>

        <span className="flex-1" />

        {saving && (
          <span className="text-[11px] text-muted-foreground">Salvando…</span>
        )}
        {savedLabel && (
          <span className="text-[11px] text-emerald-400">{savedLabel}</span>
        )}
        {saveError && (
          <span className="text-[11px] text-destructive">{saveError}</span>
        )}
      </div>

      {view === "edit" ? (
        <textarea
          value={draft}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => {
            focusedRef.current = true;
          }}
          onBlur={onBlur}
          spellCheck={false}
          placeholder={placeholder ?? DEFAULT_PLACEHOLDER}
          // 16px on a phone: iOS Safari zooms the page in when a field under
          // 16px takes focus, and it never zooms back out.
          className="min-h-0 flex-1 resize-none bg-transparent p-4 font-mono text-base text-foreground outline-none placeholder:text-muted-foreground md:text-sm"
        />
      ) : empty ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <p className="max-w-xs text-center text-sm text-muted-foreground">
            {placeholder ?? DEFAULT_PLACEHOLDER}
          </p>
        </div>
      ) : (
        <div
          className="min-h-0 flex-1 overflow-y-auto p-4 text-sm text-foreground"
          // `renderMarkdown` escapes the document before it builds any tag, so
          // nothing the model or the user writes can reach the DOM as markup.
          dangerouslySetInnerHTML={{ __html: previewHtml }}
        />
      )}
    </div>
  );
}
