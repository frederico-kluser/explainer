"use client";

import {
  Compass,
  FileText,
  Lightbulb,
  MessagesSquare,
  Presentation,
  Sparkles,
  type LucideIcon,
} from "lucide-react";

/**
 * The icons a mode may name.
 *
 * An allowlist rather than a dynamic lookup: the server sends a string, and
 * pulling a component out of the icon package by that string would let whatever
 * is on the wire decide what gets rendered. A name that is not here falls back,
 * so a new mode that picks an unlisted icon looks plain instead of crashing.
 */
export const MODE_ICONS: Record<string, LucideIcon> = {
  MessagesSquare,
  Presentation,
  FileText,
  Lightbulb,
  Compass,
  Sparkles,
};

/** Resolves a mode's icon name against the allowlist, plain when unknown. */
export function resolveModeIcon(name: string | undefined): LucideIcon {
  if (!name) return Sparkles;
  return MODE_ICONS[name] ?? Sparkles;
}
