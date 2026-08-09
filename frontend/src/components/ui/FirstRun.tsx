"use client";

import { useCallback, useId, useRef, useState } from "react";
import { motion } from "motion/react";
import { FileText, FolderGit2, Laptop, Loader, Upload } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  Backdrop,
  useFocusTrap,
  useScrollLock,
} from "@/components/motion-ui/overlay";
import { useMotionUITransition } from "@/components/motion-ui/ui-theme";
import { Button } from "@/components/ui/button";
import {
  FIRST_RUN_ORDER,
  firstRunSpec,
  type FirstRunChoice,
  type FirstRunDocument,
} from "@/components/ui/mobile-shell";
import type { SourceSpec } from "@/types";

export interface FirstRunProps {
  /** Whether a material is being resolved right now. */
  busy: boolean;
  /** Adds the chosen material and opens the call, in that order. */
  onStart: (spec: SourceSpec) => void;
  /** Steps aside and leaves the ordinary picker on screen. */
  onDismiss: () => void;
}

const CARDS: Record<
  FirstRunChoice,
  { label: string; hint: string; icon: typeof Laptop }
> = {
  machine: {
    label: "Este computador",
    hint: "A documentação desta máquina. Um toque, sem digitar nada.",
    icon: Laptop,
  },
  repo: {
    label: "Um repositório",
    hint: "Do GitHub, como github.com/dono/projeto.",
    icon: FolderGit2,
  },
  markdown: {
    label: "Um documento",
    hint: "Um arquivo .md deste aparelho.",
    icon: FileText,
  },
};

/**
 * What the app is, on the screen of somebody who has never seen it.
 *
 * Until now a phone opened on a 288px rail, the words "Adicione um material"
 * and a file browser listing the folders of a computer that is not theirs.
 * Nothing on that screen says the app is a voice call about a document.
 *
 * The three cards are the picker's three tabs, promoted and reordered.
 * "Este computador" leads because it is the only one that needs no typing and
 * no file: on a phone keyboard, the distance between the two is most of the
 * people who never make a first call.
 */
export function FirstRun({ busy, onStart, onDismiss }: FirstRunProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const transition = useMotionUITransition("gentle");

  const [choice, setChoice] = useState<FirstRunChoice>("machine");
  const [repoRef, setRepoRef] = useState("");
  const [picked, setPicked] = useState<FirstRunDocument | null>(null);

  useScrollLock(true);
  useFocusTrap({ active: true, container: panelRef, onEscape: onDismiss });

  const readFile = useCallback((file: File) => {
    void file.text().then((markdown) => setPicked({ label: file.name, markdown }));
  }, []);

  const spec = firstRunSpec(choice, repoRef, picked);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-3">
      <Backdrop
        className="bg-background/95"
        label="Fechar"
        onClick={onDismiss}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={transition}
      />

      <motion.div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative z-10 w-full max-w-md rounded-2xl border border-border bg-card p-4 shadow-2xl"
        style={{ marginBottom: "env(safe-area-inset-bottom)" }}
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={transition}
      >
        <h2
          id={titleId}
          className="mb-4 text-base font-medium leading-snug text-foreground"
        >
          Converse por voz com um material — um repositório, um documento, ou
          este computador.
        </h2>

        <div className="space-y-2">
          {FIRST_RUN_ORDER.map((kind) => {
            const card = CARDS[kind];
            const Icon = card.icon;
            const selected = choice === kind;

            return (
              <button
                key={kind}
                type="button"
                onClick={() => setChoice(kind)}
                aria-pressed={selected}
                className={cn(
                  "flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors",
                  selected
                    ? "border-primary bg-primary/5"
                    : "border-border hover:bg-accent/40",
                )}
              >
                <Icon
                  className={cn(
                    "mt-0.5 size-5 shrink-0",
                    selected ? "text-primary" : "text-muted-foreground",
                  )}
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-foreground">
                    {card.label}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {card.hint}
                  </span>
                </span>
              </button>
            );
          })}
        </div>

        {choice === "repo" && (
          // `text-base` is 16px, and anything under 16px makes iOS Safari zoom
          // in when the field takes focus — and never zoom back out.
          <input
            type="text"
            value={repoRef}
            onChange={(event) => setRepoRef(event.target.value)}
            placeholder="github.com/dono/projeto"
            className="mt-3 h-11 w-full rounded-lg border border-border bg-background px-3 text-base text-foreground outline-none placeholder:text-muted-foreground focus:border-primary"
          />
        )}

        {choice === "markdown" && (
          <div className="mt-3 flex items-center gap-2">
            <Button
              variant="outline"
              className="h-11 px-3 text-sm"
              onClick={() => fileRef.current?.click()}
            >
              <Upload className="mr-1.5 size-4" />
              Escolher arquivo
            </Button>
            {picked && (
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {picked.label}
              </span>
            )}
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
        )}

        <Button
          className="mt-4 h-12 w-full text-base"
          disabled={!spec || busy}
          onClick={() => spec && onStart(spec)}
        >
          {busy ? <Loader className="size-5 animate-spin" /> : "Falar"}
        </Button>

        <button
          type="button"
          onClick={onDismiss}
          className="mt-2 h-9 w-full text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          Prefiro escolher sozinho
        </button>
      </motion.div>
    </div>
  );
}
