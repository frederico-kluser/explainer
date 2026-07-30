import { useState, useEffect, useCallback, useRef } from "react";

export interface AutoPlayState {
  isPlaying: boolean;
  play: () => Promise<void>;
  pause: () => void;
}

export function useAutoPlay(audioUrl: string | null): AutoPlayState {
  const [isPlaying, setIsPlaying] = useState(false);
  const ctxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);

  // Cleanup AudioContext on unmount
  useEffect(() => {
    return () => {
      if (sourceRef.current) {
        try {
          sourceRef.current.stop();
        } catch {
          // Already stopped
        }
      }
      if (ctxRef.current) {
        ctxRef.current.close().catch(() => {});
        ctxRef.current = null;
      }
    };
  }, []);

  const stopSource = useCallback(() => {
    if (sourceRef.current) {
      try {
        sourceRef.current.stop();
      } catch {
        // Already stopped
      }
      sourceRef.current = null;
    }
  }, []);

  const getContext = useCallback((): AudioContext => {
    if (!ctxRef.current) {
      ctxRef.current = new AudioContext();
    }
    return ctxRef.current;
  }, []);

  const playUrl = useCallback(
    async (url: string) => {
      stopSource();

      const ctx = getContext();

      // Resume AudioContext (handles browser autoplay policy)
      if (ctx.state === "suspended") {
        await ctx.resume();
      }

      try {
        const response = await fetch(url);
        const arrayBuffer = await response.arrayBuffer();
        const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(ctx.destination);
        sourceRef.current = source;

        source.onended = () => {
          sourceRef.current = null;
          setIsPlaying(false);
        };

        source.start();
        setIsPlaying(true);
      } catch (err) {
        console.error("useAutoPlay: failed to play audio", err);
        setIsPlaying(false);
      }
    },
    [getContext, stopSource],
  );

  // Auto-play when audioUrl changes to non-null
  useEffect(() => {
    if (audioUrl) {
      playUrl(audioUrl);
    }
  }, [audioUrl, playUrl]);

  const play = useCallback(async () => {
    if (audioUrl) {
      await playUrl(audioUrl);
    }
  }, [audioUrl, playUrl]);

  const pause = useCallback(() => {
    stopSource();
    setIsPlaying(false);
  }, [stopSource]);

  return { isPlaying, play, pause };
}
