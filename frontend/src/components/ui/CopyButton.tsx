"use client";

import { useState, useCallback, useRef } from "react";
import { Check, Copy } from "lucide-react";

import { Button } from "@/components/ui/button";

interface CopyButtonProps {
  text: string;
}

/**
 * Icon button that copies text to the clipboard.
 *
 * Swaps the copy icon for a checkmark for 2 seconds after a successful copy so
 * the user gets a brief visual confirmation.
 */
export function CopyButton({ text }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCopy = useCallback(() => {
    // Clear any previous timeout so rapid clicks don't reset the checkmark
    // before the full 2 s have elapsed.
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }

    const onSuccess = () => {
      setCopied(true);
      timeoutRef.current = setTimeout(() => {
        setCopied(false);
        timeoutRef.current = null;
      }, 2000);
    };

    try {
      if (navigator.clipboard) {
        navigator.clipboard.writeText(text).then(onSuccess).catch(() => {
          // Permission denied or clipboard unavailable — silently ignore.
        });
      } else {
        // Fallback for environments without the Clipboard API (e.g. HTTP
        // non-localhost where navigator.clipboard is undefined).
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
        onSuccess();
      }
    } catch {
      // Clipboard write failed — silently ignore.
    }
  }, [text]);

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={handleCopy}
      aria-label={copied ? "Copiado!" : "Copiar"}
    >
      {copied ? (
        <Check className="size-3.5 text-emerald-500" />
      ) : (
        <Copy className="size-3.5" />
      )}
    </Button>
  );
}
