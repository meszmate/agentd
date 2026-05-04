import { useEffect, useMemo, useState } from "react";
import { Link, NavLink } from "react-router-dom";
import {
  Activity,
  BookText,
  CalendarClock,
  ChevronRight,
  CircleDot,
  FileTerminal,
  FolderGit2,
  GitPullRequest,
  Home,
  Inbox,
  Plug,
  Plus,
  Search,
  Settings as SettingsIcon,
  Smartphone,
  TerminalSquare,
} from "lucide-react";
import type { Project, Task } from "@agentd/contracts";
import { cn, formatTs } from "@/lib/utils";
import { Wordmark } from "@/components/wordmark";
import { ServerCard } from "@/components/server-card";
import { ThemeToggle } from "@/components/theme-toggle";
import { Kbd } from "@/components/ui/kbd";
import { TaskGithubBadge } from "@/components/ui/task-github-badge";
import {
  usePatchPrefs,
  usePrefs,
  useProjects,
  useSchedules,
  useTasks,
} from "@/queries";
import { usePluginsStatus, useReorderTasks } from "@/queries";
import { useProjectPulse, useRealtime } from "@/realtime";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  closestCenter,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { useStore } from "@/store";

const SECTIONS: {
  heading: string;
  items: {
    to: string;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    kbd?: string;
  }[];
}[] = [
  {
    heading: "Primary",
    items: [
      { to: "/home", label: "Home", icon: Home, kbd: "g h" },
      { to: "/tasks", label: "Tasks", icon: Inbox, kbd: "g t" },
      { to: "/templates", label: "Templates", icon: FileTerminal, kbd: "g e" },
      { to: "/schedules", label: "Schedules", icon: CalendarClock, kbd: "g s" },
      { to: "/skills", label: "Skills", icon: BookText, kbd: "g k" },
      { to: "/terminal", label: "Terminal", icon: TerminalSquare, kbd: "g r" },
    ],
  },
  {
    heading: "Observe",
    items: [
      { to: "/activity", label: "Activity", icon: Activity, kbd: "g a" },
      { to: "/plugins", label: "Plugins", icon: Plug, kbd: "g p" },
    ],
  },
  {
    heading: "Account",
    items: [
      { to: "/devices", label: "Devices", icon: Smartphone, kbd: "g d" },
      {
        to: "/settings",
        label: "Settings",
        icon: SettingsIcon,
        kbd: "g ,",
      },
    ],
  },
];

