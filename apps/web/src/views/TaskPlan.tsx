import { Check, Circle, ListChecks, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Live agent todo / plan checklist.
 *
 * Claude's TodoWrite tool emits `{ todos: [{content, status, activeForm}] }`,
 * Codex's update_plan tool emits `{ plan: [{step, status}] }` — both get
 * normalized to TaskPlanItem on the way in (see TaskDetail). We render the
 * latest snapshot per task so the operator can see what the agent is
 * working through, exactly like Claude Code's own TodoWrite display.
 */
export interface TaskPlanItem {
  content: string;
  activeForm?: string;
  status: "pending" | "in_progress" | "completed";
}

export function TaskPlan({
  items,
  updatedAt,
}: {
  items: TaskPlanItem[];
  updatedAt: number | null;
}) {
  if (items.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 text-center">
        <ListChecks className="h-7 w-7 text-ink-300 dark:text-ink-600" />
        <p className="mt-3 text-[13px] font-medium text-ink-700 dark:text-ink-200">
          No plan yet
        </p>
        <p className="mt-1 max-w-md text-[12px] text-ink-500 dark:text-ink-400 leading-relaxed">
          When the agent calls{" "}
          <code className="font-mono text-[11px]">TodoWrite</code> (Claude) or{" "}
          <code className="font-mono text-[11px]">update_plan</code> (Codex), its
          checklist will show up here and update live as it works.
        </p>
      </div>
    );
  }

  const counts = items.reduce(
    (a, t) => {
      a[t.status] = (a[t.status] ?? 0) + 1;
      return a;
    },
    {} as Record<TaskPlanItem["status"], number>,
  );
  const done = counts.completed ?? 0;
  const total = items.length;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-ink-900/10 dark:border-ink-50/10 px-5 py-2.5 shrink-0">
        <ListChecks className="h-3.5 w-3.5 text-ember-500 shrink-0" />
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-500 dark:text-ink-400">
          Plan
        </span>
        <span className="font-mono text-[10px] tabular-nums text-ink-400 dark:text-ink-500">
          {done}/{total}
        </span>
        <div className="ml-2 flex-1 max-w-[180px]">
          <div className="h-1 rounded-full bg-ink-900/[0.06] dark:bg-ink-50/[0.06] overflow-hidden">
            <div
              className="h-full rounded-full bg-ember-500 transition-all duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
        {updatedAt != null && (
          <span className="ml-auto font-mono text-[10px] text-ink-400 dark:text-ink-500">
            updated {fmtRelative(updatedAt)}
          </span>
        )}
      </div>

      <ul className="flex-1 min-h-0 overflow-y-auto divide-y divide-ink-900/[0.06] dark:divide-ink-50/[0.06]">
        {items.map((item, i) => (
          <PlanRow key={i} item={item} />
        ))}
      </ul>
    </div>
  );
}

function PlanRow({ item }: { item: TaskPlanItem }) {
  const isDone = item.status === "completed";
  const isActive = item.status === "in_progress";
  return (
    <li
      className={cn(
        "flex items-start gap-3 px-5 py-2.5 transition-colors",
        isActive && "bg-ember-500/[0.04] dark:bg-ember-500/[0.06]",
      )}
    >
      <span
        className={cn(
          "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
          isDone &&
            "border-emerald-500/60 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
          isActive &&
            "border-ember-500/60 bg-ember-500/15 text-ember-700 dark:text-ember-300",
          !isDone &&
            !isActive &&
            "border-ink-900/20 bg-paper-50 text-ink-400 dark:border-ink-50/20 dark:bg-ink-800",
        )}
      >
        {isDone ? (
          <Check className="h-2.5 w-2.5" strokeWidth={3} />
        ) : isActive ? (
          <Loader2 className="h-2.5 w-2.5 animate-spin" strokeWidth={2.5} />
        ) : (
          <Circle className="h-1.5 w-1.5" />
        )}
      </span>
      <div className="flex-1 min-w-0">
        <div
          className={cn(
            "text-[13px] leading-snug",
            isDone
              ? "text-ink-500 line-through dark:text-ink-400"
              : isActive
                ? "text-ink-900 font-medium dark:text-ink-50"
                : "text-ink-700 dark:text-ink-200",
          )}
        >
          {item.content}
        </div>
        {isActive && item.activeForm && item.activeForm !== item.content && (
          <div className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-ember-700 dark:text-ember-300">
            {item.activeForm}…
          </div>
        )}
      </div>
    </li>
  );
}

function fmtRelative(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 5_000) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}
