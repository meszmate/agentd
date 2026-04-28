import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowRight, Inbox, Search } from "lucide-react";
import type { Task, TaskStatus } from "@agentd/contracts";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatusPill } from "@/components/ui/status-dot";
import { Badge } from "@/components/ui/badge";
import { Kbd } from "@/components/ui/kbd";
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
    if (tasksQ.isLoading && !task) return <CenterMessage>Loading task…</CenterMessage>;
    if (!task)
      return (
        <CenterMessage>
          <span className="font-medium text-ink-900 dark:text-ink-50">
            Task not found.
          </span>{" "}
          <Link to="/tasks" className="text-vermilion-600 hover:underline">
            Back to tasks
          </Link>
        </CenterMessage>
      );
    return <TaskDetail key={task.id} task={task} />;
  }

  return <TasksList tasks={tasksQ.data?.tasks ?? []} loading={tasksQ.isLoading} />;
}

function TasksList({ tasks, loading }: { tasks: Task[]; loading: boolean }) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [agentFilter, setAgentFilter] = useState<"all" | "claude" | "codex">("all");
  const [repoQuery, setRepoQuery] = useState("");

  const filtered = useMemo(() => {
    return tasks.filter((t) => {
      if (statusFilter === "active" && !ACTIVE_STATUSES.includes(t.status))
        return false;
      if (statusFilter === "done" && t.status !== "done") return false;
      if (statusFilter === "failed" && t.status !== "failed" && t.status !== "stopped")
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
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-7xl px-6 lg:px-10 py-8 lg:py-10">
        {/* Header */}
        <header className="rise rise-1 flex items-end justify-between gap-4 mb-8">
          <div>
            <div className="label-section mb-2">Workspace</div>
            <h1 className="display text-4xl sm:text-5xl text-ink-900 dark:text-ink-50">
              Tasks
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-ink-500 dark:text-ink-400">
              {tasks.length === 0
                ? "Spawn an agent to get started."
                : `${tasks.length} total · ${lanes.active.length} active · ${lanes.recent.length} in last 24h`}
            </p>
          </div>
        </header>

        {/* Filter strip */}
        {tasks.length > 0 && (
          <div className="rise rise-2 mb-8 flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 rounded-lg border border-ink-900/10 bg-cream-50 p-1 dark:border-ink-50/10 dark:bg-ink-800">
              {(["all", "active", "done", "failed"] as StatusFilter[]).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStatusFilter(s)}
                  className={cn(
                    "rounded-md px-3 h-7 font-mono text-2xs uppercase tracking-[0.08em] transition-colors",
                    statusFilter === s
                      ? "bg-ink-900 text-cream-50 dark:bg-vermilion-500"
                      : "text-ink-500 hover:text-ink-900 dark:text-ink-400 dark:hover:text-ink-50",
                  )}
                >
                  {s}
                </button>
              ))}
            </div>

            <Select
              value={agentFilter}
              onValueChange={(v) => setAgentFilter(v as typeof agentFilter)}
            >
              <SelectTrigger className="h-9 w-[140px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All agents</SelectItem>
                <SelectItem value="claude">Claude</SelectItem>
                <SelectItem value="codex">Codex</SelectItem>
              </SelectContent>
            </Select>

            <div className="relative ml-auto w-full max-w-xs">
              <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-ink-400 dark:text-ink-500" />
              <Input
                value={repoQuery}
                onChange={(e) => setRepoQuery(e.target.value)}
                placeholder="Filter title, repo, branch…"
                className="pl-8"
              />
            </div>
          </div>
        )}

        {loading && tasks.length === 0 ? (
          <div className="text-center py-16 text-sm text-ink-500 dark:text-ink-400">
            Loading tasks…
          </div>
        ) : tasks.length === 0 ? (
          <EmptyState />
        ) : filtered.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-ink-900/10 dark:border-ink-50/10 p-10 text-center">
            <p className="text-sm text-ink-500 dark:text-ink-400">
              No tasks match the filters.
            </p>
          </div>
        ) : (
          <div className="rise rise-3 space-y-10">
            {lanes.active.length > 0 && (
              <Lane
                heading="Active"
                count={lanes.active.length}
                accent
                tasks={lanes.active}
              />
            )}
            {lanes.recent.length > 0 && (
              <Lane
                heading="Recent"
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
          </div>
        )}
      </div>
    </div>
  );
}