export function Sidebar({
  onOpenPalette,
  onSpawn,
}: {
  onOpenPalette: () => void;
  onSpawn: () => void;
}) {
  const tasksQ = useTasks();
  const activeCount =
    tasksQ.data?.tasks.filter(
      (t) =>
        t.status === "running" ||
        t.status === "waiting_input" ||
        t.status === "waiting_perm" ||
        t.status === "idle",
    ).length ?? 0;

  return (
    <aside className="flex h-full w-60 flex-col border-r border-ink-900/10 bg-paper-50 dark:border-ink-50/10 dark:bg-ink-800">
      <div className="flex h-12 items-center px-5 border-b border-ink-900/10 dark:border-ink-50/10 shrink-0">
        <Wordmark />
      </div>

      <div className="px-3 pt-3 pb-2 shrink-0">
        <ServerCard />
      </div>

      <div className="px-3 pb-2 flex flex-col gap-1 shrink-0">
        <button
          onClick={onOpenPalette}
          className="flex h-7 items-center gap-2 rounded-md border border-ink-900/10 bg-paper-50 px-2.5 text-[11px] text-ink-500 transition-colors hover:bg-ink-900/[0.02] hover:text-ink-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-ember-500/30 dark:border-ink-50/10 dark:bg-ink-800 dark:text-ink-400 dark:hover:bg-ink-700 dark:hover:text-ink-200"
        >
          <Search className="h-3 w-3" />
          <span className="flex-1 text-left">Search</span>
          <Kbd className="h-4">⌘K</Kbd>
        </button>
        <button
          onClick={onSpawn}
          className="flex h-7 items-center gap-2 rounded-md bg-ink-900 px-2.5 text-[11px] font-medium text-white transition-colors hover:bg-ember-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-ember-500/40 dark:bg-ember-500 dark:hover:bg-ember-600"
        >
          <Plus className="h-3 w-3 text-white/80" />
          <span className="flex-1 text-left">New task</span>
          <Kbd className="h-4 border-white/20 bg-white/10 text-white/80">
            ⌘N
          </Kbd>
        </button>
      </div>

      <nav className="flex flex-col gap-3 overflow-y-auto py-2">
        <ProjectsTreeSection />
        {SECTIONS.map((sec) => (
          <div key={sec.heading}>
            <div className="px-5 mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-400 dark:text-ink-500 font-medium">
              {sec.heading}
            </div>
            <div className="flex flex-col px-2 gap-0.5">
              {sec.items.map((it) => {
                const Icon = it.icon;
                return (
                  <NavLink
                    key={it.to}
                    to={it.to}
                    end
                    className={({ isActive }) =>
                      cn(
                        "group h-7 flex items-center gap-2.5 rounded-md px-2.5 text-[12px] transition-colors duration-100",
                        isActive
                          ? "bg-ink-900/[0.05] text-ink-900 font-medium dark:bg-ink-50/[0.06] dark:text-ink-50"
                          : "text-ink-600 hover:bg-ink-900/[0.03] hover:text-ink-900 dark:text-ink-400 dark:hover:bg-ink-700 dark:hover:text-ink-50",
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        <Icon
                          className={cn(
                            "h-3.5 w-3.5 shrink-0 transition-colors",
                            isActive
                              ? "text-ember-500"
                              : "text-ink-400 group-hover:text-ink-600 dark:text-ink-500 dark:group-hover:text-ink-300",
                          )}
                        />
                        <span className="flex-1">{it.label}</span>
                        {it.to === "/tasks" && activeCount > 0 && (
                          <span className="font-mono text-[10px] tabular-nums text-ember-700 dark:text-ember-300">
                            {activeCount}
                          </span>
                        )}
                        {it.kbd && (
                          <Kbd className="h-4 hidden md:inline-flex opacity-0 group-hover:opacity-100 transition-opacity">
                            {it.kbd}
                          </Kbd>
                        )}
                      </>
                    )}
                  </NavLink>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* Live panel */}
      <LivePanel />

      {/* Footer */}
      <div className="border-t border-ink-900/10 px-4 py-2 dark:border-ink-50/10 shrink-0">
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-[10px] text-ink-400 dark:text-ink-500">
            v0.1
          </span>
          <ThemeToggle />
        </div>
      </div>
    </aside>
  );
}

function LivePanel() {
  const { status, latest } = useRealtime();
  const tasksQ = useTasks();
  const schedulesQ = useSchedules();
  const pluginsQ = usePluginsStatus();

  const tasks = tasksQ.data?.tasks ?? [];
  const running = tasks.filter((t) => t.status === "running");

  const nextFire = (() => {
    const items = schedulesQ.data?.schedules ?? [];
    const now = Date.now();
    const upcoming = items
      .filter((s) => s.enabled && s.nextRunAt && s.nextRunAt > now)
      .sort((a, b) => a.nextRunAt! - b.nextRunAt!);
    return upcoming[0] ?? null;
  })();

  // Tick every 30s so the relative-time on the next-fire stays fresh.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 30_000);
    return () => window.clearInterval(t);
  }, []);

  const tg = pluginsQ.data?.plugins.find((p) => p.name === "telegram");
  const dc = pluginsQ.data?.plugins.find((p) => p.name === "discord");

  return (
    <div className="mt-auto border-t border-ink-900/10 dark:border-ink-50/10 shrink-0">
      <div className="flex h-7 items-center gap-2 px-4">
        <span
          className={cn(
            "h-1.5 w-1.5 rounded-full",
            status === "live" && "live-dot",
            status === "connecting" && "bg-sky-500 animate-blink",
            status === "reconnecting" && "bg-amber-500 animate-blink",
          )}
          aria-label={status}
        />
        <span
          className={cn(
            "font-mono text-[10px] uppercase tracking-[0.14em] font-medium",
            status === "live" && "text-ember-700 dark:text-ember-300",
            status === "connecting" && "text-sky-700 dark:text-sky-300",
            status === "reconnecting" && "text-amber-700 dark:text-amber-300",
          )}
        >
          {status === "live"
            ? "live"
            : status === "connecting"
            ? "connecting…"
            : "reconnecting…"}
        </span>
        <span className="ml-auto font-mono text-[10px] tabular-nums text-ink-400 dark:text-ink-500">
          {running.length} running
        </span>
      </div>

      {/* Latest event ticker — task-scoped events link to /tasks/<id>;
          project-scoped events (brainstorm, plan-it) link to the
          project view instead. */}
      <div className="px-4 pb-1.5 h-6 flex items-center">
        {latest ? (
          <div
            key={latest.id}
            className="flex items-baseline gap-1.5 min-w-0 animate-ticker-in"
          >
            <span className="font-mono text-[10px] tabular-nums text-ink-400 dark:text-ink-500 shrink-0">
              {formatTs(latest.ts)}
            </span>
            <Link
              to={
                latest.projectSlug
                  ? `/projects/${latest.projectSlug}`
                  : `/tasks/${latest.taskId}`
              }
              className="text-[11px] text-ink-700 dark:text-ink-200 truncate hover:text-ember-600 dark:hover:text-ember-400 transition-colors min-w-0"
              title={`${latest.taskTitle} · ${latest.text}`}
            >
              <span className="font-medium">{latest.taskTitle}</span>
              <span className="text-ink-300 dark:text-ink-600 mx-1">·</span>
              <span className="text-ink-500 dark:text-ink-400">
                {latest.text}
              </span>
            </Link>
          </div>
        ) : (
          <span className="font-mono text-[10px] text-ink-400 dark:text-ink-500">
            no recent events
          </span>
        )}
      </div>

      {/* Bridges + schedule */}
      <div className="grid grid-cols-3 gap-px border-t border-ink-900/[0.06] bg-ink-900/[0.04] dark:border-ink-50/[0.06] dark:bg-ink-800">
        <BridgeBlock label="tg" running={!!tg?.running} enabled={!!tg?.enabled} error={tg?.lastError ?? null} />
        <BridgeBlock label="dc" running={!!dc?.running} enabled={!!dc?.enabled} error={dc?.lastError ?? null} />
        <NextFireBlock fire={nextFire} />
      </div>
    </div>
  );
}

function BridgeBlock({
  label,
  running,
  enabled,
  error,
}: {
  label: string;
  running: boolean;
  enabled: boolean;
  error: string | null;
}) {
  const tone = !enabled
    ? "text-ink-400 dark:text-ink-500"
    : running
    ? "text-emerald-700 dark:text-emerald-400"
    : "text-red-700 dark:text-red-400";
  const dot = !enabled
    ? "bg-ink-300 dark:bg-ink-600"
    : running
    ? "bg-emerald-500 animate-blink"
    : "bg-red-500 animate-blink";

  return (
    <div
      className="flex items-center gap-1.5 h-7 px-3 bg-paper-100 dark:bg-ink-800"
      title={
        !enabled
          ? `${label} disabled`
          : running
          ? `${label} connected`
          : `${label} stopped${error ? ` — ${error}` : ""}`
      }
    >
      <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", dot)} />
      <span className={cn("font-mono text-[10px] uppercase tracking-[0.12em]", tone)}>
        {label}
      </span>
    </div>
  );
}

function NextFireBlock({
  fire,
}: {
  fire: { id: string; name: string; nextRunAt: number | null } | null;
}) {
  if (!fire || !fire.nextRunAt) {
    return (
      <div className="flex items-center gap-1.5 h-7 px-3 bg-paper-100 dark:bg-ink-800">
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-400 dark:text-ink-500">
          no fires
        </span>
      </div>
    );
  }

  const ms = fire.nextRunAt - Date.now();
  const human =
    ms < 0
      ? "now"
      : ms < 60_000
      ? `${Math.floor(ms / 1000)}s`
      : ms < 3_600_000
      ? `${Math.floor(ms / 60_000)}m`
      : `${Math.floor(ms / 3_600_000)}h`;

  return (
    <Link
      to="/schedules"
      className="group flex items-center gap-1.5 h-7 px-3 bg-paper-100 hover:bg-paper-100 dark:bg-ink-800 dark:hover:bg-ink-900/60 transition-colors"
      title={`next: ${fire.name}`}
    >
      <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-400 dark:text-ink-500 shrink-0">
        in
      </span>
      <span className="font-mono text-[10px] tabular-nums text-ember-700 dark:text-ember-300 group-hover:text-ember-600">
        {human}
      </span>
    </Link>
  );
}

/* ── Projects tree (sidebar) ─────────────────────────────────────────
 *
 * One unified section: each project is a collapsible group; under it
 * we list its active tasks first, then a few recent ones. Tasks not
 * tied to any project bucket go under "Untracked".
 *
 * Realtime: derives off useTasks() + useProjects(), both invalidated
 * by the WS bus on any task_updated / status / exit event. So the dot
 * blinks, the count ticks up, the row order shuffles — all without
 * extra polling.
 */

const PROJECT_PALETTE = [
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

function colorForProject(id: string, override: string | null | undefined): string {
  if (override) return override;
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return PROJECT_PALETTE[Math.abs(hash) % PROJECT_PALETTE.length]!;
}


interface ProjectGroup {
  id: string;
  /** null for untracked — synthesizes a "Untracked" group. */
  project: Project | null;
  /** Merged list — sortOrder (drag) wins, then `updatedAt` desc.
   *  Done/failed tasks live in the same list as running ones so a
   *  finishing task doesn't leap into a separate section below. */
  tasks: Task[];
  /** Count of tasks currently mid-flight — drives the live dot
   *  + the per-project "N live" indicator. */
  liveCount: number;
  total: number;
}

function ProjectsTreeSection() {
  const tasksQ = useTasks();
  const projectsQ = useProjects();
  const tasks = tasksQ.data?.tasks ?? [];
  const projects = projectsQ.data?.projects ?? [];
  const unread = useStore((s) => s.unreadByProject);

  // Expanded project ids — server-stored so the same set syncs across
  // devices. The local state is the source of truth for the current
  // session and we patch back to the server in the toggle handler.
  const prefsQ = usePrefs();
  const patchPrefs = usePatchPrefs();
  const [openMap, setOpenMap] = useState<Record<string, boolean>>({});
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    if (hydrated) return;
    const ids = prefsQ.data?.prefs.sidebarExpandedProjects;
    if (!ids) return;
    const next: Record<string, boolean> = {};
    for (const id of ids) next[id] = true;
    setOpenMap(next);
    setHydrated(true);
  }, [prefsQ.data, hydrated]);
  const toggle = (key: string): void => {
    setOpenMap((cur) => {
      const next = { ...cur, [key]: !(cur[key] ?? false) };
      void patchPrefs.mutateAsync({
        sidebarExpandedProjects: Object.entries(next)
          .filter(([, v]) => v)
          .map(([k]) => k),
      });
      return next;
    });
  };

  const groups = useMemo<ProjectGroup[]>(() => {
    // open: any task currently working OR alive between turns
    const isActive = (t: Task): boolean =>
      t.status === "running" ||
      t.status === "waiting_input" ||
      t.status === "waiting_perm" ||
      t.status === "pending" ||
      t.status === "idle";
    const isClosed = (t: Task): boolean => !!t.closedAt;

    const byProject = new Map<string, Task[]>();
    const untracked: Task[] = [];
    for (const t of tasks) {
      if (isClosed(t)) continue;
      if (t.projectId) {
        const arr = byProject.get(t.projectId) ?? [];
        arr.push(t);
        byProject.set(t.projectId, arr);
      } else {
        untracked.push(t);
      }
    }

    const buildGroup = (id: string, p: Project | null, list: Task[]): ProjectGroup => {
      // One unified list. Drag-set `sortOrder` pins a task to a
      // chosen slot; everything else falls back to `updatedAt` desc
      // so the most-recently-touched task stays on top regardless of
      // status. Done tasks no longer migrate to a separate section
      // when they finish.
      const tasks = [...list].sort((a, b) => {
        const ao = a.sortOrder;
        const bo = b.sortOrder;
        if (ao != null && bo != null) return ao - bo;
        if (ao != null) return -1;
        if (bo != null) return 1;
        return b.updatedAt - a.updatedAt;
      });
      const liveCount = list.reduce((n, t) => (isActive(t) ? n + 1 : n), 0);
      return { id, project: p, tasks, liveCount, total: list.length };
    };

    const out: ProjectGroup[] = [];
    for (const p of projects) {
      const list = byProject.get(p.id) ?? [];
      out.push(buildGroup(p.id, p, list));
    }
    // Catch tasks whose projectId isn't in the projects list yet.
    for (const [pid, list] of byProject) {
      if (out.some((g) => g.id === pid)) continue;
      out.push(buildGroup(pid, null, list));
    }
    if (untracked.length > 0) {
      out.push(buildGroup("untracked", null, untracked));
    }
    // Sort: groups with active tasks first, then by total task count.
    out.sort((a, b) => {
      if ((a.liveCount > 0) !== (b.liveCount > 0)) {
        return a.liveCount > 0 ? -1 : 1;
      }
      return b.total - a.total;
    });
    return out;
  }, [tasks, projects]);

  const totalActive = groups.reduce((s, g) => s + g.liveCount, 0);

  return (
    <div>
      <div className="px-5 mb-1 flex items-center gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-400 dark:text-ink-500 font-medium">
          Projects
        </span>
        {totalActive > 0 && (
          <span className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.12em] text-ember-700 dark:text-ember-300">
            <span className="h-1 w-1 rounded-full bg-ember-500 animate-blink" />
            {totalActive} live
          </span>
        )}
        <span className="ml-auto font-mono text-[10px] tabular-nums text-ink-400 dark:text-ink-500">
          {projects.length}
        </span>
      </div>
      <div className="flex flex-col px-2 gap-0.5">
        {groups.length === 0 ? (
          <div className="px-2.5 py-1.5 text-[11px] text-ink-400 dark:text-ink-500 italic">
            spawn a task to start
          </div>
        ) : (
          groups.map((g) => {
            const open = openMap[g.id] ?? g.liveCount > 0;
            return (
              <ProjectGroupRow
                key={g.id}
                group={g}
                open={open}
                unread={g.project ? unread[g.project.id] ?? 0 : 0}
                onToggle={() => toggle(g.id)}
              />
            );
          })
        )}

        <NavLink
          to="/projects"
          end
          className={({ isActive }) =>
            cn(
              "group mt-1 h-7 flex items-center gap-2 rounded-md px-2.5 text-[11px] transition-colors duration-100",
              isActive
                ? "bg-ink-900/[0.05] text-ink-900 font-medium dark:bg-ink-50/[0.06] dark:text-ink-50"
                : "text-ink-500 hover:bg-ink-900/[0.03] hover:text-ink-900 dark:text-ink-400 dark:hover:bg-ink-50/[0.03] dark:hover:text-ink-50",
            )
          }
        >
          <FolderGit2 className="h-3 w-3 text-ink-400 dark:text-ink-500" />
          <span className="flex-1">All projects</span>
          <ChevronRight className="h-3 w-3 text-ink-400 dark:text-ink-500" />
        </NavLink>
      </div>
    </div>
  );
}

function ProjectGithubBadges({ project }: { project: Project | null }) {
  if (!project) return null;
  const issues = project.openIssueCount ?? 0;
  const prs = project.openPrCount ?? 0;
  if (issues === 0 && prs === 0) return null;
  return (
    <>
      {prs > 0 && (
        <span
          className="inline-flex items-center gap-0.5 font-mono text-[10px] tabular-nums text-emerald-700 dark:text-emerald-300 shrink-0"
          title={`${prs} open pull request${prs === 1 ? "" : "s"}`}
        >
          <GitPullRequest className="h-3 w-3" />
          {prs}
        </span>
      )}
      {issues > 0 && (
        <span
          className="inline-flex items-center gap-0.5 font-mono text-[10px] tabular-nums text-sky-700 dark:text-sky-300 shrink-0"
          title={`${issues} open issue${issues === 1 ? "" : "s"}`}
        >
          <CircleDot className="h-3 w-3" />
          {issues}
        </span>
      )}
    </>
  );
}

function ProjectGroupRow({
  group,
  open,
  unread,
  onToggle,
}: {
  group: ProjectGroup;
  open: boolean;
  unread: number;
  onToggle: () => void;
}) {
  const { project, tasks } = group;
  const id = project?.id ?? group.id;
  const color = project ? colorForProject(project.id, project.color) : "#71717A";
  const name = project?.name ?? "Untracked";
  const total = group.total;
  const liveTasks = group.liveCount;
  // Brainstorm / plan-it events flash the same ember dot used for
  // live tasks — single visual cue covers both kinds of activity.
  const brainstormHot = useProjectPulse(project?.id);
  // Always populate so the collapse animation has content to shrink.
  // The wrapper grid track + opacity drives visibility.
  const visible = tasks.length;

  // One integrated row: clicking the chevron area toggles, clicking
  // the rest navigates to the project (or just toggles for untracked).
  // The chevron is part of the same surface so it doesn't read as a
  // separate UI control.
  void id;

  const Inner = (
    <>
      <ChevronRight
        className={cn(
          "h-3 w-3 shrink-0 text-ink-400 dark:text-ink-500 transition-transform duration-200",
          open && "rotate-90",
        )}
      />
      <span
        className="size-2 rounded-sm shrink-0"
        style={{ background: color }}
      />
      <span className={cn("flex-1 truncate", !project && "italic")}>{name}</span>
      {(liveTasks > 0 || brainstormHot) && (
        <span
          className={cn(
            "h-1.5 w-1.5 rounded-full shrink-0",
            brainstormHot && liveTasks === 0
              ? "bg-amber-500 animate-blink"
              : "bg-ember-500 animate-blink",
          )}
          title={
            liveTasks > 0
              ? `${liveTasks} live task${liveTasks === 1 ? "" : "s"}`
              : "brainstorm activity"
          }
        />
      )}
      {unread > 0 && (
        <span className="font-mono text-[10px] tabular-nums text-ember-700 dark:text-ember-300 shrink-0">
          +{unread}
        </span>
      )}
      <span className="font-mono text-[10px] tabular-nums text-ink-400 dark:text-ink-500 shrink-0">
        {total}
      </span>
    </>
  );

  return (
    <div>
      {project ? (
        <NavLink
          to={`/projects/${project.slug}`}
          end
          // Alt-click (or click on the chevron-icon area) toggles expand;
          // plain click navigates. Chevron's mousedown handler stops
          // navigation when it fires, so users can fold/unfold without
          // leaving the page.
          className={({ isActive }) =>
            cn(
              "group h-7 flex items-center gap-2 rounded-md px-2 text-[12px] transition-colors duration-100 min-w-0",
              isActive
                ? "bg-ink-900/[0.05] text-ink-900 font-medium dark:bg-ink-50/[0.06] dark:text-ink-50"
                : "text-ink-700 hover:bg-ink-900/[0.03] hover:text-ink-900 dark:text-ink-200 dark:hover:bg-ink-700 dark:hover:text-ink-50",
            )
          }
          onClick={(e) => {
            // Click on the chevron icon → toggle, don't navigate.
            const target = e.target as HTMLElement;
            if (target.closest("[data-chevron]")) {
              e.preventDefault();
              onToggle();
            }
          }}
        >
          <span
            data-chevron
            role="button"
            aria-label={open ? "collapse" : "expand"}
            className="grid place-items-center -ml-0.5"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onToggle();
            }}
          >
            <ChevronRight
              className={cn(
                "h-3 w-3 shrink-0 text-ink-400 dark:text-ink-500 transition-transform duration-200",
                open && "rotate-90",
              )}
            />
          </span>
          <span
            className="size-2 rounded-sm shrink-0"
            style={{ background: color }}
          />
          <span className="flex-1 truncate">{name}</span>
          {liveTasks > 0 && (
            <span className="h-1.5 w-1.5 rounded-full bg-ember-500 animate-blink shrink-0" />
          )}
          {unread > 0 && (
            <span className="font-mono text-[10px] tabular-nums text-ember-700 dark:text-ember-300 shrink-0">
              +{unread}
            </span>
          )}
          <ProjectGithubBadges project={project} />
          <span className="font-mono text-[10px] tabular-nums text-ink-400 dark:text-ink-500 shrink-0">
            {total}
          </span>
        </NavLink>
      ) : (
        <button
          type="button"
          onClick={onToggle}
          className="group w-full h-7 flex items-center gap-2 rounded-md px-2 text-[12px] text-ink-500 hover:bg-ink-900/[0.03] hover:text-ink-900 dark:text-ink-400 dark:hover:bg-ink-700 dark:hover:text-ink-50 transition-colors min-w-0"
        >
          {Inner}
        </button>
      )}

      {/* Smooth expand/collapse via grid-template-rows: animating from
          0fr → 1fr lets the row's natural content height drive the
          transition without measuring it in JS. The inner min-h-0
          + overflow-hidden lets the children clip cleanly while the
          row's track collapses. */}
      <div
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-200 ease-out",
          open && visible > 0
            ? "grid-rows-[1fr] opacity-100"
            : "grid-rows-[0fr] opacity-0",
        )}
        aria-hidden={!open}
      >
        <div className="min-h-0 overflow-hidden">
          <SidebarTaskList tasks={tasks} />
        </div>
      </div>
    </div>
  );
}

