import { cn } from "@/lib/utils";
import type { TaskMode, TaskStatus } from "@agentd/contracts";

const STATUS_COLOR: Record<TaskStatus, string> = {
  pending: "bg-ink-400 dark:bg-ink-500",
  running: "bg-ember-500 animate-blink",
  waiting_input: "bg-amber-500 animate-blink",
  waiting_perm: "bg-amber-500 animate-blink",
  idle: "bg-ink-300 dark:bg-ink-600",
  done: "bg-emerald-600 dark:bg-emerald-500",
  failed: "bg-red-600 dark:bg-red-500",
  stopped: "bg-ink-400 dark:bg-ink-500",
};

const STATUS_LABEL: Record<TaskStatus, string> = {
  pending: "pending",
  running: "running",
  waiting_input: "input",
  waiting_perm: "perm",
  idle: "ready",
  done: "done",
  failed: "failed",
  stopped: "stopped",
};

// Terminal-mode tasks don't go through the managed runner status
// machine — the tmux session is "alive" whenever the task is open.
// We surface that as a distinct cyan TERM marker so the operator can
// tell at a glance which tiles drive an interactive agent CLI vs a
// managed stream-json runner. The underlying TaskStatus enum stays
// unchanged (this is a display override, not a new server status) so
// the daemon-side state machine doesn't need a new value to handle.
const TERM_COLOR = "bg-cyan-500 animate-blink";
const TERM_LABEL = "term";

export function StatusDot({
  status,
  mode,
  className,
  size = "md",
}: {
  status: TaskStatus;
  mode?: TaskMode;
  className?: string;
  size?: "sm" | "md";
}) {
  const isTerm = mode === "terminal";
  // When the terminal-mode task has reached a real terminal state
  // (done/failed/stopped) we honor the finished status — the tmux
  // session is gone, no point pretending the terminal is still live.
  const finished = status === "done" || status === "failed" || status === "stopped";
  const color = isTerm && !finished ? TERM_COLOR : STATUS_COLOR[status];
  const label = isTerm && !finished ? TERM_LABEL : STATUS_LABEL[status];
  return (
    <span
      aria-label={label}
      title={label}
      className={cn(
        "inline-block rounded-full",
        size === "sm" ? "h-1.5 w-1.5" : "h-2 w-2",
        color,
        className,
      )}
    />
  );
}

export function StatusPill({
  status,
  mode,
  className,
}: {
  status: TaskStatus;
  mode?: TaskMode;
  className?: string;
}) {
  const isTerm = mode === "terminal";
  const finished = status === "done" || status === "failed" || status === "stopped";
  const showTerm = isTerm && !finished;
  const tone = showTerm
    ? "border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300"
    : status === "running"
    ? "border-ember-500/25 bg-ember-500/10 text-ember-700 dark:text-ember-300"
    : status === "done"
    ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
    : status === "failed"
    ? "border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-300"
    : status === "waiting_input" || status === "waiting_perm"
    ? "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300"
    : "border-ink-900/10 bg-ink-900/[0.04] text-ink-500 dark:border-ink-50/10 dark:bg-ink-50/[0.04] dark:text-ink-400";

  const label = showTerm ? TERM_LABEL : STATUS_LABEL[status];

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 font-mono text-2xs uppercase tracking-[0.06em]",
        tone,
        className,
      )}
    >
      <StatusDot status={status} mode={mode} size="sm" />
      {label}
    </span>
  );
}
