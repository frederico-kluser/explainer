"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  FileText,
  FolderGit2,
  FolderSearch,
  Laptop,
  Link2,
  Loader,
  Plus,
  Upload,
  X,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { useMotionUITransition } from "@/components/motion-ui/ui-theme";
import { Button } from "@/components/ui/button";
import { DirectoryBrowser } from "@/components/ui/DirectoryBrowser";
import type { Material, SourceKind, SourceSpec } from "@/types";

export interface MaterialPickerProps {
  materials: Material[];
  busy: boolean;
  disabled?: boolean;
  onAdd: (spec: SourceSpec) => void;
  onRemove: (materialId: string) => void;
}

const TABS: Array<{
  kind: SourceKind;
  label: string;
  hint: string;
  icon: typeof FolderGit2;
}> = [
  {
    kind: "repo",
    label: "Repositório",
    hint: "Do GitHub ou uma pasta desta máquina. Leio o README, procuro no código e disparo agentes pi.",
    icon: FolderGit2,
  },
  {
    kind: "markdown",
    label: "Markdown",
    hint: "Documento solto: respondo por ele e busco na internet.",
    icon: FileText,
  },
  {
    kind: "machine",
    label: "Meu computador",
    hint: "A documentação da máquina em Projects/config.",
    icon: Laptop,
  },
];

const KIND_ICON: Record<SourceKind, typeof FolderGit2> = {
  repo: FolderGit2,
  markdown: FileText,
  machine: Laptop,
};

/**
 * What the conversation is about.
 *
 * A conversation holds several materials at once — a repository plus the spec
 * that describes it, the machine docs plus the README of the thing you are
 * installing — so this is a list you add to and remove from, not a switch.
 */
