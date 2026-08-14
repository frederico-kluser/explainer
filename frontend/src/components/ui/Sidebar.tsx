"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, MessageSquare, Plus, Search, Trash2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { resolveModeIcon } from "@/components/ui/mode-icons";
import { useMotionUITransition } from "@/components/motion-ui/ui-theme";
import type { Conversation } from "@/types";

export interface SidebarProps {
  conversations: Conversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onOpenPalette: () => void;
  /**
   * Each conversation's mode, keyed by mode id, so the list can show the kind
   * of conversation an item is. Absent — modes not loaded — every item keeps
   * the generic icon.
   */
  modesById?: ReadonlyMap<string, { icon: string; label: string }>;
  /** Rendered under the conversation list: agents, settings, costs. */
  children?: React.ReactNode;
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const minutes = Math.round((Date.now() - then) / 60_000);
  if (minutes < 1) return "agora";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} d`;
  return new Date(iso).toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
  });
}

/**
 * The left rail.
 *
 * One list, one action, no chrome. Creating a conversation belongs here rather
 * than in the header: it is the same kind of thing as picking one, and the
 * header is for the state of the *call*, not for navigation.
 */
export function Sidebar({
  conversations,
  activeId,
  onSelect,
  onCreate,
  onDelete,
  onRename,
  onOpenPalette,
  modesById,
  children,
}: SidebarProps) {
  const transition = useMotionUITransition("gentle");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const editRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingId) editRef.current?.select();
  }, [editingId]);

  // A stray click anywhere else means "no, I didn't mean to delete that".
  useEffect(() => {
    if (!confirmingId) return;
    const cancel = () => setConfirmingId(null);
    const timer = setTimeout(cancel, 4000);
    window.addEventListener("click", cancel);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("click", cancel);
    };
  }, [confirmingId]);

  const startEditing = useCallback((conversation: Conversation) => {
    setEditingId(conversation.id);
    setDraft(conversation.title);
  }, []);

  const commit = useCallback(() => {
    if (editingId && draft.trim()) onRename(editingId, draft.trim());
    setEditingId(null);
  }, [draft, editingId, onRename]);

  return (
    <aside className="flex w-72 shrink-0 flex-col border-r border-border bg-muted/20">
      {/* Brand + primary action */}
      <div className="space-y-3 border-b border-border px-3 py-3">
        <div className="flex items-center gap-2 px-1">
          <span className="text-base" aria-hidden="true">
            &#x1F5E3;
          </span>
          <span className="text-sm font-semibold text-foreground">Explainer</span>
          <button
            type="button"
            onClick={onOpenPalette}
            className="ml-auto inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="Buscar conversas (⌘K)"
          >
            <Search className="size-3" />
            <span className="font-mono">⌘K</span>
          </button>
        </div>

        <button
          type="button"
          onClick={onCreate}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
        >
          <Plus className="size-4" />
          Nova conversa
        </button>
      </div>

      {/* Conversation list */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        <p className="px-2 pb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          Conversas
        </p>

        {conversations.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">
            Nenhuma conversa ainda.
          </p>
        ) : (
          <ul className="space-y-0.5">
            <AnimatePresence initial={false}>
              {conversations.map((conversation) => {
                const active = conversation.id === activeId;
                const editing = editingId === conversation.id;

                // The mode this conversation was created in. A conversation
                // older than the feature has no `metadata.mode`, and a mode
                // the list has not loaded is unknown — both keep the generic
                // icon and the plain title, byte for byte.
                const storedModeId = conversation.metadata?.mode;
                const mode =
                  typeof storedModeId === "string"
                    ? modesById?.get(storedModeId)
                    : undefined;
                const ModeIcon = mode
                  ? resolveModeIcon(mode.icon)
                  : MessageSquare;

                return (
                  <motion.li
                    key={conversation.id}
                    layout
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={transition}
                    className="group relative"
                  >
                    {active && (
                      <motion.span
                        layoutId="sidebar-active"
                        transition={transition}
                        className="absolute inset-y-0 left-0 w-0.5 rounded-full bg-primary"
                      />
                    )}

                    {editing ? (
                      <input
                        ref={editRef}
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        onBlur={commit}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") commit();
                          if (event.key === "Escape") setEditingId(null);
                        }}
                        className="w-full rounded-md border border-primary bg-background px-2.5 py-2 text-sm text-foreground outline-none"
                      />
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => onSelect(conversation.id)}
                          onDoubleClick={() => startEditing(conversation)}
                          className={cn(
                            "flex w-full items-center gap-2 rounded-md py-2 pl-2.5 pr-9 text-left text-sm transition-colors",
                            active
                              ? "bg-accent text-foreground"
                              : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                          )}
                          title={
                            mode
                              ? `Conversa · ${mode.label} — clique para abrir, dois cliques para renomear`
                              : "Clique para abrir, dois cliques para renomear"
                          }
                        >
                          <ModeIcon className="size-3.5 shrink-0 opacity-60" />
                          <span className="min-w-0 flex-1 truncate">
                            {conversation.title}
                          </span>
                          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground group-hover:opacity-0">
                            {relativeTime(conversation.updated_at)}
                          </span>
                        </button>

                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            if (confirmingId === conversation.id) {
                              onDelete(conversation.id);
                              setConfirmingId(null);
                            } else {
                              setConfirmingId(conversation.id);
                            }
                          }}
                          className={cn(
                            "absolute right-1.5 top-1/2 hidden -translate-y-1/2 rounded p-1 transition-colors group-hover:block",
                            confirmingId === conversation.id
                              ? "text-destructive"
                              : "text-muted-foreground hover:text-destructive",
                          )}
                          aria-label={
                            confirmingId === conversation.id
                              ? `Confirmar exclusão de ${conversation.title}`
                              : `Apagar ${conversation.title}`
                          }
                          title={
                            confirmingId === conversation.id
                              ? "Clique de novo para apagar"
                              : "Apagar conversa"
                          }
                        >
                          {confirmingId === conversation.id ? (
                            <Check className="size-3.5" />
                          ) : (
                            <Trash2 className="size-3.5" />
                          )}
                        </button>
                      </>
                    )}
                  </motion.li>
                );
              })}
            </AnimatePresence>
          </ul>
        )}
      </div>

      {children}
    </aside>
  );
}
