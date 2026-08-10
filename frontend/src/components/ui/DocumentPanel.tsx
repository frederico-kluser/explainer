"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FileText } from "lucide-react";
import * as api from "@/lib/api";

export interface DocumentPanelProps {
  conversationId: string | null;
  /** Server truth — the latest content known to the session hook. */
  content: string;
  /** Called when the user's edit was saved so the App can adopt the stored text. */
  onContentChange: (content: string) => void;
}

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
 * A split-pane markdown editor + preview.
 *
 * The user types on the left; a debounced PUT saves to the server. The right
 * side renders a simple markdown preview. When the model edits the document
 * (content changes from the outside), the textarea syncs — unless the user is
 * currently focused in it, in which case the update is deferred until blur.
 */
export function DocumentPanel({
  conversationId,
  content,
  onContentChange,
}: DocumentPanelProps) {
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

  return (
    <div className="flex h-full flex-col">
      {/* Status bar */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
        <FileText className="size-3.5 text-muted-foreground" />
        <span className="text-xs text-muted-foreground">
          {draft.length.toLocaleString("pt-BR")} caracteres
        </span>
        <span className="flex-1" />
        {saving && (
          <span className="text-xs text-muted-foreground">Salvando...</span>
        )}
        {savedLabel && (
          <span className="text-xs text-emerald-400">{savedLabel}</span>
        )}
        {saveError && (
          <span className="text-xs text-destructive">{saveError}</span>
        )}
        <span className="text-[10px] text-muted-foreground">
          Markdown — o assistente edita junto com voce
        </span>
      </div>

      {/* Editor + Preview */}
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {/* Editor */}
        <textarea
          value={draft}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => {
            focusedRef.current = true;
          }}
          onBlur={onBlur}
          spellCheck={false}
          placeholder={
            content
              ? undefined
              : "Nenhum documento ainda. Peça ao assistente para criar um plano, ou comece a escrever — o primeiro texto salvo cria o documento."
          }
          className="min-h-0 flex-1 resize-none border-r border-border bg-transparent p-4 font-mono text-sm text-foreground outline-none placeholder:text-muted-foreground"
        />

        {/* Preview */}
        <div
          className="min-h-0 flex-1 overflow-y-auto p-4 text-sm text-foreground"
          dangerouslySetInnerHTML={{ __html: previewHtml }}
        />
      </div>
    </div>
  );
}
