import { useEffect, useRef } from "react";

/**
 * Returns true when the event originated inside an editable element. Without
 * this guard, a global "g t to go to /tasks" shortcut would also fire while
 * the user is typing the letter "g" in a chat box, which would be infuriating.
 */
function inEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const t = target.tagName;
  if (t === "INPUT" || t === "TEXTAREA" || t === "SELECT") return true;
  return false;
}

export type ShortcutHandler = (e: KeyboardEvent) => void;

export interface ShortcutSpec {
  /** Single-key shortcut, e.g. "?" or "/". Use "ctrl+k" for combos. */
  key: string;
  handler: ShortcutHandler;
  /** Allow the shortcut to fire even while typing in an input. */
  allowInEditable?: boolean;
  /** Description shown in the help overlay. */
  describe?: string;
}

function matches(key: string, e: KeyboardEvent): boolean {
  const parts = key.toLowerCase().split("+");
  const main = parts[parts.length - 1];
  const wantMod = parts.includes("ctrl") || parts.includes("cmd") || parts.includes("meta");
  const wantShift = parts.includes("shift");
  const wantAlt = parts.includes("alt");
  const isMod = e.metaKey || e.ctrlKey;
  if (wantMod !== isMod) return false;
  if (wantShift !== e.shiftKey) return false;
  if (wantAlt !== e.altKey) return false;
  return e.key.toLowerCase() === main;
}

/**
 * Registers a list of single-key + chord shortcuts on document. Plus a tiny
 * sequence engine for vim-style chords like `g t` (go to tasks): the first
 * key arms the buffer, the second key (within 800ms) fires the matching
 * handler.
 */
export function useShortcuts(specs: ShortcutSpec[], sequences: Record<string, ShortcutHandler> = {}): void {
  const specsRef = useRef(specs);
  const seqRef = useRef(sequences);
  specsRef.current = specs;
  seqRef.current = sequences;

  useEffect(() => {
    let buffer = "";
    let bufferTimer: ReturnType<typeof setTimeout> | null = null;
    const clearBuffer = () => {
      buffer = "";
      if (bufferTimer) clearTimeout(bufferTimer);
      bufferTimer = null;
    };

    const onKey = (e: KeyboardEvent) => {
      const editable = inEditable(e.target);

      // Chord shortcuts (sequences) never fire inside editable elements.
      // Allow a-z to start a sequence; once buffer is primed, also allow
      // punctuation (",", ".", etc.) as follow keys so shortcuts like `g,` work.
      const isSeqKey =
        /^[a-z]$/i.test(e.key) ||
        (buffer.length > 0 && e.key.length === 1 && !/^[A-Z]$/.test(e.key));
      if (!editable && isSeqKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        buffer += e.key.toLowerCase();
        if (bufferTimer) clearTimeout(bufferTimer);
        bufferTimer = setTimeout(clearBuffer, 800);
        // Try sequences first (longest-prefix match)
        for (const [seq, h] of Object.entries(seqRef.current)) {
          if (buffer.endsWith(seq)) {
            e.preventDefault();
            clearBuffer();
            h(e);
            return;
          }
        }
        // Don't return here — single-letter shortcuts (e.g. "?") still need a chance below.
      }

      for (const spec of specsRef.current) {
        if (editable && !spec.allowInEditable) continue;
        if (matches(spec.key, e)) {
          e.preventDefault();
          spec.handler(e);
          clearBuffer();
          return;
        }
      }
    };

    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}

/** Mac-aware modifier label for use in tooltips and the help overlay. */
export const MOD = typeof navigator !== "undefined" && /Mac/.test(navigator.platform) ? "⌘" : "Ctrl";
