import {
  CheckCircle2,
  CircleDot,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { Task } from "@agentd/contracts";

/**
 * Lifecycle icon for a task that came from a GitHub issue or PR. Picks
 * an icon + color from `task.githubPrState` / `task.githubIssueState`
 * (refreshed by the daemon on spawn, on PR actions, and on github tab
 * refreshes). Renders nothing when the task has no GitHub artifact.
 *
 * Color convention matches ProjectGithub.tsx so the icons mean the same
 * thing in the github tab and on a task row.
 */
export function TaskGithubBadge({
  task,
  size = "sm",
  className,
}: {
  task: Task;
  size?: "xs" | "sm";
  className?: string;
}) {
  const sizeCls = size === "xs" ? "h-3 w-3" : "h-3.5 w-3.5";
  let icon: React.ReactNode = null;
  let label = "";
  let tone = "";
  if (task.githubPr) {
    const state = (task.githubPrState ?? "").toUpperCase();
    const draft = task.githubPrIsDraft === true;
    if (state === "MERGED") {
      icon = <GitMerge className={sizeCls} />;
      label = `PR #${task.githubPr} merged`;
      tone = "text-violet-600 dark:text-violet-400";
    } else if (state === "CLOSED") {
      icon = <GitPullRequestClosed className={sizeCls} />;
      label = `PR #${task.githubPr} closed`;
      tone = "text-red-600 dark:text-red-400";
    } else {
      icon = <GitPullRequest className={sizeCls} />;
      label = `PR #${task.githubPr}${draft ? " (draft)" : " open"}`;
      tone = draft
        ? "text-ink-400 dark:text-ink-500"
        : "text-emerald-600 dark:text-emerald-400";
    }
  } else if (task.githubIssue) {
    const state = (task.githubIssueState ?? "").toUpperCase();
    if (state === "CLOSED") {
      icon = <CheckCircle2 className={sizeCls} />;
      label = `Issue #${task.githubIssue} closed`;
      tone = "text-violet-600 dark:text-violet-400";
    } else {
      icon = <CircleDot className={sizeCls} />;
      label = `Issue #${task.githubIssue} open`;
      tone = "text-emerald-600 dark:text-emerald-400";
    }
  }
  if (!icon) return null;
  return (
    <span
      aria-label={label}
      title={label}
      className={cn("inline-flex shrink-0", tone, className)}
    >
      {icon}
    </span>
  );
}