function SidebarTaskList({ tasks }: { tasks: Task[] }) {
  // FLIP-animate row reorder (auto-animate) + @dnd-kit so the
  // operator can drag any task — running or done — to a new
  // slot. One unified list, sorted by drag-set sortOrder then
  // updatedAt.
  const [ref] = useAutoAnimate<HTMLUListElement>({
    duration: 380,
    easing: "cubic-bezier(0.16, 1, 0.3, 1)",
  });
  const sensors = useSensors(
    // 6px activation distance keeps clicks-to-navigate intact —
    // dragging requires a deliberate pointer move first.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );
  const reorder = useReorderTasks();
  const [orderOverride, setOrderOverride] = useState<string[] | null>(null);
  // Live ordering is the override (if a drag just happened) else
  // the server-supplied order; rebuild from `tasks` whenever the
  // server confirms.
  const liveTasks = orderOverride
    ? orderOverride
        .map((id) => tasks.find((t) => t.id === id))
        .filter((t): t is Task => !!t)
    : tasks;

  const onDragEnd = (e: DragEndEvent) => {
    const { active: dragged, over } = e;
    if (!over || dragged.id === over.id) return;
    const ids = liveTasks.map((t) => t.id);
    const fromIdx = ids.indexOf(String(dragged.id));
    const toIdx = ids.indexOf(String(over.id));
    if (fromIdx < 0 || toIdx < 0) return;
    const next = arrayMove(ids, fromIdx, toIdx);
    setOrderOverride(next);
    reorder.mutate(next, {
      onSettled: () => setOrderOverride(null),
    });
  };

  // Group consecutive sidebar rows that share a `planGroupId` so the
  // operator visually sees plan-slice siblings as one cluster (shared
  // worktree / branch). Tasks without a group render solo. Drag-
  // ordering still works because cluster siblings sit adjacent in
  // the input list — moving the cluster's anchor moves the whole
  // group together. Main folded active + recent into a single
  // `tasks` list, so we cluster that one list.
  const grouped = clusterByPlanGroup(liveTasks);

  return (
    <ul
      ref={ref}
      className="ml-3 mt-0.5 mb-1 space-y-0.5 border-l border-ink-900/[0.06] pl-2 dark:border-ink-50/[0.06]"
    >
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={onDragEnd}
      >
        <SortableContext
          items={liveTasks.map((t) => t.id)}
          strategy={verticalListSortingStrategy}
        >
          {grouped.map((cluster) =>
            cluster.tasks.length > 1 ? (
              <SliceCluster
                key={cluster.key}
                tasks={cluster.tasks}
                rowFor={(t, i) => (
                  <SortableSidebarTaskRow
                    key={t.id}
                    task={t}
                    sliceIndex={i + 1}
                    sliceTotal={cluster.tasks.length}
                  />
                )}
              />
            ) : (
              <SortableSidebarTaskRow
                key={cluster.tasks[0]!.id}
                task={cluster.tasks[0]!}
              />
            ),
          )}
        </SortableContext>
      </DndContext>
    </ul>
  );
}

/**
 * Group consecutive tasks by `planGroupId` so plan-slice siblings sit
 * together. Preserves input ordering — tasks with NULL group key
 * always render solo (one cluster of size 1 each). Tasks with the
 * same group key may appear in non-adjacent positions in the input,
 * so we do an in-order single-pass cluster: when we see a group key
 * we've seen before, push the task onto its existing cluster instead
 * of starting a new one.
 */
function clusterByPlanGroup(
  tasks: Task[],
): Array<{ key: string; tasks: Task[] }> {
  const out: Array<{ key: string; tasks: Task[] }> = [];
  const groupIdx = new Map<string, number>();
  for (const t of tasks) {
    const g = t.planGroupId;
    if (!g) {
      out.push({ key: `solo:${t.id}`, tasks: [t] });
      continue;
    }
    const idx = groupIdx.get(g);
    if (idx == null) {
      groupIdx.set(g, out.length);
      out.push({ key: g, tasks: [t] });
    } else {
      out[idx]!.tasks.push(t);
    }
  }
  return out;
}

/**
 * Visual cluster wrapper for plan-slice siblings — adds an ember left
 * spine so the group reads as one chunk in the sidebar. Each task
 * row renders normally inside, with a small `1/N` chip surfaced via
 * the `sliceIndex` / `sliceTotal` props.
 */
function SliceCluster({
  tasks,
  rowFor,
}: {
  tasks: Task[];
  rowFor: (t: Task, index: number) => React.ReactNode;
}) {
  return (
    <li className="-ml-2 pl-2 rounded-r border-l-2 border-ember-500/30 bg-ember-500/[0.025]">
      <ul className="space-y-0.5">
        {tasks.map((t, i) => (
          <li key={t.id}>{rowFor(t, i)}</li>
        ))}
      </ul>
    </li>
  );
}

function SortableSidebarTaskRow({
  task,
  sliceIndex,
  sliceTotal,
}: {
  task: Task;
  sliceIndex?: number;
  sliceTotal?: number;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id });
  const style: React.CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition,
    zIndex: isDragging ? 10 : undefined,
  };
  return (
    <SidebarTaskRow
      task={task}
      dragRef={setNodeRef}
      dragStyle={style}
      dragHandleProps={{ ...attributes, ...listeners }}
      isDragging={isDragging}
      sliceIndex={sliceIndex}
      sliceTotal={sliceTotal}
    />
  );
}

