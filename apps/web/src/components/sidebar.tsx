import { useEffect, useMemo, useState } from "react";
import { Link, NavLink } from "react-router-dom";
import {
  Activity,
  BookText,
  CalendarClock,
  ChevronRight,
  FileTerminal,
  FolderGit2,
  Home,
  Inbox,
  Plug,
  Plus,
  Search,
  Settings as SettingsIcon,
  Smartphone,
  TerminalSquare,
  Wrench,
} from "lucide-react";
import type { Project, Task } from "@agentd/contracts";
import { cn, formatTs } from "@/lib/utils";
import { Wordmark } from "@/components/wordmark";
import { ServerCard } from "@/components/server-card";
import { ThemeToggle } from "@/components/theme-toggle";
import { Kbd } from "@/components/ui/kbd";
import {
  usePatchPrefs,
  usePrefs,
  useProjects,
  useSchedules,
  useTasks,
} from "@/queries";
import { usePluginsStatus } from "@/queries";
import { useRealtime } from "@/realtime";
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
      { to: "/tools", label: "Tools", icon: Wrench, kbd: "g w" },
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
        t.status === "waiting_perm",
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

      {/* Latest event ticker */}
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
              to={`/tasks/${latest.taskId}`}
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
  active: Task[];
  recent: Task[];
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
    // open: any task currently working
    const isActive = (t: Task): boolean =>
      t.status === "running" ||
      t.status === "waiting_input" ||
      t.status === "waiting_perm" ||
      t.status === "pending";
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
      const sorted = [...list].sort((a, b) => b.updatedAt - a.updatedAt);
      const active = sorted.filter(isActive);
      const recent = sorted.filter((t) => !isActive(t)).slice(0, 5);
      return { id, project: p, active, recent, total: list.length };
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
      if ((a.active.length > 0) !== (b.active.length > 0)) {
        return a.active.length > 0 ? -1 : 1;
      }
      return b.total - a.total;
    });
    return out;
  }, [tasks, projects]);

  const totalActive = groups.reduce((s, g) => s + g.active.length, 0);

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
            const open = openMap[g.id] ?? g.active.length > 0;
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
  const { project, active, recent } = group;
  const id = project?.id ?? group.id;
  const color = project ? colorForProject(project.id, project.color) : "#71717A";
  const name = project?.name ?? "Untracked";
  const total = group.total;
  const liveTasks = active.length;
  // Always populate so the collapse animation has content to shrink.
  // The wrapper grid track + opacity drives visibility.
  const visible = [...active, ...recent];

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
      {liveTasks > 0 && (
        <span className="h-1.5 w-1.5 rounded-full bg-ember-500 animate-blink shrink-0" />
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
          open && visible.length > 0
            ? "grid-rows-[1fr] opacity-100"
            : "grid-rows-[0fr] opacity-0",
        )}
        aria-hidden={!open}
      >
        <div className="min-h-0 overflow-hidden">
          <ul className="ml-3 mt-0.5 mb-1 space-y-0.5 border-l border-ink-900/[0.06] pl-2 dark:border-ink-50/[0.06]">
            {visible.map((t) => (
              <SidebarTaskRow key={t.id} task={t} />
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function SidebarTaskRow({ task: t }: { task: Task }) {
  const tone =
    t.status === "running"
      ? "text-ember-700 dark:text-ember-300"
      : t.status === "waiting_input" || t.status === "waiting_perm"
        ? "text-amber-700 dark:text-amber-300"
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
        : t.status === "done"
          ? "bg-emerald-500"
          : t.status === "failed"
            ? "bg-red-500"
            : "bg-ink-300 dark:bg-ink-600";
  return (
    <li>
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
          <span className="block truncate text-ink-900 dark:text-ink-50">
            {t.title}
          </span>
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
