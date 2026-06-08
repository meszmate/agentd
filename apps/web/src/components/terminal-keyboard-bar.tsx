import { useCallback, useEffect, useState } from "react";
import { Keyboard, X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Touch-friendly key dock for terminal surfaces. Exposes the keys a soft
 * keyboard either can't type at all (Esc / Shift-Tab / arrows / Ctrl combos)
 * or makes painful to chord (tmux prefix sequences). Buttons synthesize the
 * exact bytes a real keypress would, so the embedded shell / tmux sees them
 * indistinguishably from a hardware key.
 *
 * Horizontally scrollable so the dock works at any width without wrapping.
 * Groups are separated by a faint divider, not a hard wrap, so a user can
 * flick across the whole keyboard without losing position.
 */
interface Props {
  /** Send raw bytes into the pty's stdin (XTermPaneApi.send). */
  onSend: (data: string) => void;
  /** Optional close button — wired by the parent to flip the visibility pref. */
  onClose?: () => void;
}

const ESC = "\x1b";
const PREFIX = "\x02"; // C-b — tmux default prefix

interface KeyDef {
  label: string;
  data: string;
  title?: string;
  wide?: boolean;
}

const SPECIAL_KEYS: KeyDef[] = [
  { label: "Esc", data: ESC, title: "Escape" },
  { label: "Tab", data: "\t" },
  { label: "⇧Tab", data: `${ESC}[Z`, title: "Shift+Tab" },
  { label: "⌫", data: "\x7f", title: "Backspace" },
  { label: "↑", data: `${ESC}[A`, title: "Up" },
  { label: "↓", data: `${ESC}[B`, title: "Down" },
  { label: "←", data: `${ESC}[D`, title: "Left" },
  { label: "→", data: `${ESC}[C`, title: "Right" },
];

const CTRL_KEYS: KeyDef[] = [
  { label: "^C", data: "\x03", title: "Ctrl+C — interrupt" },
  { label: "^D", data: "\x04", title: "Ctrl+D — EOF / exit" },
  { label: "^L", data: "\x0c", title: "Ctrl+L — clear" },
  { label: "^R", data: "\x12", title: "Ctrl+R — history search" },
  { label: "^Z", data: "\x1a", title: "Ctrl+Z — suspend" },
  { label: "^A", data: "\x01", title: "Ctrl+A — line start" },
  { label: "^E", data: "\x05", title: "Ctrl+E — line end" },
  { label: "^U", data: "\x15", title: "Ctrl+U — clear line" },
  { label: "^W", data: "\x17", title: "Ctrl+W — delete word" },
];

const TMUX_KEYS: KeyDef[] = [
  { label: "prev", data: `${PREFIX}p`, title: "tmux: previous window" },
  { label: "next", data: `${PREFIX}n`, title: "tmux: next window" },
  { label: "new", data: `${PREFIX}c`, title: "tmux: new window" },
  { label: "copy", data: `${PREFIX}[`, title: "tmux: copy / scroll mode" },
  { label: "↕", data: `${PREFIX}"`, title: "tmux: split horizontal" },
  { label: "↔", data: `${PREFIX}%`, title: "tmux: split vertical" },
  { label: "o", data: `${PREFIX}o`, title: "tmux: next pane" },
  { label: "x", data: `${PREFIX}x`, title: "tmux: kill pane" },
  { label: "z", data: `${PREFIX}z`, title: "tmux: zoom pane" },
  { label: "d", data: `${PREFIX}d`, title: "tmux: detach" },
];

const TMUX_DIGITS: KeyDef[] = Array.from({ length: 10 }, (_, i) => ({
  label: String(i),
  data: `${PREFIX}${i}`,
  title: `tmux: window ${i}`,
}));

function KeyButton({
  k,
  onTap,
}: {
  k: KeyDef;
  onTap: (data: string) => void;
}) {
  return (
    <button
      type="button"
      title={k.title ?? k.label}
      onPointerDown={(e) => {
        // Fire on press for snappy feel; prevent the button from stealing
        // focus from the terminal (so the next physical keypress still
        // lands in the pty).
        e.preventDefault();
        onTap(k.data);
      }}
      // Mouse fallback — onPointerDown covers touch, but some browsers
      // also need this for keyboard activation accessibility.
      onClick={(e) => e.preventDefault()}
      className={cn(
        "shrink-0 select-none rounded border border-ink-900/15 bg-paper-50 px-2 py-1 font-mono text-[12px] leading-none text-ink-800",
        "active:bg-ember-500/15 active:border-ember-500/60",
        "hover:bg-paper-100 hover:border-ink-900/25",
        "dark:border-ink-50/15 dark:bg-ink-800/70 dark:text-ink-100",
        "dark:hover:bg-ink-700 dark:hover:border-ink-50/25",
        "dark:active:bg-ember-400/15 dark:active:border-ember-400/60",
        "min-w-[36px] min-h-[32px]",
        k.wide && "min-w-[56px]",
      )}
    >
      {k.label}
    </button>
  );
}

function Divider() {
  return (
    <span
      aria-hidden
      className="mx-1 my-1 shrink-0 self-stretch w-px bg-ink-900/10 dark:bg-ink-50/10"
    />
  );
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="shrink-0 self-center px-1 font-mono text-[9px] uppercase tracking-[0.16em] text-ink-400 dark:text-ink-500">
      {children}
    </span>
  );
}

