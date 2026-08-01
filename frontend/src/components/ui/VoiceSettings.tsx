"use client";

import { useEffect, useState } from "react";
import { AudioLines, ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";
import type { ConversationSettings } from "@/types";

export interface VoiceSettingsProps {
  settings: ConversationSettings | null;
  /** Voice is frozen once a session has spoken, so the picker locks while live. */
  live: boolean;
  onChangeVoice: (voice: string) => void;
  onChangeSpeed: (speed: number) => void;
}

/** The two OpenAI recommends; the rest are the older set, kept as options. */
const RECOMMENDED = new Set(["marin", "cedar"]);

const DESCRIPTIONS: Record<string, string> = {
  marin: "clara e calorosa",
  cedar: "grave e calma",
  alloy: "neutra",
  ash: "seca e direta",
  ballad: "suave",
  coral: "animada",
  echo: "firme",
  sage: "pausada",
  shimmer: "leve",
  verse: "expressiva",
};

export function VoiceSettings({
  settings,
  live,
  onChangeVoice,
  onChangeSpeed,
}: VoiceSettingsProps) {
  const [open, setOpen] = useState(false);
  const [speed, setSpeed] = useState(settings?.speed ?? 1);

  // The slider is local while dragging; the server hears the final value.
  useEffect(() => {
    if (settings) setSpeed(settings.speed);
  }, [settings]);

  if (!settings) return null;

  return (
    <div className="border-t border-border px-3 py-2">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <AudioLines className="size-3.5" />
        <span className="font-medium">Voz</span>
        <span className="ml-auto tabular-nums">
          {settings.voice} · {speed.toFixed(2)}×
        </span>
        <ChevronDown
          className={cn("size-3.5 transition-transform", open && "rotate-180")}
        />
      </button>

      {open && (
        <div className="space-y-3 px-1 pb-1 pt-2">
          <label className="block space-y-1">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Voz {live && "— trave: encerre a conversa para trocar"}
            </span>
            <select
              value={settings.voice}
              disabled={live}
              onChange={(event) => onChangeVoice(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none focus:border-primary disabled:opacity-50"
            >
              {settings.voices.map((voice) => (
                <option key={voice} value={voice}>
                  {voice}
                  {DESCRIPTIONS[voice] ? ` — ${DESCRIPTIONS[voice]}` : ""}
                  {RECOMMENDED.has(voice) ? " ★" : ""}
                </option>
              ))}
            </select>
          </label>

          <label className="block space-y-1">
            <span className="flex items-center justify-between text-[10px] uppercase tracking-wider text-muted-foreground">
              <span>Velocidade</span>
              <span className="tabular-nums">{speed.toFixed(2)}×</span>
            </span>
            <input
              type="range"
              min={0.5}
              max={1.5}
              step={0.05}
              value={speed}
              onChange={(event) => setSpeed(Number(event.target.value))}
              onPointerUp={() => onChangeSpeed(speed)}
              onKeyUp={() => onChangeSpeed(speed)}
              className="w-full accent-primary"
            />
          </label>
        </div>
      )}
    </div>
  );
}