export function MaterialPicker({
  materials,
  busy,
  disabled = false,
  onAdd,
  onRemove,
}: MaterialPickerProps) {
  const [adding, setAdding] = useState(materials.length === 0);
  const [kind, setKind] = useState<SourceKind>("repo");
  const [repoMode, setRepoMode] = useState<"url" | "browse">("url");
  const [ref, setRef] = useState("");
  const [markdown, setMarkdown] = useState("");
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const transition = useMotionUITransition("gentle");

  // Collapse the form once the material lands, so the list of what you have is
  // what you see; the "adicionar material" chip reopens it. An empty list opens
  // it back up, because there is nothing else to look at.
  const previousCount = useRef(materials.length);
  useEffect(() => {
    if (materials.length > previousCount.current) setAdding(false);
    if (materials.length === 0) setAdding(true);
    previousCount.current = materials.length;
  }, [materials.length]);

  const readFile = useCallback(
    (file: File) => {
      void file.text().then((text) => {
        onAdd({ kind: "markdown", markdown: text, label: file.name });
        setMarkdown("");
      });
    },
    [onAdd],
  );

  const submit = useCallback(() => {
    if (busy || disabled) return;
    if (kind === "machine") {
      onAdd({ kind: "machine" });
      return;
    }
    if (kind === "repo") {
      if (!ref.trim()) return;
      onAdd({ kind: "repo", ref: ref.trim() });
      setRef("");
      return;
    }
    if (!markdown.trim()) return;
    onAdd({ kind: "markdown", markdown });
    setMarkdown("");
  }, [busy, disabled, kind, markdown, ref, onAdd]);

  const active = TABS.find((tab) => tab.kind === kind)!;

  return (
    <section
      className={cn(
        "rounded-xl border border-border bg-card/60 p-4",
        disabled && "pointer-events-none opacity-60",
      )}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        const file = event.dataTransfer.files[0];
        if (file) readFile(file);
      }}
    >
      {/* What the conversation already has */}
      {materials.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          <AnimatePresence initial={false}>
            {materials.map((material) => {
              const Icon = KIND_ICON[material.kind];
              return (
                <motion.span
                  key={material.id}
                  layout
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  transition={transition}
                  className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-background py-1 pl-2.5 pr-1.5 text-xs"
                  title={material.origin ?? material.label}
                >
                  <Icon className="size-3 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 truncate text-foreground">
                    {material.label}
                  </span>
                  {material.primary_doc_path && (
                    <span className="hidden shrink-0 text-muted-foreground sm:inline">
                      · {material.primary_doc_path}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => onRemove(material.id)}
                    className="shrink-0 rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                    aria-label={`Remover ${material.label}`}
                    title="Remover material"
                  >
                    <X className="size-3" />
                  </button>
                </motion.span>
              );
            })}
          </AnimatePresence>

          {!adding && (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
            >
              <Plus className="size-3" />
              adicionar material
            </button>
          )}
        </div>
      )}

      {adding && (
        <>
          <div className="mb-3 flex gap-1 rounded-lg bg-muted/40 p-1">
            {TABS.map((tab) => {
              const Icon = tab.icon;
              const selected = tab.kind === kind;
              return (
                <button
                  key={tab.kind}
                  type="button"
                  onClick={() => setKind(tab.kind)}
                  className={cn(
                    "relative flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
                    selected
                      ? "text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {selected && (
                    <motion.span
                      layoutId="material-tab"
                      className="absolute inset-0 rounded-md bg-background shadow-sm"
                      transition={transition}
                    />
                  )}
                  <Icon className="relative size-3.5" />
                  <span className="relative">{tab.label}</span>
                </button>
              );
            })}
          </div>

          <div className="mb-3 flex items-start justify-between gap-2">
            <p className="text-xs text-muted-foreground">{active.hint}</p>
            {materials.length > 0 && (
              <button
                type="button"
                onClick={() => setAdding(false)}
                className="shrink-0 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                fechar
              </button>
            )}
          </div>

          {kind === "repo" && (
            <div className="space-y-2">
              <div className="flex gap-1 text-xs">
                <button
                  type="button"
                  onClick={() => setRepoMode("url")}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-md border px-2 py-1 transition-colors",
                    repoMode === "url"
                      ? "border-primary text-foreground"
                      : "border-border text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Link2 className="size-3" />
                  GitHub
                </button>
                <button
                  type="button"
                  onClick={() => setRepoMode("browse")}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-md border px-2 py-1 transition-colors",
                    repoMode === "browse"
                      ? "border-primary text-foreground"
                      : "border-border text-muted-foreground hover:text-foreground",
                  )}
                >
                  <FolderSearch className="size-3" />
                  Navegar na máquina
                </button>
              </div>

              {repoMode === "url" ? (
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={ref}
                    onChange={(event) => setRef(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") submit();
                    }}
                    placeholder="github.com/owner/repo"
                    className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:border-primary"
                  />
                  <Button onClick={submit} disabled={busy || !ref.trim()}>
                    {busy ? <Loader className="size-4 animate-spin" /> : "Adicionar"}
                  </Button>
                </div>
              ) : (
                <DirectoryBrowser
                  busy={busy}
                  onPick={(path) => onAdd({ kind: "repo", ref: path })}
                />
              )}
            </div>
          )}

          {kind === "markdown" && (
            <div className="space-y-2">
              <textarea
                value={markdown}
                onChange={(event) => setMarkdown(event.target.value)}
                rows={5}
                placeholder="Cole o markdown aqui — ou arraste um arquivo .md para esta área."
                className={cn(
                  "w-full resize-y rounded-md border bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:border-primary",
                  dragging ? "border-primary" : "border-border",
                )}
              />
              <div className="flex gap-2">
                <Button onClick={submit} disabled={busy || !markdown.trim()}>
                  {busy ? <Loader className="size-4 animate-spin" /> : "Adicionar documento"}
                </Button>
                <Button variant="outline" onClick={() => fileRef.current?.click()}>
                  <Upload className="mr-1.5 size-4" />
                  Escolher arquivo
                </Button>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".md,.markdown,.txt"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) readFile(file);
                    event.target.value = "";
                  }}
                />
              </div>
            </div>
          )}

          {kind === "machine" && (
            <Button onClick={submit} disabled={busy}>
              {busy ? (
                <Loader className="size-4 animate-spin" />
              ) : (
                "Adicionar a documentação da máquina"
              )}
            </Button>
          )}
        </>
      )}
    </section>
  );
}