function SidebarTaskRow({
  task: t,
  dragRef,
  dragStyle,
  dragHandleProps,
  isDragging,
  sliceIndex,
  sliceTotal,
}: {
  task: Task;
  dragRef?: (el: HTMLElement | null) => void;
  dragStyle?: React.CSSProperties;
  dragHandleProps?: React.HTMLAttributes<HTMLButtonElement>;
  isDragging?: boolean;
  /** 1-based position within a sibling cluster — only set when the
   *  cluster has 2+ tasks. */
  sliceIndex?: number;
  sliceTotal?: number;
}) {
  const { latestByTask } = useRealtime();
  const liveEvent = latestByTask[t.id];
  // Compose the "currently doing" subtitle from the most recent
  // meaningful event for this task. Skip showing it when the task
  // is closed / done / failed since there's no work in flight.
  const showLive =
    liveEvent &&
    (t.status === "running" ||
      t.status === "waiting_input" ||
      t.status === "waiting_perm" ||
      t.status === "idle");
  const tone =
    t.status === "running"
      ? "text-ember-700 dark:text-ember-300"
      : t.status === "waiting_input" || t.status === "waiting_perm"
        ? "text-amber-700 dark:text-amber-300"
        : t.status === "idle"
          ? "text-ink-500 dark:text-ink-400"
          : t.status === "done"
            ? "text-emerald-700 dark:text-emerald-300"
            : t.status === "failed"
              ? "text-red-700 dark:text-red-300"
              : "text-ink-400 dark:text-ink-500";
  const dot =
    t.status === "running"
      ? "bg-ember-500 animate-blink"
      : t.status === "waiting_input" || t.status === "waiting_perm"
        ? "bg-amber-500 animate-blink"
        : t.status === "idle"
          ? "bg-ink-300 dark:bg-ink-600"
          : t.status === "done"
            ? "bg-emerald-500"
            : t.status === "failed"
              ? "bg-red-500"
              : "bg-ink-300 dark:bg-ink-600";
  return (
    <li
      ref={dragRef as ((el: HTMLLIElement | null) => void) | undefined}
      style={dragStyle}
      className={cn(
        "group/row relative",
        isDragging && "opacity-60",
      )}
    >
      {dragHandleProps && (
        <button
          type="button"
          {...dragHandleProps}
          className="absolute -left-3 top-1.5 grid place-items-center size-4 rounded text-ink-300 hover:text-ink-700 dark:text-ink-600 dark:hover:text-ink-200 opacity-0 group-hover/row:opacity-100 transition-opacity cursor-grab active:cursor-grabbing"
          title="Drag to reorder"
          aria-label="Drag handle"
        >
          <GripVertical className="h-3 w-3" />
        </button>
      )}
      <NavLink
        to={`/tasks/${t.id}`}
        end
        className={({ isActive }) =>
          cn(
            "group flex items-start gap-1.5 rounded-md px-1.5 py-1 text-[11.5px] transition-colors duration-100",
            isActive
              ? "bg-ink-900/[0.05] dark:bg-ink-50/[0.06]"
              : "hover:bg-ink-900/[0.03] dark:hover:bg-ink-700",
          )
        }
      >
        <span className={cn("h-1.5 w-1.5 rounded-full mt-1.5 shrink-0", dot)} />
        <span className="flex-1 min-w-0">
          <span className="flex items-center gap-1 min-w-0 text-ink-900 dark:text-ink-50">
            {sliceIndex != null && sliceTotal != null && (
              <span className="shrink-0 inline-flex items-center align-middle h-3.5 px-1 rounded font-mono text-[8.5px] font-semibold tabular-nums text-ember-700 bg-ember-500/10 ring-1 ring-ember-500/20 dark:text-ember-300">
                {sliceIndex}/{sliceTotal}
              </span>
            )}
            <TaskGithubBadge task={t} size="xs" />
            <span className="truncate">{t.title}</span>
          </span>
          {showLive && liveEvent && (
            <span
              key={liveEvent.id}
              className="mt-0.5 block truncate text-[10px] animate-fade-in"
              title={liveEvent.text}
            >
              <SidebarLiveText
                kind={liveEvent.kind}
                animate={t.status === "running"}
              >
                {liveEvent.text}
              </SidebarLiveText>
            </span>
          )}
          <span className="mt-0.5 flex items-center gap-1.5 font-mono text-[9px]">
            <span className={cn("uppercase tracking-[0.12em]", tone)}>
              {t.status === "running"
                ? "running"
                : t.status === "waiting_input"
                  ? "needs you"
                  : t.status === "waiting_perm"
                    ? "needs ok"
                    : t.status === "pending"
                      ? "queued"
                      : t.status === "idle"
                        ? "ready"
                        : t.status}
            </span>
            <span className="text-ink-400 dark:text-ink-500">·</span>
            <span className="text-ink-400 dark:text-ink-500">{t.agent}</span>
            <span className="ml-auto text-ink-400 dark:text-ink-500">
              {formatTs(t.updatedAt)}
            </span>
          </span>
        </span>
      </NavLink>
    </li>
  );
}

