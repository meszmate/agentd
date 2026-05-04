import { useMemo } from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  ArrowUpRight,
  CheckCircle2,
  Circle,
  Copy,
  FolderGit2,
  Loader2,
  Plus,
  TerminalSquare,
  XCircle,
} from "lucide-react";
import type { Project, Task } from "@agentd/contracts";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Kicker,
  PageTopbar,
  Spacer,
  VRule,
} from "@/components/ui/page-topbar";
import { useApp, useClient } from "@/AppContext";
import { usePatchPrefs, useProjects, useTasks } from "@/queries";
import { useStore } from "@/store";
import { cn, formatCost, formatTokens, formatTs } from "@/lib/utils";
import { TaskGithubBadge } from "@/components/ui/task-github-badge";

const PALETTE = [
  "#DC2626",
  "#EA580C",
  "#D97706",
  "#65A30D",
  "#059669",
  "#0891B2",
  "#2563EB",
  "#7C3AED",
  "#DB2777",
];

function colorFor(id: string, override: string | null | undefined): string {
  if (override) return override;
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(hash) % PALETTE.length]!;
}

const startOfDay = (() => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
})();
const startOfWeek = startOfDay - 6 * 24 * 60 * 60 * 1000;

export function Projects() {
  const projectsQ = useProjects();
  const tasksQ = useTasks();
  const unread = useStore((s) => s.unreadByProject);
  const items = projectsQ.data?.projects ?? [];
  const allTasks = tasksQ.data?.tasks ?? [];

  // Group tasks by project once for reuse in cards.
  const tasksByProject = useMemo(() => {
    const m = new Map<string, Task[]>();
    for (const t of allTasks) {
      const key = t.projectId ?? `path:${t.repoPath}`;
      const arr = m.get(key) ?? [];
      arr.push(t);
      m.set(key, arr);
    }
    return m;
  }, [allTasks]);

  const totalActive = items.reduce((s, p) => s + (p.activeCount ?? 0), 0);

  return (
    <div className="flex h-full flex-col">
      <PageTopbar>
        <Kicker>workspace</Kicker>
        <VRule />
        <span className="text-[13px] text-ink-900 dark:text-ink-50 font-medium">
          Projects
        </span>
        <span className="text-ink-300 dark:text-ink-600">·</span>
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] tabular-nums text-ink-500 dark:text-ink-400">
          {items.length} total
        </span>
        {totalActive > 0 && (
          <>
            <span className="text-ink-300 dark:text-ink-600">·</span>
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] tabular-nums text-ember-700 dark:text-ember-300">
              {totalActive} live
            </span>
          </>
        )}
        <Spacer />
        <Button size="xs" asChild>
          <Link to="/home">
            <Plus className="h-3 w-3" /> New task
          </Link>
        </Button>
      </PageTopbar>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {projectsQ.isLoading && !projectsQ.data ? (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 px-5 py-5">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-44 w-full rounded-lg" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 px-5 py-5">
            {items.map((p) => {
              const key = p.id;
              const projectTasks =
                tasksByProject.get(key) ??
                tasksByProject.get(`path:${p.path}`) ??
                [];
              return (
                <ProjectCard
                  key={p.id}
                  project={p}
                  tasks={projectTasks}
                  color={colorFor(p.id, p.color)}
                  unread={unread[p.id] ?? 0}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function ProjectCard({
  project: p,
  tasks,
  color,
  unread,
}: {
  project: Project;
  tasks: Task[];
  color: string;
  unread: number;
}) {
  const { toast } = useApp();
  const client = useClient();
  const patchPrefs = usePatchPrefs();

  const stats = useMemo(() => {
    let active = 0;
    let doneToday = 0;
    let failedRecent = 0;
    let costWeek = 0;
    let totalTok = 0;
    for (const t of tasks) {
      if (
        t.status === "running" ||
        t.status === "waiting_input" ||
        t.status === "waiting_perm"
      ) {
        active += 1;
      }
      if (t.status === "done" && t.updatedAt >= startOfDay) doneToday += 1;
      if (t.status === "failed" && t.updatedAt >= startOfWeek) failedRecent += 1;
      if (t.updatedAt >= startOfWeek) costWeek += t.totalCostUsd ?? 0;
      totalTok += (t.totalInputTokens ?? 0) + (t.totalOutputTokens ?? 0);
    }
    return { active, doneToday, failedRecent, costWeek, totalTok };
  }, [tasks]);

  const recent = useMemo(() => {
    return [...tasks]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 3);
  }, [tasks]);

  const onCopyPath = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(p.path);
      toast(`copied ${p.path}`);
    } catch {
      toast("clipboard unavailable", true);
    }
  };

  const onOpenShell = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const name = `proj-${p.slug}`;
    try {
      await client.createTerminalSession({ name, cwd: p.path });
    } catch {
      // already exists is fine
    }
    window.location.assign(`/terminal/${encodeURIComponent(name)}`);
  };

  return (
    <Link
      to={`/projects/${p.slug}`}
      className="group flex flex-col rounded-lg border border-ink-900/10 bg-paper-50 p-4 transition-colors hover:border-ink-900/20 hover:bg-paper-100 dark:border-ink-50/10 dark:bg-ink-800 dark:hover:border-ink-50/20 dark:hover:bg-ink-700"
    >
      {/* Header — color + name + active pulse */}
      <div className="flex items-start gap-3">
        <span
          className="size-3 shrink-0 rounded-md mt-1"
          style={{ background: color }}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-semibold text-ink-900 dark:text-ink-50 truncate">
              {p.name}
            </span>
            {stats.active > 0 && (
              <span className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.08em] text-ember-700 dark:text-ember-300">
                <span className="h-1.5 w-1.5 rounded-full bg-ember-500 animate-blink" />
                {stats.active} live
              </span>
            )}
            {unread > 0 && (
              <span className="inline-flex items-center h-4 px-1 rounded font-mono text-[9px] uppercase tracking-[0.08em] bg-ember-500 text-white">
                +{unread}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onCopyPath}
            className="mt-0.5 inline-flex items-center gap-1 font-mono text-[10px] text-ink-500 hover:text-ink-900 transition-colors dark:text-ink-400 dark:hover:text-ink-50"
            title="copy path"
          >
            <FolderGit2 className="h-2.5 w-2.5" />
            <span className="truncate max-w-[28ch]">{p.path}</span>
            <Copy className="h-2.5 w-2.5 opacity-0 group-hover:opacity-100 transition-opacity" />
          </button>
        </div>
        <ArrowUpRight className="h-3.5 w-3.5 text-ink-400 dark:text-ink-500 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
      </div>

      {/* Stat row */}
      <div className="mt-3 grid grid-cols-4 gap-2 border-y border-ink-900/[0.06] dark:border-ink-50/[0.06] py-2">
        <Stat label="tasks" value={p.taskCount ?? 0} />
        <Stat
          label="today"
          value={stats.doneToday}
          tone="emerald"
          icon={CheckCircle2}
        />
        <Stat
          label="failed"
          value={stats.failedRecent}
          tone={stats.failedRecent > 0 ? "red" : undefined}
          icon={stats.failedRecent > 0 ? XCircle : undefined}
        />
        <Stat
          label="$/wk"
          value={formatCost(stats.costWeek)}
          numeric={false}
        />
      </div>

      {/* Recent tasks preview */}
      <div className="mt-3 flex-1 min-h-[60px]">
        {recent.length === 0 ? (
          <div className="flex h-full items-center justify-center font-mono text-[10px] text-ink-400 dark:text-ink-500">
            no tasks yet
          </div>
        ) : (
          <ul className="space-y-1">
            {recent.map((t) => (
              <li
                key={t.id}
                className="flex items-center gap-2 text-[12px]"
              >
                <StatusDot status={t.status} />
                <TaskGithubBadge task={t} size="xs" />
                <span className="flex-1 truncate text-ink-700 dark:text-ink-200">
                  {t.title}
                </span>
                <span className="font-mono text-[10px] tabular-nums text-ink-400 dark:text-ink-500 shrink-0">
                  {formatTs(t.updatedAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Actions */}
      <div className="mt-3 flex items-center gap-1.5 border-t border-ink-900/[0.06] pt-3 dark:border-ink-50/[0.06]">
        <span className="font-mono text-[10px] text-ink-400 dark:text-ink-500">
          {formatTokens(stats.totalTok)} tok all-time
        </span>
        <Spacer />
        <button
          type="button"
          onClick={onOpenShell}
          className="inline-flex items-center gap-1 h-6 px-2 rounded-md border border-ink-900/10 bg-paper-50 font-mono text-[10px] text-ink-700 hover:border-ink-900/25 hover:bg-paper-100 dark:border-ink-50/10 dark:bg-ink-900 dark:text-ink-200 dark:hover:bg-ink-700 transition-colors"
          title="open a tmux session at this project"
        >
          <TerminalSquare className="h-3 w-3" />
          shell
        </button>
        <span
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            // Seed the spawn sheet with this project, then fire the
            // global ⌘N shortcut to open it.
            void patchPrefs.mutateAsync({ lastProjectId: p.id });
            const ev = new KeyboardEvent("keydown", {
              key: "n",
              metaKey: true,
              bubbles: true,
            });
            document.dispatchEvent(ev);
          }}
          className="inline-flex items-center gap-1 h-6 px-2 rounded-md bg-ember-500 font-mono text-[10px] text-white hover:bg-ember-600 transition-colors cursor-pointer"
          title="spawn a task here"
        >
          <Plus className="h-3 w-3" />
          spawn
        </span>
      </div>
    </Link>
  );
}

function Stat({
  label,
  value,
  tone,
  icon: Icon,
  numeric = true,
}: {
  label: string;
  value: number | string;
  tone?: "ember" | "emerald" | "red";
  icon?: React.ComponentType<{ className?: string }>;
  numeric?: boolean;
}) {
  const text =
    tone === "emerald"
      ? "text-emerald-700 dark:text-emerald-300"
      : tone === "red"
        ? "text-red-700 dark:text-red-300"
        : tone === "ember"
          ? "text-ember-700 dark:text-ember-300"
          : "text-ink-900 dark:text-ink-50";
  return (
    <div>
      <div className="flex items-center gap-1 font-mono text-[10px] tabular-nums">
        {Icon && <Icon className={cn("h-2.5 w-2.5", text)} />}
        <span className={cn(numeric && "tabular-nums", "text-[14px] font-semibold", text)}>
          {value}
        </span>
      </div>
      <div className="font-mono text-[9px] uppercase tracking-[0.12em] text-ink-400 dark:text-ink-500">
        {label}
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: Task["status"] }) {
  const tone =
    status === "running"
      ? "bg-ember-500 animate-blink"
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
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <FolderGit2 className="h-7 w-7 text-ink-300 dark:text-ink-600" />
      <div className="text-[14px] font-medium text-ink-900 dark:text-ink-50">
        No projects yet
      </div>
      <p className="max-w-md text-[12px] text-ink-500 dark:text-ink-400 leading-relaxed">
        Projects auto-create when you spawn a task at a path, or you can
        register one ahead of time from the composer's project picker on the
        Home tab.
      </p>
      <Button size="sm" asChild>
        <Link to="/home">
          <Plus className="h-3.5 w-3.5" /> Spawn your first task
        </Link>
      </Button>
    </div>
  );
}

void Activity;
void Loader2;
void Circle;
