import { useState, useEffect, useCallback } from "react";
import * as api from "@/lib/api";
import type { Attachment } from "@/types";

export interface FileAttachmentState {
  files: Attachment[];
  uploadFiles: (fileList: FileList | File[]) => Promise<void>;
  removeFile: (attachmentId: string) => Promise<void>;
  isLoading: boolean;
  error: string | null;
  clearError: () => void;
}

export function useFileAttachment(
  convId: string | null,
): FileAttachmentState {
  const [files, setFiles] = useState<Attachment[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clearError = useCallback(() => setError(null), []);

  // Load files when convId changes
  useEffect(() => {
    setError(null);

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
          setError("Não foi possível carregar os arquivos anexados.");
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [convId]);

  const uploadFiles = useCallback(
    async (fileList: FileList | File[]) => {
      if (!convId) return;

      setIsLoading(true);
      setError(null);
      try {
        await api.uploadFiles(convId, Array.from(fileList));

        // Refresh the full list to stay in sync with the server.
        setFiles(await api.listFiles(convId));
      } catch (err) {
        // A silent failure here looked exactly like a successful upload of
        // zero files; say so instead.
        setError(
          err instanceof Error && err.message
            ? `Erro ao enviar arquivos: ${err.message}`
            : "Erro ao enviar arquivos.",
        );
      } finally {
        setIsLoading(false);
      }
    },
    [convId],
  );

  const removeFile = useCallback(async (_attachmentId: string) => {
    // No DELETE endpoint exists yet — surface that in the UI rather than
    // logging to a console nobody is watching.
    setError("Remoção de arquivos ainda não disponível.");
  }, []);

  return { files, uploadFiles, removeFile, isLoading, error, clearError };
}