/**
 * Live-activity text for a sidebar task row. When the task is
 * actively running we apply the same gradient shimmer that the
 * task-detail "agent is thinking" line uses — same alive feel.
 * Static fall-through (idle / waiting) just colors the text.
 */
function SidebarLiveText({
  kind,
  animate,
  children,
}: {
  kind: string;
  animate: boolean;
  children: React.ReactNode;
}) {
  // Per-event-kind tone tokens. Each is a light-mode + dark-mode
  // pair of CSS color values used both for the static color and
  // for the shimmer gradient stops.
  const tokens =
    kind === "tool_call"
      ? {
          flat: "text-sky-700 dark:text-sky-300",
          gradLight:
            "bg-[linear-gradient(90deg,rgba(3,105,161,0.4),rgba(3,105,161,1),rgba(3,105,161,0.4))]",
          gradDark:
            "dark:bg-[linear-gradient(90deg,rgba(125,211,252,0.4),rgba(125,211,252,1),rgba(125,211,252,0.4))]",
        }
      : kind === "progress" || kind === "share"
        ? {
            flat: "text-violet-700 dark:text-violet-300",
            gradLight:
              "bg-[linear-gradient(90deg,rgba(109,40,217,0.4),rgba(109,40,217,1),rgba(109,40,217,0.4))]",
            gradDark:
              "dark:bg-[linear-gradient(90deg,rgba(196,181,253,0.4),rgba(196,181,253,1),rgba(196,181,253,0.4))]",
          }
        : kind === "ask"
          ? {
              flat: "text-amber-700 dark:text-amber-300",
              gradLight:
                "bg-[linear-gradient(90deg,rgba(180,83,9,0.4),rgba(180,83,9,1),rgba(180,83,9,0.4))]",
              gradDark:
                "dark:bg-[linear-gradient(90deg,rgba(252,211,77,0.4),rgba(252,211,77,1),rgba(252,211,77,0.4))]",
            }
          : {
              flat: "text-ink-500 dark:text-ink-400",
              gradLight: "",
              gradDark: "",
            };

  if (!animate || !tokens.gradLight) {
    return <span className={tokens.flat}>{children}</span>;
  }
  return (
    <span
      className={cn(
        "bg-clip-text text-transparent bg-[length:200%_100%] animate-shimmer",
        tokens.gradLight,
        tokens.gradDark,
      )}
    >
      {children}
    </span>
  );
}
