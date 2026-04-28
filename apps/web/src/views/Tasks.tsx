import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { Task, TaskStatus } from "@agentd/contracts";
import { Input } from "@/components/ui/input";
import {
  Count,
  Kicker,
  PageTopbar,
  Spacer,
  VRule,
} from "@/components/ui/page-topbar";
import { SectionHeader } from "@/components/ui/section-header";
import { FilterPills } from "@/components/ui/filter-pills";
import { useTasks } from "@/queries";
import {
  cn,
  formatCost,
  formatTokens,
  formatTs,
  shortId,
} from "@/lib/utils";
import { TaskDetail } from "@/views/TaskDetail";

type StatusFilter = "all" | "active" | "done" | "failed";

const ACTIVE_STATUSES: TaskStatus[] = [
  "running",
  "waiting_input",
  "waiting_perm",
  "pending",
];

export function Tasks() {
  const { taskId } = useParams<{ taskId: string }>();
  const tasksQ = useTasks();

  if (taskId) {
    const task = tasksQ.data?.tasks.find((t) => t.id === taskId);
    if (tasksQ.isLoading && !task) {
      return (
        <div className="flex h-full items-center justify-center text-[12px] text-ink-500 dark:text-ink-400">
          Loading task…
        </div>
      );
    }
    if (!task) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-2 text-[12px] text-ink-500 dark:text-ink-400">
          <span>
            Task <span className="font-mono">{shortId(taskId)}</span> not
            found.
          </span>
          <Link to="/tasks" className="text-vermilion-600 hover:underline">
            Back to tasks
          </Link>
        </div>
      );
    }
    return <TaskDetail key={task.id} task={task} />;
  }

  return (
    <TasksList tasks={tasksQ.data?.tasks ?? []} loading={tasksQ.isLoading} />
  );
}

