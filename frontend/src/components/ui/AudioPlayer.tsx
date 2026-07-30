"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { Play, Pause } from "lucide-react";
import { ProgressBar } from "@/components/motion-ui/progress-bar";
import { useMotionUITransition } from "@/components/motion-ui/ui-theme";

export interface AudioPlayerProps {
  audioUrl: string;
  autoPlay?: boolean;
}

function formatTime(seconds: number): string {
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

  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const startTimeRef = useRef<number>(0);
  const offsetRef = useRef<number>(0);
  const animFrameRef = useRef<number>(0);
  const bufferRef = useRef<AudioBuffer | null>(null);
  const attemptedAutoPlayRef = useRef(false);

  const stopSource = useCallback(() => {
    if (sourceRef.current) {
      try {
        sourceRef.current.stop();
      } catch {
        // already stopped
      }
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }
  }, []);

  const updateTime = useCallback(() => {
    if (!audioContextRef.current || !startTimeRef.current) return;
    const elapsed =
      audioContextRef.current.currentTime - startTimeRef.current +
      offsetRef.current;
    setCurrentTime(elapsed);
    if (elapsed >= duration) {
      setPlaying(false);
      setCurrentTime(0);
      offsetRef.current = 0;
      stopSource();
      return;
    }
    animFrameRef.current = requestAnimationFrame(updateTime);
  }, [duration, stopSource]);

  const playAudio = useCallback(
    (startOffset = 0) => {
      const ctx = audioContextRef.current;
      const buffer = bufferRef.current;
      if (!ctx || !buffer) return;

      stopSource();

      if (ctx.state === "suspended") {
        ctx.resume();
      }

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);

      source.onended = () => {
        setPlaying(false);
        setCurrentTime(0);
        offsetRef.current = 0;
      };

      source.start(0, startOffset);
      sourceRef.current = source;
      startTimeRef.current = ctx.currentTime;
      offsetRef.current = startOffset;
      setPlaying(true);

      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = requestAnimationFrame(updateTime);
    },
    [stopSource, updateTime]
  );

  const pauseAudio = useCallback(() => {
    if (!audioContextRef.current) return;
    const elapsed =
      audioContextRef.current.currentTime -
      startTimeRef.current +
      offsetRef.current;
    offsetRef.current = elapsed;
    stopSource();
    cancelAnimationFrame(animFrameRef.current);
    setPlaying(false);
  }, [stopSource]);

  // Load audio
  useEffect(() => {
    let cancelled = false;
    const loadAudio = async () => {
      setLoading(true);
      setError(null);
      try {
        const ctx = new AudioContext();
        audioContextRef.current = ctx;

        const response = await fetch(audioUrl);
        if (!response.ok) throw new Error("Failed to fetch audio");
        const arrayBuffer = await response.arrayBuffer();
        const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

        if (cancelled) return;
        bufferRef.current = audioBuffer;
        setDuration(audioBuffer.duration);
        setLoading(false);

        if (autoPlay && !attemptedAutoPlayRef.current) {
          attemptedAutoPlayRef.current = true;
          playAudio(0);
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Failed to load audio"
          );
          setLoading(false);
        }
      }
    };

    loadAudio();

    return () => {
      cancelled = true;
      stopSource();
      cancelAnimationFrame(animFrameRef.current);
      if (audioContextRef.current) {
        audioContextRef.current.close();
        audioContextRef.current = null;
      }
    };
  }, [audioUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleToggle = () => {
    if (playing) {
      pauseAudio();
    } else {
      playAudio(offsetRef.current);
    }
  };

  const progress = duration > 0 ? currentTime / duration : 0;

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
          <span>{formatTime(duration)}</span>
        </div>
      </div>
    </div>
  );
}
