import { useEffect, useRef } from "react";
import { Terminal as TerminalIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTaskTerminalSnapshot } from "@/queries";

/**
 * Live, read-only preview of a terminal-mode task's tmux pane.
 *
 * Backed by `useTaskTerminalSnapshot`, which polls
 * `/api/tasks/:id/terminal-snapshot` (a thin wrapper over
 * `tmux capture-pane -p -J`). Snapshot rather than xterm-attach is
 * deliberate: tmux resizes every attached client to the smallest one,
 * so 6 tile-sized xterms would collapse the master pane's full
 * interactive xterm down to tile dimensions and break it. Polling at
 * ~1.5s is plenty for "see what's happening" without owning a
 * websocket per tile, and the visible-page guard inside the hook
 * stops the poll the moment the overlay closes.
 *
 * Auto-scrolls to the bottom on every fresh snapshot so the operator
 * sees the latest line of output, not stale top-of-buffer chrome.
 * The "alive" pulse in the corner pulls double duty: confirms the
 * tmux session is reachable AND tells the operator the preview is
 * actively refreshing (otherwise a quiet agent could look frozen).
 */
export function TerminalSnapshot({
  taskId,
  className,
  density = "tile",
  refetchInterval,
}: {
  taskId: string;
  className?: string;
  density?: "tile" | "focused";
  /** Override the default poll cadence (default 1500ms). */
  refetchInterval?: number;
}) {
  const q = useTaskTerminalSnapshot(taskId, { refetchInterval });
  const scrollRef = useRef<HTMLPreElement | null>(null);

  // Stick to bottom. Like the transcript tail but simpler — every new
  // snapshot is a full re-paint of the visible pane, so we always
  // want to land the viewport at the latest output regardless of
  // where the operator was scrolled. They can scroll up freely
  // between refreshes; the next refresh re-anchors. That matches how
  // a real terminal feels: tail mode by default, history if you ask.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [q.data?.capturedAt]);

  const content = q.data?.content ?? "";
  const exists = q.data?.exists ?? true;
  const fontSize = density === "focused" ? "11px" : "10px";
  const padX = density === "focused" ? "px-3" : "px-2";
  const padY = density === "focused" ? "py-2" : "py-1.5";

  // Trim the trailing run of blank lines tmux pads the capture with
  // when the agent's TUI sits idle — those blanks waste vertical
  // space on a tile that's already short. Keep leading/internal
  // blanks (they may carry meaning).
  const trimmed = content.replace(/\s+$/g, "");

  return (
    <div
      className={cn(
        "relative h-full min-h-0 w-full overflow-hidden bg-ink-900 text-ink-50",
        className,
      )}
    >
      {/* Subtle scanline overlay — a single transparent gradient
          rendered as a pseudo-fixed layer. Cheap "this is a terminal"
          signal without an animated effect that would burn cycles. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.06]"
        style={{
          background:
            "repeating-linear-gradient(0deg, rgba(255,255,255,0.6) 0px, rgba(255,255,255,0.6) 1px, transparent 1px, transparent 3px)",
        }}
      />

      {/* Top chrome — TERM label + alive pulse. Pinned absolute so it
          doesn't take height away from the actual capture content. */}
      <div className="pointer-events-none absolute left-2 top-1 z-10 flex items-center gap-1.5 rounded font-mono text-[9px] uppercase tracking-[0.12em] text-cyan-300/70">
        <TerminalIcon className="h-2.5 w-2.5" />
        <span>tmux · agentd-task-{taskId.slice(-8)}</span>
      </div>
      <div className="pointer-events-none absolute right-2 top-1 z-10 flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.12em] text-cyan-300/70">
        <span
          className={cn(
            "inline-block h-1.5 w-1.5 rounded-full",
            exists ? "bg-cyan-400 animate-blink" : "bg-red-500/70",
          )}
        />
        {exists ? "live" : "gone"}
      </div>

      {!exists ? (
        <div className="flex h-full items-center justify-center px-4 text-center font-mono text-[11px] text-ink-400">
          tmux session not found
          <br />
          <span className="text-[10px] text-ink-500">
            (terminal-mode task hasn't bootstrapped, or session was killed)
          </span>
        </div>
      ) : trimmed.length === 0 && q.isLoading ? (
        <div className="flex h-full items-center justify-center font-mono text-[11px] text-ink-400">
          capturing…
        </div>
      ) : (
        <pre
          ref={scrollRef}
          className={cn(
            "relative z-0 m-0 h-full overflow-y-auto overflow-x-hidden font-mono leading-tight text-ink-100",
            padX,
            padY,
          )}
          style={{ fontSize, whiteSpace: "pre-wrap", wordBreak: "break-word" }}
        >
          {trimmed || " "}
        </pre>
      )}
    </div>
  );
}
