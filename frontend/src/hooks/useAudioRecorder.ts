import { useState, useRef, useCallback, useEffect } from "react";

export interface AudioRecorderState {
  isRecording: boolean;
  audioBlob: Blob | null;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<Blob>;
  error: string | null;
}

export function useAudioRecorder(): AudioRecorderState {
  const [isRecording, setIsRecording] = useState(false);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [error, setError] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const resolveRef = useRef<((blob: Blob) => void) | null>(null);
  const rejectRef = useRef<((err: Error) => void) | null>(null);

  const cleanupStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanupStream();
    };
  }, [cleanupStream]);

  const startRecording = useCallback(async () => {
    setError(null);
    setAudioBlob(null);
    chunksRef.current = [];

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      streamRef.current = stream;

      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";

      const recorder = new MediaRecorder(stream, { mimeType });
      recorderRef.current = recorder;

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data && event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onerror = () => {
        setError("Erro ao gravar áudio.");
        setIsRecording(false);
        cleanupStream();
        if (rejectRef.current) {
          rejectRef.current(new Error("MediaRecorder error"));
          rejectRef.current = null;
        }
      };

      recorder.start();
      setIsRecording(true);
    } catch (err: unknown) {
      const domErr = err as DOMException;
      if (
        domErr.name === "NotAllowedError" ||
        domErr.name === "PermissionDeniedError"
      ) {
        setError(
          "Permissão para microfone negada. Libere o acesso no navegador.",
        );
      } else if (
        domErr.name === "NotFoundError" ||
        domErr.name === "DevicesNotFoundError"
      ) {
        setError("Nenhum microfone encontrado.");
      } else {
        setError(domErr.message || "Erro ao iniciar gravação.");
      }
      setIsRecording(false);
    }
  }, [cleanupStream]);

  const stopRecording = useCallback(async (): Promise<Blob> => {
    return new Promise<Blob>((resolve, reject) => {
      if (!recorderRef.current || recorderRef.current.state === "inactive") {
        cleanupStream();
        setIsRecording(false);
        reject(new Error("Nenhuma gravação ativa."));
        return;
      }

      resolveRef.current = resolve;
      rejectRef.current = reject;

      recorderRef.current.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        setAudioBlob(blob);
        setIsRecording(false);
        cleanupStream();

        if (resolveRef.current) {
          resolveRef.current(blob);
          resolveRef.current = null;
        }
      };

      recorderRef.current.stop();
    });
  }, [cleanupStream]);

  return { isRecording, audioBlob, startRecording, stopRecording, error };
}
