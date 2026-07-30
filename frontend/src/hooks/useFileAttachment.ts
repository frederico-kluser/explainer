import { useState, useEffect, useCallback } from "react";
import * as api from "@/lib/api";
import type { Attachment } from "@/types";

export interface FileAttachmentState {
  files: Attachment[];
  uploadFiles: (fileList: FileList | File[]) => Promise<void>;
  removeFile: (attachmentId: string) => Promise<void>;
  isLoading: boolean;
}

export function useFileAttachment(
  convId: string | null,
): FileAttachmentState {
  const [files, setFiles] = useState<Attachment[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  // Load files when convId changes
  useEffect(() => {
    if (!convId) {
      setFiles([]);
      return;
    }

    let cancelled = false;

    async function load() {
      setIsLoading(true);
      try {
        const result = await api.listFiles(convId!);
        if (!cancelled) {
          setFiles(result);
        }
      } catch {
        if (!cancelled) {
          setFiles([]);
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [convId]);

  const uploadFiles = useCallback(
    async (fileList: FileList | File[]) => {
      if (!convId) return;

      setIsLoading(true);
      try {
        const filesArr = Array.from(fileList);
        const uploaded = await api.uploadFiles(convId, filesArr);

        // Refresh full list to stay in sync with server
        const refreshed = await api.listFiles(convId);
        setFiles(refreshed);

        // If the API returned the uploaded files, we could also merge
        // but fetching the full list is safer for consistency.
        void uploaded;
      } catch {
        // Error silently handled; list remains as-is
      } finally {
        setIsLoading(false);
      }
    },
    [convId],
  );

  const removeFile = useCallback(async (_attachmentId: string) => {
    // File removal not yet implemented in the API
    // eslint-disable-next-line no-console
    console.warn("Em breve: remoção de arquivos ainda não disponível.");
  }, []);

  return { files, uploadFiles, removeFile, isLoading };
}
