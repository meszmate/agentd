import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ArrowLeft,
  FolderGit2,
  Plus,
} from "lucide-react";
import type { Task, TaskStatus } from "@agentd/contracts";
import {
  Count,
  Kicker,
  PageTopbar,
  Spacer,
  VRule,
} from "@/components/ui/page-topbar";
import { SectionHeader } from "@/components/ui/section-header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useProject, useSkills, useTasks } from "@/queries";
import { useStore } from "@/store";
import { BookText, FileText } from "lucide-react";
import {
  cn,
  formatCost,
  formatTokens,
  formatTs,
} from "@/lib/utils";
import { useRecentPulse } from "@/realtime";

const ACTIVE_STATUSES: TaskStatus[] = [
  "running",
  "waiting_input",
  "waiting_perm",
  "pending",
];

export function ProjectDetail() {
  const { slug } = useParams<{ slug: string }>();
  const projectQ = useProject(slug);
  const tasksQ = useTasks();
  const setCurrentProjectId = useStore((s) => s.setCurrentProjectId);
  const clearUnread = useStore((s) => s.clearUnread);

  const project = projectQ.data?.project ?? null;

  useEffect(() => {
    if (project) {
      setCurrentProjectId(project.id);
      clearUnread(project.id);
    }
    return () => setCurrentProjectId(null);
  }, [project, setCurrentProjectId, clearUnread]);

  const tasksForProject = useMemo(() => {
    const all = tasksQ.data?.tasks ?? [];
    if (!project) return [];
    return all.filter(
      (t) => t.projectId === project.id || t.repoPath === project.path,
    );
  }, [tasksQ.data, project]);

  const lanes = useMemo(() => {
    const now = Date.now();
    const dayAgo = now - 24 * 60 * 60 * 1000;
    const active: Task[] = [];
    const recent: Task[] = [];
    const archive: Task[] = [];
    for (const t of tasksForProject) {
      if (ACTIVE_STATUSES.includes(t.status)) active.push(t);
      else if (t.updatedAt >= dayAgo) recent.push(t);
      else archive.push(t);
    }
    return { active, recent, archive };
  }, [tasksForProject]);

  if (projectQ.isLoading || !project) {
    return (
      <div className="flex h-full flex-col">
        <PageTopbar>
          <Link
            to="/projects"
            className="text-[11px] text-ink-400 hover:text-ink-900 transition-colors dark:hover:text-ink-50"
          >
            ← Projects
          </Link>
          <VRule />
          <Skeleton className="h-3.5 w-32" />
        </PageTopbar>
        <div className="px-5 py-6 space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PageTopbar>
        <Link
          to="/projects"
          className="inline-flex items-center gap-1 text-[11px] text-ink-400 hover:text-ink-900 transition-colors dark:hover:text-ink-50"
        >
          <ArrowLeft className="h-3 w-3" />
          Projects
        </Link>
        <VRule />
        <span
          className="size-3 rounded-md shrink-0"
          style={{ background: project.color || "#DC2626" }}
        />
        <span className="text-[13px] text-ink-900 dark:text-ink-50 font-medium truncate">
          {project.name}
        </span>
        <Count>{tasksForProject.length}</Count>
        {lanes.active.length > 0 && (
          <>
            <span className="text-ink-300 dark:text-ink-600">·</span>
            <span className="font-mono text-[11px] tabular-nums text-ember-700 dark:text-ember-300">
              {lanes.active.length} active
            </span>
          </>
        )}
        <Spacer />
        <span className="hidden md:inline font-mono text-[10px] text-ink-400 dark:text-ink-500 truncate max-w-[36ch]">
          {project.path}
        </span>
      </PageTopbar>

      {/* Sub-strip with path + actions */}
      <div className="flex h-9 items-center gap-3 px-5 border-b border-ink-900/[0.06] dark:border-ink-50/[0.06] bg-paper-50 dark:bg-ink-900 shrink-0">
        <FolderGit2 className="h-3 w-3 text-ink-400 shrink-0" />
        <code className="font-mono text-[11px] text-ink-700 dark:text-ink-200 truncate flex-1">
          {project.path}
        </code>
        <span className="font-mono text-[10px] text-ink-400 dark:text-ink-500">
          last active {formatTs(project.lastActiveAt)}
        </span>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <AutoContextPanel projectPath={project.path} />
        {tasksForProject.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <FolderGit2 className="h-7 w-7 text-ink-300 dark:text-ink-600" />
            <div className="text-[13px] text-ink-700 dark:text-ink-200 font-medium">
              No tasks in this project yet
            </div>
            <p className="max-w-sm text-[12px] text-ink-500 dark:text-ink-400">
              Spawn one — the path is pre-filled to{" "}
              <span className="font-mono">{project.path}</span>.
            </p>
            <SpawnLauncher projectPath={project.path} />
          </div>
        ) : (
          <>
            {lanes.active.length > 0 && (
              <Lane heading="Active" tasks={lanes.active} accent />
            )}
            {lanes.recent.length > 0 && (
              <Lane heading="Recent" hint="last 24 hours" tasks={lanes.recent} />
            )}
            {lanes.archive.length > 0 && (
              <Lane heading="Archive" tasks={lanes.archive} muted />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function SpawnLauncher({ projectPath }: { projectPath: string }) {
  // Pre-warm the spawn sheet by writing the path into localStorage; the
  // SpawnSheet reads agentd.lastRepo on open. We trigger a fake button —
  // the global ⌘N shortcut + sidebar new-task open the sheet.
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      className="mt-2"
      onClick={() => {
        localStorage.setItem("agentd.lastRepo", projectPath);
        setDone(true);
        const event = new KeyboardEvent("keydown", {
          key: "n",
          metaKey: true,
          bubbles: true,
        });
        document.dispatchEvent(event);
      }}
      disabled={done}
    >
      <Plus className="h-3.5 w-3.5" />
      New task here
    </Button>
  );
}

function Lane({
  heading,
  hint,
  tasks,
  accent,
  muted,
}: {
  heading: string;
  hint?: string;
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
                ? "text-ember-700 dark:text-ember-300"
                : "text-ink-400 dark:text-ink-500",
            )}
          >
            {tasks.length}
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
  const hot = useRecentPulse(task.id, 1500);
  return (
    <li>
      <Link
        to={`/tasks/${task.id}`}
        className={cn(
          "group h-12 px-5 flex items-center gap-3 hover:bg-paper-100 transition-colors dark:hover:bg-ink-700 relative",
          hot && "bg-ember-500/[0.06] dark:bg-ember-500/[0.1]",
        )}
      >
        {hot && (
          <span
            aria-hidden
            className="absolute inset-y-0 left-0 w-0.5 bg-ember-500 animate-blink"
          />
        )}
        <StatusDot status={task.status} />
        <span className="text-[13px] font-medium text-ink-900 dark:text-ink-50 truncate flex-1">
          {task.title}
        </span>
        <span className="font-mono text-[10px] text-ink-400 dark:text-ink-500 shrink-0">
          {task.agent}
        </span>
        <span className="font-mono text-[11px] text-ink-500 dark:text-ink-400 truncate hidden md:inline max-w-[24ch]">
          {task.branch}
        </span>
        <span className="hidden md:flex items-baseline gap-3 shrink-0 font-mono text-[11px] tabular-nums text-ink-400 dark:text-ink-500">
          <span>{formatTokens(totalTok)}</span>
          <span>{formatCost(task.totalCostUsd)}</span>
        </span>
        <span className="font-mono text-[10px] tabular-nums text-ink-300 dark:text-ink-600 w-14 text-right shrink-0">
          {formatTs(task.updatedAt)}
        </span>
      </Link>
    </li>
  );
}

function StatusDot({ status }: { status: TaskStatus }) {
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

function AutoContextPanel({ projectPath }: { projectPath: string }) {
  const skillsQ = useSkills(projectPath);
  const localSkills = (skillsQ.data?.skills ?? []).filter(
    (s) => s.scope === "local",
  );
  if (localSkills.length === 0) return null;
  return (
    <section className="border-b border-ink-900/[0.06] dark:border-ink-50/[0.06] bg-ember-500/[0.04] dark:bg-ember-500/[0.06]">
      <div className="px-5 py-3 flex items-start gap-3">
        <FileText className="h-3.5 w-3.5 text-ember-500 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ember-700 dark:text-ember-300 font-medium">
              Auto context
            </span>
            <span className="text-[11px] text-ink-700 dark:text-ink-200">
              {localSkills.length} local skill{localSkills.length === 1 ? "" : "s"} pre-selected on every spawn
            </span>
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {localSkills.map((s) => (
              <span
                key={`${s.scope}:${s.slug}`}
                className="inline-flex items-center gap-1.5 h-5 px-1.5 rounded font-mono text-[10px] uppercase tracking-[0.06em] border border-ember-500/30 bg-ember-500/10 text-ember-700 dark:text-ember-300"
                title={s.description ?? s.name}
              >
                <BookText className="h-2.5 w-2.5" />
                {s.displayName ?? s.name}
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
