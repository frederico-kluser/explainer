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
  /**
   * Which tab the form opens on. Optional; leaving it out keeps the default.
   *
   * The first-contact overlay asks the same question in bigger words — "Este
   * computador", "Um repositório", "Um documento" — and until now its answer
   * died with it, because the tab lived in a `useState` nobody outside could
   * reach. Whoever asked already gets to say what was answered.
   */
  initialKind?: SourceKind;
  onAdd: (spec: SourceSpec) => void;
  onRemove: (materialId: string) => void;
}

/** The tab a picker opens on when the caller does not say. */
export const DEFAULT_MATERIAL_KIND: SourceKind = "repo";

/** Resolves `initialKind` against the default. Exported for the suite. */
export function initialPickerKind(initialKind?: SourceKind): SourceKind {
  return initialKind ?? DEFAULT_MATERIAL_KIND;
}

/**
 * The boxes a finger has to hit, held as data so the suite can measure them.
 *
 * No jsdom here, so nothing rendered can be measured; the class list it is
 * built from can. The unprefixed half of each string is the phone — floor 44px,
 * the size of a fingertip — and the `md:` half is the desktop this picker
 * already had. The two text fields carry `text-base md:text-sm` for a second
 * reason: under 16px, iOS Safari zooms the page in when the field takes focus,
 * and it never zooms back out.
 */
export const PICKER_TARGETS = {
  /** Repositório / Markdown / Meu computador. */
  tab: "relative flex min-h-11 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-1.5 text-xs font-medium transition-colors md:min-h-0 md:px-2 md:py-1.5",
  /** GitHub / Navegar na máquina. */
  repoMode:
    "inline-flex min-h-11 items-center gap-1 rounded-md border px-3 text-xs transition-colors md:min-h-0 md:px-2 md:py-1",
  /** The X on a material chip: destructive, and the smallest thing here. */
  chipRemove:
    "inline-flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive md:size-auto md:p-0.5",
  /** "adicionar material". */
  addMaterial:
    "inline-flex min-h-11 items-center gap-1 rounded-full border border-dashed border-border px-3 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-foreground md:min-h-0 md:px-2.5 md:py-1",
  /** "fechar". The negative margin keeps the hint beside it where it was. */
  close:
    "-mr-2 inline-flex min-h-11 shrink-0 items-center px-2 text-xs text-muted-foreground transition-colors hover:text-foreground md:m-0 md:min-h-0 md:p-0",
  /** Every `Button` in here: the shared one ships 32px. */
  submit: "h-11 md:h-8",
  /** github.com/owner/repo. */
  repoInput:
    "min-h-11 min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-base outline-none placeholder:text-muted-foreground focus:border-primary md:min-h-0 md:text-sm",
  /** The pasted document. */
  markdownInput:
    "w-full resize-y rounded-md border bg-background px-3 py-2 text-base outline-none placeholder:text-muted-foreground focus:border-primary md:text-sm",
} as const;

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

/**
 * The kinds that have a tab, in the order they are offered.
 *
 * Exported because `initialKind` is now a promise to the caller: whatever the
 * overlay upstream can choose, this strip has to be able to show.
 */
export const MATERIAL_TAB_KINDS: readonly SourceKind[] = TABS.map((tab) => tab.kind);

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
  initialKind,
  onAdd,
  onRemove,
}: MaterialPickerProps) {
  const [adding, setAdding] = useState(materials.length === 0);
  const [kind, setKind] = useState<SourceKind>(() => initialPickerKind(initialKind));
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

  // Watched rather than read once at mount. The picker is already mounted
  // behind the first-contact overlay, so a value read at mount is always the
  // default and the card the user tapped up there would be asked for again
  // down here. Later taps on the tabs still win: the effect only fires when
  // the caller changes its mind.
  useEffect(() => {
    if (initialKind) setKind(initialKind);
  }, [initialKind]);

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
        <div className="mb-3 flex flex-wrap gap-2 md:gap-1.5">
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
                  // The chip is as tall as the X inside it, and the X is a
                  // fingertip: removing the material a call is about is not a
                  // thing to hit by accident on the way to the tab strip.
                  className="inline-flex min-h-11 max-w-full items-center gap-1.5 rounded-full border border-border bg-background py-1 pl-3 pr-0 text-xs md:min-h-0 md:pl-2.5 md:pr-1.5"
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
                    className={PICKER_TARGETS.chipRemove}
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
              className={PICKER_TARGETS.addMaterial}
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
                    PICKER_TARGETS.tab,
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
                  {/* `truncate` on the label needs `min-w-0` on the tab, which
                      makes everything in it shrinkable — including the icon,
                      which would otherwise be squeezed to a sliver at 360px. */}
                  <Icon className="relative size-3.5 shrink-0" />
                  <span className="relative truncate">{tab.label}</span>
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
                className={PICKER_TARGETS.close}
              >
                fechar
              </button>
            )}
          </div>

          {kind === "repo" && (
            <div className="space-y-2">
              <div className="flex gap-2 text-xs md:gap-1">
                <button
                  type="button"
                  onClick={() => setRepoMode("url")}
                  className={cn(
                    PICKER_TARGETS.repoMode,
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
                    PICKER_TARGETS.repoMode,
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
                    className={PICKER_TARGETS.repoInput}
                  />
                  <Button
                    className={PICKER_TARGETS.submit}
                    onClick={submit}
                    disabled={busy || !ref.trim()}
                  >
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
                  PICKER_TARGETS.markdownInput,
                  dragging ? "border-primary" : "border-border",
                )}
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  className={PICKER_TARGETS.submit}
                  onClick={submit}
                  disabled={busy || !markdown.trim()}
                >
                  {busy ? <Loader className="size-4 animate-spin" /> : "Adicionar documento"}
                </Button>
                <Button
                  className={PICKER_TARGETS.submit}
                  variant="outline"
                  onClick={() => fileRef.current?.click()}
                >
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
            <Button className={PICKER_TARGETS.submit} onClick={submit} disabled={busy}>
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