function Lane({
  heading,
  count,
  tasks,
  accent,
  muted,
}: {
  heading: string;
  count: number;
  tasks: Task[];
  accent?: boolean;
  muted?: boolean;
}) {
  return (
    <section>
      <header className="mb-4 flex items-baseline gap-3">
        <h2
          className={cn(
            "display text-2xl",
            accent
              ? "text-vermilion-600 dark:text-vermilion-400"
              : "text-ink-900 dark:text-ink-50",
            muted && "text-ink-500 dark:text-ink-400",
          )}
        >
          {heading}
        </h2>
        <span className="num text-base text-ink-400 dark:text-ink-500">
          {count}
        </span>
        <span className="ml-auto rule" />
      </header>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {tasks.map((t) => (
          <TaskCard key={t.id} task={t} muted={muted} />
        ))}
      </div>
    </section>
  );
}

function TaskCard({ task, muted }: { task: Task; muted?: boolean }) {
  const totalTok =
    (task.totalInputTokens ?? 0) + (task.totalOutputTokens ?? 0);

  return (
    <Link
      to={`/tasks/${task.id}`}
      className={cn(
        "group flex h-full flex-col gap-3 rounded-2xl border border-ink-900/10 bg-cream-50 p-4 shadow-edit transition-all hover:-translate-y-0.5 hover:shadow-deep dark:border-ink-50/10 dark:bg-ink-800",
        muted && "opacity-80 hover:opacity-100",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <StatusPill status={task.status} />
        <span className="font-mono text-2xs text-ink-400 dark:text-ink-500">
          {formatTs(task.updatedAt)}
        </span>
      </div>

      <h3 className="display text-lg leading-tight text-ink-900 line-clamp-2 dark:text-ink-50 group-hover:text-vermilion-600 dark:group-hover:text-vermilion-400 transition-colors">
        {task.title}
      </h3>

      <div className="flex items-center gap-1.5 flex-wrap">
        <Badge variant="secondary">{task.agent}</Badge>
        <Badge variant="outline" className="font-mono normal-case">
          {task.branch}
        </Badge>
        {task.prUrl && <Badge variant="vermilion">pr</Badge>}
      </div>

      <div className="font-mono text-2xs text-ink-500 dark:text-ink-400 truncate">
        {task.repoPath}
      </div>

      <div className="mt-auto flex items-center justify-between border-t border-ink-900/10 dark:border-ink-50/10 pt-2.5">
        <div className="flex items-baseline gap-3">
          <span className="num text-base text-ink-900 dark:text-ink-50">
            {formatTokens(totalTok)}
          </span>
          <span className="text-2xs text-ink-400 dark:text-ink-500">tok</span>
          <span className="num text-base text-ink-900 dark:text-ink-50">
            {formatCost(task.totalCostUsd)}
          </span>
        </div>
        <ArrowRight className="h-3.5 w-3.5 text-ink-400 group-hover:text-vermilion-500 group-hover:translate-x-0.5 transition-all" />
      </div>
    </Link>
  );
}

function EmptyState() {
  return (
    <div className="rounded-3xl border border-dashed border-ink-900/10 p-16 text-center dark:border-ink-50/10">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-vermilion-500/10 text-vermilion-600 dark:text-vermilion-400">
        <Inbox className="h-5 w-5" />
      </div>
      <h2 className="mt-5 display text-2xl text-ink-900 dark:text-ink-50">
        No tasks yet
      </h2>
      <p className="mt-2 max-w-sm mx-auto text-sm text-ink-500 dark:text-ink-400">
        Tap <Kbd>⌘N</Kbd> or use the <span className="font-medium text-ink-700 dark:text-ink-200">New task</span> button to spawn an agent in a fresh git worktree.
      </p>
    </div>
  );
}

function CenterMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full w-full items-center justify-center p-8 text-center text-sm text-ink-500 dark:text-ink-400">
      {children}
    </div>
  );
}

