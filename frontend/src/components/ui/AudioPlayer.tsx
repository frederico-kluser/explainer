"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { Play, Pause } from "lucide-react";
import { ProgressBar } from "@/components/motion-ui/progress-bar";
import { useMotionUITransition } from "@/components/motion-ui/ui-theme";
import { getAudioContext, loadAudioBuffer, resumeAudioContext } from "@/lib/audio";

export interface AudioPlayerProps {
  audioUrl: string;
  autoPlay?: boolean;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

export function AudioPlayer({ audioUrl, autoPlay = false }: AudioPlayerProps) {
  const snap = useMotionUITransition("snap");
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const bufferRef = useRef<AudioBuffer | null>(null);
  const startedAtRef = useRef(0); // context clock when the source started
  const offsetRef = useRef(0); // where in the buffer that source began
  const animFrameRef = useRef(0);

  // Identity of the current audioUrl "run". App renders a single player whose
  // `audioUrl` prop changes as new replies arrive, so an async load started for
  // the previous URL can still be in flight. A plain mounted-flag cannot tell
  // those apart — it goes back to true on the next run and lets the stale
  // continuation install the wrong buffer. Comparing tokens can.
  const runRef = useRef<object>({});

  const stopSource = useCallback(() => {
    const source = sourceRef.current;
    if (!source) return;
    // Detach first: `stop()` also fires onended, which would otherwise be
    // indistinguishable from the track finishing on its own.
    source.onended = null;
    try {
      source.stop();
    } catch {
      // already stopped
    }
    source.disconnect();
    sourceRef.current = null;
  }, []);

  const tick = useCallback(() => {
    if (!sourceRef.current) return;
    const elapsed =
      offsetRef.current + (getAudioContext().currentTime - startedAtRef.current);
    setCurrentTime(elapsed);
    animFrameRef.current = requestAnimationFrame(tick);
  }, []);

  const ensureBuffer = useCallback(async (): Promise<AudioBuffer | null> => {
    if (bufferRef.current) return bufferRef.current;

    const run = runRef.current;
    setLoading(true);
    setError(null);
    try {
      const buffer = await loadAudioBuffer(audioUrl);
      if (runRef.current !== run) return null; // a newer URL took over
      bufferRef.current = buffer;
      setDuration(buffer.duration);
      return buffer;
    } catch (err) {
      if (runRef.current === run) {
        setError(err instanceof Error ? err.message : "Failed to load audio");
      }
      return null;
    } finally {
      if (runRef.current === run) setLoading(false);
    }
  }, [audioUrl]);

  const startPlayback = useCallback(
    async (startOffset: number) => {
      const run = runRef.current;

      const buffer = await ensureBuffer();
      if (!buffer || runRef.current !== run) return;

      const ctx = await resumeAudioContext();
      if (runRef.current !== run) return;

      stopSource();

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.onended = () => {
        sourceRef.current = null;
        cancelAnimationFrame(animFrameRef.current);
        if (runRef.current !== run) return;
        offsetRef.current = 0;
        setCurrentTime(0);
        setPlaying(false);
      };

      source.start(0, Math.min(startOffset, buffer.duration));
      sourceRef.current = source;
      startedAtRef.current = ctx.currentTime;
      offsetRef.current = startOffset;
      setPlaying(true);

      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = requestAnimationFrame(tick);
    },
    [ensureBuffer, stopSource, tick],
  );

  const pausePlayback = useCallback(() => {
    if (!sourceRef.current) return;
    offsetRef.current +=
      getAudioContext().currentTime - startedAtRef.current;
    stopSource();
    cancelAnimationFrame(animFrameRef.current);
    setPlaying(false);
  }, [stopSource]);

  // Reset for a new URL. Only auto-playing players fetch up front; the rest
  // load on first press, so a long thread doesn't download every reply at once.
  useEffect(() => {
    const run = {};
    runRef.current = run;

    bufferRef.current = null;
    offsetRef.current = 0;
    setCurrentTime(0);
    setDuration(0);
    setPlaying(false);
    setError(null);
    setLoading(false);

    if (autoPlay) {
      void startPlayback(0);
    }

    return () => {
      // A token nobody holds: everything still in flight for this URL bails out.
      runRef.current = {};
      stopSource();
      cancelAnimationFrame(animFrameRef.current);
      // The AudioContext is shared app-wide — never close it here.
    };
    // startPlayback/stopSource are stable for a given audioUrl.
  }, [audioUrl, autoPlay]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleToggle = () => {
    if (playing) {
      pausePlayback();
    } else {
      void startPlayback(offsetRef.current);
    }
  };

  const progress = duration > 0 ? Math.min(currentTime / duration, 1) : 0;

  if (error) {
    return (
      <div className="flex items-center gap-3 rounded-lg bg-muted px-4 py-3">
        <span className="text-sm text-destructive">
          Erro ao carregar áudio
        </span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 rounded-lg bg-muted px-4 py-3">
      <motion.button
        type="button"
        disabled={loading}
        onClick={handleToggle}
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:opacity-50"
        whileHover={{ scale: 1.1 }}
        whileTap={{ scale: 0.95 }}
        transition={snap}
        aria-label={playing ? "Pausar" : "Reproduzir"}
      >
        {loading ? (
          <span className="animate-spin text-xs">⏳</span>
        ) : playing ? (
          <Pause className="size-4" />
        ) : (
          <Play className="size-4" />
        )}
      </motion.button>

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <ProgressBar value={progress} size="sm" />
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>{formatTime(currentTime)}</span>
          <span>{duration > 0 ? formatTime(duration) : "--:--"}</span>
        </div>
      </div>
    </div>
  );
}
