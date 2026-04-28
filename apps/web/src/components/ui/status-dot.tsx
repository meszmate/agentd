import { cn } from "@/lib/utils";
import type { TaskStatus } from "@agentd/contracts";

const STATUS_COLOR: Record<TaskStatus, string> = {
  pending: "bg-ink-400 dark:bg-ink-500",
  running: "bg-vermilion-500 animate-blink",
  waiting_input: "bg-amber-500 animate-blink",
  waiting_perm: "bg-amber-500 animate-blink",
  done: "bg-emerald-600 dark:bg-emerald-500",
  failed: "bg-red-600 dark:bg-red-500",
  stopped: "bg-ink-400 dark:bg-ink-500",
};

const STATUS_LABEL: Record<TaskStatus, string> = {
  pending: "pending",
  running: "running",
  waiting_input: "input",
  waiting_perm: "perm",
  done: "done",
  failed: "failed",
  stopped: "stopped",
};

export function StatusDot({
  status,
  className,
  size = "md",
}: {
  status: TaskStatus;
  className?: string;
  size?: "sm" | "md";
}) {
  return (
    <span
      aria-label={STATUS_LABEL[status]}
      title={STATUS_LABEL[status]}
      className={cn(
        "inline-block rounded-full",
        size === "sm" ? "h-1.5 w-1.5" : "h-2 w-2",
        STATUS_COLOR[status],
        className,
      )}
    />
  );
}

export function StatusPill({
  status,
  className,
}: {
  status: TaskStatus;
  className?: string;
}) {
  const tone =
    status === "running"
      ? "border-vermilion-500/25 bg-vermilion-500/10 text-vermilion-700 dark:text-vermilion-300"
      : status === "done"
      ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
      : status === "failed"
      ? "border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-300"
      : status === "waiting_input" || status === "waiting_perm"
      ? "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300"
      : "border-ink-900/10 bg-ink-900/[0.04] text-ink-500 dark:border-ink-50/10 dark:bg-ink-50/[0.04] dark:text-ink-400";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 font-mono text-2xs uppercase tracking-[0.06em]",
        tone,
        className,
      )}
    >
      <StatusDot status={status} size="sm" />
      {STATUS_LABEL[status]}
    </span>
  );
}