function TasksList({ tasks, loading }: { tasks: Task[]; loading: boolean }) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [agentFilter, setAgentFilter] = useState<"all" | "claude" | "codex">(
    "all",
  );
  const [repoQuery, setRepoQuery] = useState("");

  const counts = useMemo(() => {
    let active = 0;
    let done = 0;
    let failed = 0;
    for (const t of tasks) {
      if (ACTIVE_STATUSES.includes(t.status)) active++;
      else if (t.status === "done") done++;
      else if (t.status === "failed" || t.status === "stopped") failed++;
    }
    return { all: tasks.length, active, done, failed };
  }, [tasks]);

  const filtered = useMemo(() => {
    return tasks.filter((t) => {
      if (statusFilter === "active" && !ACTIVE_STATUSES.includes(t.status))
        return false;
      if (statusFilter === "done" && t.status !== "done") return false;
      if (
        statusFilter === "failed" &&
        t.status !== "failed" &&
        t.status !== "stopped"
      )
        return false;
      if (agentFilter !== "all" && t.agent !== agentFilter) return false;
      if (repoQuery) {
        const q = repoQuery.toLowerCase();
        if (
          !t.repoPath.toLowerCase().includes(q) &&
          !t.title.toLowerCase().includes(q) &&
          !t.branch.toLowerCase().includes(q)
        )
          return false;
      }
      return true;
    });
  }, [tasks, statusFilter, agentFilter, repoQuery]);

  const lanes = useMemo(() => {
    const now = Date.now();
    const dayAgo = now - 24 * 60 * 60 * 1000;
    const active: Task[] = [];
    const recent: Task[] = [];
    const archive: Task[] = [];
    for (const t of filtered) {
      if (ACTIVE_STATUSES.includes(t.status)) active.push(t);
      else if (t.updatedAt >= dayAgo) recent.push(t);
      else archive.push(t);
    }
    return { active, recent, archive };
  }, [filtered]);

  return (
    <div className="flex h-full flex-col">
      {/* Topbar with title + counts */}
      <PageTopbar>
        <Kicker>workspace</Kicker>
        <VRule />
        <span className="text-[13px] text-ink-900 dark:text-ink-50 font-medium">
          Tasks
        </span>
        <Count>{tasks.length}</Count>
        {counts.active > 0 && (
          <>
            <span className="text-ink-300 dark:text-ink-600">·</span>
            <span className="font-mono text-[11px] tabular-nums text-vermilion-700 dark:text-vermilion-300">
              {counts.active} active
            </span>
          </>
        )}
        <Spacer />
      </PageTopbar>

      {/* Filter strip */}
      <div className="flex items-center gap-3 border-b border-ink-900/10 dark:border-ink-50/10 px-5 py-2 shrink-0 bg-cream-100/30 dark:bg-ink-50/[0.015]">
        <FilterPills
          options={[
            { key: "all", label: "All", count: counts.all },
            { key: "active", label: "Active", count: counts.active },
            { key: "done", label: "Done", count: counts.done },
            { key: "failed", label: "Failed", count: counts.failed },
          ]}
          value={statusFilter}
          onChange={setStatusFilter}
        />

        <span className="vrule h-5" />

        <FilterPills
          options={[
            { key: "all", label: "Any agent" },
            { key: "claude", label: "Claude" },
            { key: "codex", label: "Codex" },
          ]}
          value={agentFilter}
          onChange={setAgentFilter}
        />

        <div className="ml-auto relative w-full max-w-[260px]">
          <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 font-mono text-[10px] text-ink-400 dark:text-ink-500">
            ⌕
          </span>
          <Input
            value={repoQuery}
            onChange={(e) => setRepoQuery(e.target.value)}
            placeholder="title, repo, branch…"
            className="h-7 pl-7 text-[12px]"
          />
        </div>
      </div>

      {/* Lanes */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading && tasks.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[12px] text-ink-500 dark:text-ink-400">
            Loading tasks…
          </div>
        ) : tasks.length === 0 ? (
          <EmptyState />
        ) : filtered.length === 0 ? (
          <div className="flex items-center justify-center py-16 text-[12px] text-ink-500 dark:text-ink-400">
            No tasks match the filters.
          </div>
        ) : (
          <>
            {lanes.active.length > 0 && (
              <Lane
                heading="Active"
                count={lanes.active.length}
                tasks={lanes.active}
                accent
              />
            )}
            {lanes.recent.length > 0 && (
              <Lane
                heading="Recent"
                hint="last 24 hours"
                count={lanes.recent.length}
                tasks={lanes.recent}
              />
            )}
            {lanes.archive.length > 0 && (
              <Lane
                heading="Archive"
                count={lanes.archive.length}
                tasks={lanes.archive}
                muted
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Lane({
  heading,
  hint,
  count,
  tasks,
  accent,
  muted,
}: {
  heading: string;
  hint?: string;
  count: number;
  tasks: Task[];
  accent?: boolean;
  muted?: boolean;
}) {
  return (
    <section className={muted ? "opacity-80" : undefined}>
      <SectionHeader
        label={heading}
        hint={hint}
        right={
          <span
            className={cn(
              "font-mono text-[10px] tabular-nums",
              accent
                ? "text-vermilion-700 dark:text-vermilion-300"
                : "text-ink-400 dark:text-ink-500",
            )}
          >
            {count}
          </span>
        }
        sticky={false}
      />
      <ul className="divide-y divide-ink-900/[0.06] dark:divide-ink-50/[0.06]">
        {tasks.map((t) => (
          <TaskRow key={t.id} task={t} />
        ))}
      </ul>
    </section>
  );
}

function TaskRow({ task }: { task: Task }) {
  const totalTok =
    (task.totalInputTokens ?? 0) + (task.totalOutputTokens ?? 0);

  return (
    <li>
      <Link
        to={`/tasks/${task.id}`}
        className="group h-12 px-5 flex items-center gap-3 hover:bg-cream-100/40 transition-colors dark:hover:bg-ink-50/[0.02]"
      >
        <StatusDotSm status={task.status} />
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className="text-[13px] font-medium text-ink-900 dark:text-ink-50 truncate shrink-0 max-w-[42ch]">
            {task.title}
          </span>
          <span className="font-mono text-[10px] text-ink-400 dark:text-ink-500 shrink-0">
            {task.agent}
          </span>
          <span className="text-ink-300 dark:text-ink-600 shrink-0">·</span>
          <span className="font-mono text-[11px] text-ink-400 dark:text-ink-500 truncate min-w-0">
            {task.branch}
          </span>
          {task.prUrl && (
            <span className="shrink-0 inline-flex h-4 px-1 rounded text-[9px] font-medium uppercase tracking-[0.08em] bg-vermilion-500/10 text-vermilion-700 dark:text-vermilion-300">
              pr
            </span>
          )}
        </div>

        <div className="hidden md:flex items-baseline gap-3 shrink-0 font-mono text-[11px] tabular-nums text-ink-400 dark:text-ink-500">
          <span title="tokens">{formatTokens(totalTok)}</span>
          <span title="cost">{formatCost(task.totalCostUsd)}</span>
        </div>

        <span className="font-mono text-[10px] tabular-nums text-ink-300 dark:text-ink-600 w-14 text-right shrink-0">
          {formatTs(task.updatedAt)}
        </span>
      </Link>
    </li>
  );
}

function StatusDotSm({ status }: { status: TaskStatus }) {
  const tone =
    status === "running"
      ? "bg-vermilion-500 animate-blink"
      : status === "done"
      ? "bg-emerald-500"
      : status === "failed"
      ? "bg-red-500"
      : status === "waiting_input" || status === "waiting_perm"
      ? "bg-amber-500 animate-blink"
      : "bg-ink-300 dark:bg-ink-600";
  return <span className={cn("inline-block size-1.5 rounded-full shrink-0", tone)} />;
}

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-16">
      <span className="font-mono text-[24px] text-ink-300 dark:text-ink-600">
        ◆
      </span>
      <div className="text-[13px] text-ink-700 dark:text-ink-200 font-medium">
        No tasks yet
      </div>
      <p className="max-w-sm text-center text-[12px] text-ink-500 dark:text-ink-400">
        Tap{" "}
        <kbd className="rounded border border-ink-900/15 bg-ink-900/[0.04] px-1.5 py-0.5 font-mono text-[10px] dark:border-ink-50/15 dark:bg-ink-50/[0.04]">
          ⌘N
        </kbd>{" "}
        or use the sidebar's New task button to spawn an agent in a fresh git
        worktree.
      </p>
    </div>
  );
}
