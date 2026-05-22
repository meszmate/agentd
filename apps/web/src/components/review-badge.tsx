import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CircleAlert,
  CircleHelp,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import type { ReviewVerdict, Task } from "@agentd/contracts";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useClient, useApp } from "@/AppContext";
import { cn } from "@/lib/utils";

/**
 * Small status chip for a task's adversarial-review verdict. Click
 * opens a popover with the reviewer's summary + blocking issues +
 * suggestions plus operator actions (re-run / manual approve).
 *
 * Stays invisible when no review has ever run on this task — the
 * caller decides whether to mount us at all (TaskDetail mounts us
 * when `cfg.review.enabled || task.reviewVerdict`).
 */
export function ReviewBadge({ task, compact }: { task: Task; compact?: boolean }) {
  const client = useClient();
  const { toast } = useApp();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<"rerun" | "override" | null>(null);
  const verdict = task.reviewVerdict ?? null;
  if (!verdict) return null;

  const palette = paletteFor(verdict);

  const onRerun = async () => {
    setBusy("rerun");
    try {
      await client.rerunReview(task.id);
      toast("Re-running review");
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(null);
    }
  };

  const onOverride = async () => {
    const note = window.prompt(
      "Operator approval note (required) — recorded on the task timeline:",
    );
    if (!note?.trim()) return;
    setBusy("override");
    try {
      await client.overrideReview(task.id, note.trim());
      toast("Review approved");
      setOpen(false);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] transition",
            palette.chip,
            compact ? "py-0" : "",
          )}
          title={`adversarial review · ${verdict}`}
        >
          {iconFor(verdict, "h-3 w-3")}
          <span>review · {verdict.replace("_", " ")}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[360px] space-y-3 p-3"
        sideOffset={6}
      >
        <div className="flex items-center gap-2">
          {iconFor(verdict, "h-4 w-4")}
          <div className="font-mono text-[11px] uppercase tracking-[0.12em]">
            {verdict.replace("_", " ")}
          </div>
        </div>
        {task.reviewSummary && (
          <div className="text-[12px] leading-relaxed text-ink-900 dark:text-ink-100">
            {task.reviewSummary}
          </div>
        )}
        {task.reviewBlockingIssues && task.reviewBlockingIssues.length > 0 && (
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-rose-700 dark:text-rose-300">
              Blocking
            </div>
            <ul className="mt-1 list-disc space-y-1 pl-4 text-[12px] leading-snug">
              {task.reviewBlockingIssues.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </div>
        )}
        {task.reviewSuggestions && task.reviewSuggestions.length > 0 && (
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-500 dark:text-ink-400">
              Suggestions
            </div>
            <ul className="mt-1 list-disc space-y-1 pl-4 text-[12px] leading-snug">
              {task.reviewSuggestions.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </div>
        )}
        <div className="flex items-center justify-between gap-2 border-t border-ink-200/40 pt-2 text-[10px] font-mono text-ink-500 dark:border-ink-700/40 dark:text-ink-400">
          <span>
            {task.reviewAgent ?? "?"}
            {task.reviewModel ? `:${task.reviewModel}` : ""}
            {task.reviewedAt
              ? ` · ${new Date(task.reviewedAt).toLocaleTimeString()}`
              : ""}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onRerun}
              disabled={busy != null || verdict === "running"}
              className="inline-flex items-center gap-1 rounded border border-ink-200 px-1.5 py-0.5 hover:bg-ink-50 disabled:opacity-50 dark:border-ink-700 dark:hover:bg-ink-800"
            >
              {busy === "rerun" ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )}
              rerun
            </button>
            {verdict !== "approved" && (
              <button
                type="button"
                onClick={onOverride}
                disabled={busy != null}
                className="inline-flex items-center gap-1 rounded border border-emerald-500/40 px-1.5 py-0.5 text-emerald-700 hover:bg-emerald-50 disabled:opacity-50 dark:text-emerald-300 dark:hover:bg-emerald-950/40"
              >
                <ShieldCheck className="h-3 w-3" />
                approve
              </button>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function paletteFor(v: ReviewVerdict): { chip: string } {
  switch (v) {
    case "approved":
      return {
        chip:
          "border-emerald-500/40 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300",
      };
    case "request_changes":
      return {
        chip:
          "border-amber-500/40 bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
      };
    case "blocked":
      return {
        chip:
          "border-rose-500/40 bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300",
      };
    case "error":
      return {
        chip:
          "border-rose-400/40 bg-rose-50/50 text-rose-600 dark:bg-rose-950/30 dark:text-rose-400",
      };
    case "running":
      return {
        chip:
          "border-sky-500/40 bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300",
      };
    case "pending":
    default:
      return {
        chip:
          "border-ink-300 bg-ink-50 text-ink-600 dark:border-ink-700 dark:bg-ink-900 dark:text-ink-300",
      };
  }
}

function iconFor(v: ReviewVerdict, sz: string) {
  switch (v) {
    case "approved":
      return <CheckCircle2 className={sz} />;
    case "request_changes":
      return <AlertTriangle className={sz} />;
    case "blocked":
      return <CircleAlert className={sz} />;
    case "error":
      return <CircleAlert className={sz} />;
    case "running":
      return <Loader2 className={cn(sz, "animate-spin")} />;
    default:
      return <CircleHelp className={sz} />;
  }
}
