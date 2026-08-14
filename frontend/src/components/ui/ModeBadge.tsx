"use client";

import { cn } from "@/lib/utils";
import { resolveModeIcon } from "@/components/ui/mode-icons";

export interface ModeBadgeProps {
  /** A `lucide-react` icon name, resolved against the allowlist. */
  icon: string;
  label: string;
  /** xs for the mobile top bar, sm for the desktop header. */
  size?: "xs" | "sm";
  /** Optional native tooltip. */
  title?: string;
}

/**
 * The pill that says what kind of conversation this is.
 *
 * Static by design: the mode is chosen once and frozen for the life of the
 * conversation, so nothing here animates — motion would advertise a change
 * that can never happen.
 */
export function ModeBadge({ icon, label, size = "xs", title }: ModeBadgeProps) {
  const Icon = resolveModeIcon(icon);
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 rounded-full bg-primary/10 px-2 py-0.5 font-medium text-primary",
        size === "xs" ? "text-[10px]" : "text-xs",
      )}
      title={title}
    >
      <Icon className={size === "xs" ? "size-3" : "size-3.5"} />
      {/* The label truncates so the pill can shrink on a narrow bar. */}
      <span className="truncate">{label}</span>
    </span>
  );
}