export function TerminalKeyboardBar({ onSend, onClose }: Props) {
  const tap = useCallback(
    (data: string) => {
      onSend(data);
    },
    [onSend],
  );

  return (
    <div
      className={cn(
        "flex items-stretch gap-0 border-t border-ink-900/10 bg-paper-100/70 dark:border-ink-50/10 dark:bg-ink-900/40",
        // Keep the dock out of the safe-area on iOS Home-bar devices.
        "pb-[env(safe-area-inset-bottom)]",
      )}
      // Don't let taps inside the bar steal focus from the terminal.
      onPointerDown={(e) => {
        if (e.target instanceof HTMLButtonElement) return;
        e.preventDefault();
      }}
    >
      <div className="flex flex-1 min-w-0 items-center gap-1 overflow-x-auto px-1.5 py-1.5">
        {SPECIAL_KEYS.map((k) => (
          <KeyButton key={k.label} k={k} onTap={tap} />
        ))}
        <Divider />
        <GroupLabel>ctrl</GroupLabel>
        {CTRL_KEYS.map((k) => (
          <KeyButton key={k.label} k={k} onTap={tap} />
        ))}
        <Divider />
        <GroupLabel>tmux</GroupLabel>
        {TMUX_KEYS.map((k) => (
          <KeyButton key={k.label} k={k} onTap={tap} />
        ))}
        <Divider />
        <GroupLabel>win</GroupLabel>
        {TMUX_DIGITS.map((k) => (
          <KeyButton key={k.label} k={k} onTap={tap} />
        ))}
      </div>
      {onClose && (
        <button
          type="button"
          onPointerDown={(e) => {
            e.preventDefault();
            onClose();
          }}
          title="Hide key toolbar"
          className="flex shrink-0 items-center justify-center border-l border-ink-900/10 px-2 text-ink-500 hover:bg-ink-900/5 hover:text-ink-900 dark:border-ink-50/10 dark:hover:bg-ink-50/10 dark:hover:text-ink-50"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

/**
 * Decide whether the keyboard bar should be visible based on the
 * `terminalKeyboardBar` user pref and the current viewport / pointer type.
 *
 * - `on`  → always shown
 * - `off` → always hidden
 * - `auto` (default) → shown when the device has no fine pointer (touch)
 *   OR the viewport is narrow (≤ 768px). Re-evaluated on resize so an
 *   operator who rotates a tablet or resizes a window sees the right
 *   behavior without a reload.
 */
export function useTerminalKeyboardBarVisible(
  mode: "auto" | "on" | "off",
): boolean {
  const [touchOrNarrow, setTouchOrNarrow] = useState(() => detectTouchOrNarrow());

  useEffect(() => {
    if (mode !== "auto") return;
    const recheck = () => setTouchOrNarrow(detectTouchOrNarrow());
    const mqNarrow = window.matchMedia("(max-width: 768px)");
    const mqCoarse = window.matchMedia("(pointer: coarse)");
    mqNarrow.addEventListener("change", recheck);
    mqCoarse.addEventListener("change", recheck);
    window.addEventListener("resize", recheck);
    return () => {
      mqNarrow.removeEventListener("change", recheck);
      mqCoarse.removeEventListener("change", recheck);
      window.removeEventListener("resize", recheck);
    };
  }, [mode]);

  if (mode === "on") return true;
  if (mode === "off") return false;
  return touchOrNarrow;
}

function detectTouchOrNarrow(): boolean {
  if (typeof window === "undefined") return false;
  const narrow = window.matchMedia("(max-width: 768px)").matches;
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  return narrow || coarse;
}

export function TerminalKeyboardToggle({
  mode,
  onChange,
}: {
  mode: "auto" | "on" | "off";
  onChange: (next: "auto" | "on" | "off") => void;
}) {
  // Cycle auto → on → off → auto. Auto/on look the same when active on
  // mobile, but the toggle lets a desktop user force the bar visible.
  const next = mode === "auto" ? "off" : mode === "on" ? "off" : "on";
  const active = mode === "on" || mode === "auto";
  return (
    <button
      type="button"
      onClick={() => onChange(next)}
      title={
        mode === "auto"
          ? "Key bar: auto (mobile only) — click to hide"
          : mode === "on"
            ? "Key bar: always on — click to hide"
            : "Key bar: hidden — click to show"
      }
      className={cn(
        "rounded p-1 transition",
        active
          ? "text-ember-700 hover:bg-ember-500/10 dark:text-ember-300"
          : "text-ink-500 hover:bg-ink-900/5 hover:text-ink-900 dark:hover:bg-ink-50/10 dark:hover:text-ink-50",
      )}
    >
      <Keyboard className="h-3.5 w-3.5" />
    </button>
  );
}
