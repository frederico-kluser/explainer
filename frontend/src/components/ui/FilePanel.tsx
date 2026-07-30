"use client";

import { useRef, useId } from "react";
import { motion } from "motion/react";
import { Paperclip, Trash2 } from "lucide-react";
import {
  Sheet,
  SheetTrigger,
  SheetBackdrop,
  SheetPanel,
  SheetHandle,
  SheetClose,
} from "@/components/motion-ui/sheet";
import { useMotionUITransition } from "@/components/motion-ui/ui-theme";
import type { Attachment } from "@/types";

export interface FilePanelProps {
  files: Attachment[];
  onUpload: (files: FileList) => void;
  onRemove: (id: string) => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FilePanel({ files, onUpload, onRemove }: FilePanelProps) {
  const snap = useMotionUITransition("snap");
  const inputId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onUpload(e.target.files);
      // Reset so the same file can be selected again
      e.target.value = "";
    }
  };

  return (
    <Sheet>
      <SheetTrigger className="gap-2">
        <Paperclip className="size-4" />
        <span>Arquivos</span>
        {files.length > 0 && (
          <span className="ml-1 inline-flex size-5 items-center justify-center rounded-full bg-primary-foreground/20 text-xs font-medium">
            {files.length}
          </span>
        )}
      </SheetTrigger>

      <SheetBackdrop label="Fechar painel de arquivos" />

      <SheetPanel className="flex max-h-[70vh] flex-col">
        <SheetHandle />

        <div className="flex items-center justify-between">
          <h2
            id="file-panel-title"
            className="text-lg font-semibold text-foreground"
          >
            Arquivos anexados
          </h2>
          <SheetClose />
        </div>

        <div className="mt-4 flex-1 overflow-y-auto">
          {files.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Nenhum arquivo anexado
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {files.map((file) => (
                <motion.li
                  key={file.id}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={snap}
                  className="flex items-center gap-3 py-3"
                >
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium text-foreground">
                      {file.original_name}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {formatSize(file.size_bytes)}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => onRemove(file.id)}
                    className="inline-flex size-7 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                    title="Remover arquivo"
                    aria-label={`Remover ${file.original_name}`}
                  >
                    <Trash2 className="size-4" />
                  </button>
                </motion.li>
              ))}
            </ul>
          )}
        </div>

        <div className="mt-4 border-t border-border pt-4">
          <input
            ref={fileInputRef}
            id={inputId}
            type="file"
            multiple
            onChange={handleFileChange}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex w-full items-center justify-center gap-2 rounded-md border border-border bg-background px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            <Paperclip className="size-4" />
            Anexar arquivos
          </button>
        </div>
      </SheetPanel>
    </Sheet>
  );
}
