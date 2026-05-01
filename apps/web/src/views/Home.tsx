import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ArrowUpRight,
  ChevronDown,
  CornerDownLeft,
  Loader2,
  Rocket,
  Sparkles,
} from "lucide-react";
import type {
  AgentEvent,
  PermissionMode,
  Project,
  Task,
  WsServerEvent,
} from "@agentd/contracts";
import {
  Kicker,
  PageTopbar,
  Spacer,
  VRule,
} from "@/components/ui/page-topbar";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ProjectPicker } from "@/components/project-picker";
import {
  WorkspaceSetup,
  defaultWorkspaceSetup,
  type WorkspaceSetupValue,
} from "@/components/workspace-setup";
import { useApp, useClient } from "@/AppContext";
import {
  useCreateTask,
  usePatchPrefs,
  usePrefs,
  useProjects,
  useSchedules,
  useTasks,
} from "@/queries";
import {
  cn,
  formatCost,
  formatTokens,
  formatTs,
  shortId,
} from "@/lib/utils";


interface ActivityEntry {
  id: string;
  taskId: string;
  taskTitle: string;
  text: string;
  kind: AgentEvent["kind"];
  ts: number;
}

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Late night";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

export function Home() {
  const tasksQ = useTasks();
  const schedulesQ = useSchedules();
  const projectsQ = useProjects();

  const tasks = tasksQ.data?.tasks ?? [];
  const projects = projectsQ.data?.projects ?? [];
  const todayMs = startOfToday();

  const stats = useMemo(() => {
    const todayTasks = tasks.filter((t) => t.createdAt >= todayMs);
    const active = tasks.filter(
      (t) =>
        t.status === "running" ||
        t.status === "waiting_input" ||
        t.status === "waiting_perm",
    );
    const todaysSpend = todayTasks.reduce(
      (s, t) => s + (t.totalCostUsd ?? 0),
      0,
    );
    const totalSpend = tasks.reduce(
      (s, t) => s + (t.totalCostUsd ?? 0),
      0,
    );
    const totalTok = tasks.reduce(
      (s, t) =>
        s + (t.totalInputTokens ?? 0) + (t.totalOutputTokens ?? 0),
      0,
    );
    return {
      todayCount: todayTasks.length,
      activeCount: active.length,
      activeTasks: active,
      todaysSpend,
      totalSpend,
      totalTok,
    };
  }, [tasks, todayMs]);

  const recentDone = useMemo(
    () =>
      tasks
        .filter(
          (t) =>
            t.status === "done" ||
            t.status === "failed" ||
            t.status === "stopped",
        )
        .slice(0, 8),
    [tasks],
  );

  const upcoming = useMemo(() => {
    const items = schedulesQ.data?.schedules ?? [];
    const now = Date.now();
    const soon = now + 24 * 60 * 60 * 1000;
    return items
      .filter((s) => s.enabled && s.nextRunAt && s.nextRunAt <= soon)
      .sort((a, b) => a.nextRunAt! - b.nextRunAt!)
      .slice(0, 4);
  }, [schedulesQ.data]);

  const isFirstRun =
    !tasksQ.isLoading && tasks.length === 0 && projects.length === 0;

  return (
    <div className="flex h-full flex-col">
      <PageTopbar>
        <Kicker>workspace</Kicker>
        <VRule />
        <span className="text-[13px] text-ink-900 dark:text-ink-50">
          {greeting()}
          {stats.activeCount > 0 ? (
            <>
              {". "}
              <span className="text-ember-700 dark:text-ember-300 font-medium">
                {stats.activeCount}{" "}
                {stats.activeCount === 1 ? "agent" : "agents"} working.
              </span>
            </>
          ) : (
            <span className="text-ink-500 dark:text-ink-400">
              {". What should we build?"}
            </span>
          )}
        </span>
        <Spacer />
        {!isFirstRun && (
          <div className="hidden md:flex items-center gap-3 font-mono text-[10px] text-ink-500 dark:text-ink-400">
            <span title="cost today">
              today{" "}
              <span className="text-ink-900 dark:text-ink-50 num">
                {formatCost(stats.todaysSpend)}
              </span>
            </span>
            <span className="text-ink-300 dark:text-ink-600">·</span>
            <span title="all-time spend">
              total{" "}
              <span className="text-ink-900 dark:text-ink-50 num">
                {formatCost(stats.totalSpend)}
              </span>
            </span>
            <span className="text-ink-300 dark:text-ink-600">·</span>
            <span title="all-time tokens">
              <span className="text-ink-900 dark:text-ink-50 num">
                {formatTokens(stats.totalTok)}
              </span>{" "}
              tok
            </span>
          </div>
        )}
      </PageTopbar>

      {/* Two-column body — composer + lanes on the left, secondary feeds on the right */}
      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section className="overflow-y-auto px-6 pt-6 pb-12 space-y-6 min-w-0 border-r border-ink-900/[0.06] dark:border-ink-50/[0.06]">
          <Composer firstRun={isFirstRun} />

          {stats.activeTasks.length > 0 && (
            <Lane
              kicker="live"
              title={`${stats.activeTasks.length} running`}
              accent
            >
              <ul className="rounded-md border border-ember-500/30 bg-ember-500/[0.04] dark:bg-ember-500/[0.06] divide-y divide-ember-500/15 overflow-hidden">
                {stats.activeTasks.map((t) => (
                  <RunningRow key={t.id} task={t} />
                ))}
              </ul>
            </Lane>
          )}

          {recentDone.length > 0 && (
            <Lane
              kicker="recent"
              title="completed"
              trailing={
                <Link
                  to="/tasks"
                  className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-500 hover:text-ember-700 dark:text-ink-400 dark:hover:text-ember-300"
                >
                  all →
                </Link>
              }
            >
              <ul className="rounded-md border border-ink-900/10 bg-paper-50 divide-y divide-ink-900/[0.06] overflow-hidden dark:border-ink-50/10 dark:bg-ink-800 dark:divide-ink-50/[0.06]">
                {recentDone.map((t) => (
                  <DoneRow key={t.id} task={t} />
                ))}
              </ul>
            </Lane>
          )}

          {isFirstRun && <FirstRunHints />}
        </section>

        {/* Right rail: live activity + projects + upcoming */}
        <aside className="hidden lg:flex flex-col overflow-y-auto bg-paper-100/40 dark:bg-ink-900/30">
          <RailSection title="Activity" right={<LiveDot />} sticky>
            <ActivityTicker tasks={tasks} />
          </RailSection>

          <RailSection title="Projects" right={<span className="font-mono text-[10px] tabular-nums text-ink-400 dark:text-ink-500">{projects.length}</span>}>
            <ProjectsRail projects={projects} />
          </RailSection>

          {upcoming.length > 0 && (
            <RailSection title="Next 24h" right={<span className="font-mono text-[10px] tabular-nums text-ink-400 dark:text-ink-500">{upcoming.length}</span>}>
              <ul className="space-y-1">
                {upcoming.map((s) => (
                  <li
                    key={s.id}
                    className="flex items-center gap-2 px-1 py-1 rounded hover:bg-paper-50 dark:hover:bg-ink-800/60"
                  >
                    <Sparkles className="h-3 w-3 text-ember-500 shrink-0" />
                    <span className="flex-1 text-[12px] text-ink-900 dark:text-ink-50 truncate">
                      {s.name}
                    </span>
                    <span className="font-mono text-[10px] tabular-nums text-ember-700 dark:text-ember-300 shrink-0">
                      {s.nextRunAt
                        ? new Date(s.nextRunAt).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })
                        : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </RailSection>
          )}
        </aside>
      </div>
    </div>
  );
}

/* ── Composer — project + agent + perms + prompt ───────────────── */

function Composer({ firstRun }: { firstRun: boolean }) {
  const navigate = useNavigate();
  const create = useCreateTask();
  const { toast } = useApp();
  const projectsQ = useProjects();
  const projects = projectsQ.data?.projects ?? [];

  const prefsQ = usePrefs();
  const patchPrefs = usePatchPrefs();
  const [projectId, setProjectId] = useState<string>("");
  const [projectPath, setProjectPath] = useState<string>("");
  const [workspace, setWorkspace] = useState<WorkspaceSetupValue>(() =>
    defaultWorkspaceSetup("main"),
  );
  const [agent, setAgent] = useState<"claude" | "codex">("claude");
  const [permissionMode, setPermissionMode] =
    useState<PermissionMode>("bypassPermissions");
  const [prompt, setPrompt] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  // Hydrate the form from server-side prefs once.
  useEffect(() => {
    if (hydrated) return;
    const p = prefsQ.data?.prefs;
    if (!p) return;
    setProjectId(p.lastProjectId);
    setAgent(p.lastAgent);
    setPermissionMode(p.lastPermissionMode);
    setWorkspace({
      workspaceMode: p.workspaceMode,
      branchMode: p.branchMode,
      branchName: "",
      baseBranch: p.lastBase || "main",
      pullLatest: p.pullLatest,
    });
    setHydrated(true);
  }, [prefsQ.data, hydrated]);

  // Sync the path label whenever the project list updates and our id matches.
  useEffect(() => {
    if (!projectId) return;
    const found = projects.find((p) => p.id === projectId);
    if (found) setProjectPath(found.path);
  }, [projectId, projects]);

  const submit = async () => {
    const path = projectPath.trim();
    const p = prompt.trim();
    if (!path) {
      toast("Pick a project first", true);
      return;
    }
    if (!p) {
      toast("Tell the agent what to do", true);
      return;
    }
    try {
      const finalBase = workspace.baseBranch.trim() || "main";
      const res = await create.mutateAsync({
        agent,
        repoPath: path,
        baseBranch: finalBase,
        prompt: p,
        permissionMode,
        workspaceMode: workspace.workspaceMode,
        branchMode: workspace.branchMode,
        ...(workspace.branchName.trim()
          ? { branchName: workspace.branchName.trim() }
          : {}),
        ...(workspace.pullLatest ? { pullLatest: true } : {}),
      });
      void patchPrefs.mutateAsync({
        lastProjectId: projectId,
        lastBase: finalBase,
        lastAgent: agent,
        lastPermissionMode: permissionMode,
        workspaceMode: workspace.workspaceMode,
        branchMode: workspace.branchMode,
        pullLatest: workspace.pullLatest,
      });
      setPrompt("");
      navigate(`/tasks/${res.task.id}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), true);
    }
  };

  const onPromptKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !create.isPending) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <section
      className={cn(
        "rounded-lg border bg-paper-50 dark:bg-ink-800 overflow-hidden",
        firstRun
          ? "border-ember-500/40 shadow-[0_0_0_4px_rgba(255,92,40,0.05)]"
          : "border-ink-900/10 dark:border-ink-50/10",
      )}
    >
      <div className="flex items-center gap-2 px-4 py-2 border-b border-ink-900/[0.06] bg-paper-100/40 dark:border-ink-50/[0.06] dark:bg-ink-900/30">
        <Rocket
          className={cn(
            "h-3.5 w-3.5 shrink-0",
            firstRun
              ? "text-ember-600 dark:text-ember-400"
              : "text-ink-400 dark:text-ink-500",
          )}
        />
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-500 dark:text-ink-400">
          {firstRun ? "spawn your first agent" : "spawn"}
        </span>
        <Spacer />
        <span className="font-mono text-[10px] text-ink-400 dark:text-ink-500 hidden sm:inline">
          ⌘↵ to send
        </span>
      </div>

      <Textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={onPromptKey}
        placeholder={
          firstRun
            ? "Describe what the agent should do — e.g. 'add a /metrics endpoint that exposes request count and p95 latency'"
            : "Tell the agent what to do…"
        }
        rows={firstRun ? 6 : 4}
        className="border-0 rounded-none focus-visible:ring-0 resize-none bg-transparent text-[14px] leading-relaxed px-4 py-3 shadow-none"
      />

      {/* Bottom toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-t border-ink-900/[0.06] bg-paper-100/40 px-3 py-2 dark:border-ink-50/[0.06] dark:bg-ink-900/30">
        <div className="min-w-0 flex-1 sm:flex-initial sm:w-72">
          <ProjectPicker
            value={projectId}
            onChange={(p) => {
              setProjectId(p.id);
              setProjectPath(p.path);
            }}
            autoFocus={firstRun}
          />
        </div>

        <ToolbarSelect
          label={agent}
          options={[
            { value: "claude", label: "claude" },
            { value: "codex", label: "codex" },
          ]}
          onSelect={(v) => setAgent(v as "claude" | "codex")}
        />

        <ToolbarSelect
          label={
            permissionMode === "bypassPermissions"
              ? "bypass"
              : permissionMode === "acceptEdits"
              ? "accept-edits"
              : "plan"
          }
          options={[
            { value: "bypassPermissions", label: "bypass · auto-allow" },
            { value: "acceptEdits", label: "accept-edits · edits only" },
            { value: "plan", label: "plan · read-only" },
          ]}
          onSelect={(v) => setPermissionMode(v as PermissionMode)}
        />

        <ToolbarSelect
          label={workspace.workspaceMode === "in_place" ? "in-place" : "worktree"}
          options={[
            { value: "worktree", label: "worktree · isolated copy" },
            { value: "in_place", label: "in-place · your real branch" },
          ]}
          onSelect={(v) =>
            setWorkspace({
              ...workspace,
              workspaceMode: v as "worktree" | "in_place",
            })
          }
        />

        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-400 hover:text-ink-700 dark:text-ink-500 dark:hover:text-ink-200 inline-flex items-center gap-1 px-1"
        >
          {showAdvanced ? "less" : "setup"}
          <ChevronDown
            className={cn(
              "h-3 w-3 transition-transform",
              showAdvanced && "rotate-180",
            )}
          />
        </button>

        <Spacer />

        <Button
          size="sm"
          onClick={submit}
          disabled={create.isPending || !projectPath || !prompt.trim()}
        >
          {create.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <CornerDownLeft className="h-3.5 w-3.5" />
          )}
          Spawn
        </Button>
      </div>

      {showAdvanced && (
        <div className="border-t border-ink-900/[0.06] bg-paper-100/40 px-3 py-2.5 dark:border-ink-50/[0.06] dark:bg-ink-900/30">
          <WorkspaceSetup
            value={workspace}
            onChange={setWorkspace}
            projectIdOrSlug={projectId || null}
            prompt={prompt}
          />
        </div>
      )}

    </section>
  );
}

function ToolbarSelect({
  label,
  options,
  onSelect,
}: {
  label: string;
  options: { value: string; label: string }[];
  onSelect: (v: string) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 h-7 px-2 rounded border border-ink-900/10 bg-paper-50 font-mono text-[11px] text-ink-700 hover:border-ink-900/25 hover:bg-paper-100 dark:border-ink-50/10 dark:bg-ink-800 dark:text-ink-200 dark:hover:bg-ink-700 transition-colors"
        >
          {label}
          <ChevronDown className="h-3 w-3 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[200px]">
        {options.map((o) => (
          <DropdownMenuItem key={o.value} onClick={() => onSelect(o.value)}>
            <span className="font-mono text-[12px]">{o.label}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* ── Layout helpers ─────────────────────────────────────────────── */

function Lane({
  kicker,
  title,
  trailing,
  accent,
  children,
}: {
  kicker: string;
  title: string;
  trailing?: React.ReactNode;
  accent?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-2 flex items-baseline gap-2">
        <span
          className={cn(
            "font-mono text-[10px] uppercase tracking-[0.14em]",
            accent
              ? "text-ember-700 dark:text-ember-300"
              : "text-ink-400 dark:text-ink-500",
          )}
        >
          {kicker}
        </span>
        <span className="text-[13px] font-medium text-ink-900 dark:text-ink-50">
          {title}
        </span>
        <span className="ml-auto">{trailing}</span>
      </div>
      {children}
    </section>
  );
}

function RailSection({
  title,
  right,
  sticky,
  children,
}: {
  title: string;
  right?: React.ReactNode;
  sticky?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b border-ink-900/[0.06] dark:border-ink-50/[0.06]">
      <div
        className={cn(
          "flex items-baseline gap-2 px-4 pt-3 pb-2",
          sticky && "sticky top-0 bg-paper-100/80 backdrop-blur dark:bg-ink-900/80 z-10",
        )}
      >
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-500 dark:text-ink-400 font-medium">
          {title}
        </span>
        <span className="ml-auto">{right}</span>
      </div>
      <div className="px-4 pb-3">{children}</div>
    </div>
  );
}

function LiveDot() {
  return (
    <span className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.12em] text-ember-700 dark:text-ember-300">
      <span className="h-1.5 w-1.5 rounded-full bg-ember-500 animate-blink" />
      live
    </span>
  );
}

/* ── Right-rail content ─────────────────────────────────────────── */

function ProjectsRail({ projects }: { projects: Project[] }) {
  if (projects.length === 0) {
    return (
      <div className="text-[11px] text-ink-400 dark:text-ink-500 italic">
        No projects yet — add one from the composer.
      </div>
    );
  }
  return (
    <ul className="space-y-1">
      {projects.slice(0, 8).map((p) => (
        <li key={p.id}>
          <Link
            to={`/projects/${p.slug}`}
            className="group flex items-center gap-2 px-1 py-1 rounded hover:bg-paper-50 dark:hover:bg-ink-800/60 transition-colors"
          >
            <span
              className="size-2 rounded-sm shrink-0"
              style={{ background: p.color ?? "#FF5C28" }}
            />
            <span className="flex-1 min-w-0">
              <span className="block text-[12px] font-medium text-ink-900 dark:text-ink-50 truncate">
                {p.name}
              </span>
              <span className="block font-mono text-[10px] text-ink-500 dark:text-ink-400 truncate">
                {p.path}
              </span>
            </span>
            {(p.activeCount ?? 0) > 0 && (
              <span className="font-mono text-[10px] tabular-nums text-ember-700 dark:text-ember-300 shrink-0">
                {p.activeCount} live
              </span>
            )}
            {(p.taskCount ?? 0) > 0 && (
              <span className="font-mono text-[10px] tabular-nums text-ink-400 dark:text-ink-500 shrink-0 w-8 text-right">
                {p.taskCount}
              </span>
            )}
          </Link>
        </li>
      ))}
    </ul>
  );
}

/* ── Activity ticker ────────────────────────────────────────────── */

function ActivityTicker({ tasks }: { tasks: Task[] }) {
  const client = useClient();
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const titleByIdRef = useRef(new Map<string, string>());

  useEffect(() => {
    const m = titleByIdRef.current;
    for (const t of tasks) m.set(t.id, t.title);
  }, [tasks]);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const open = () => {
      ws = client.watch(null, (msg: WsServerEvent) => {
        if (msg.type !== "event") return;
        const ev = msg.event;
        const title = titleByIdRef.current.get(msg.taskId) ?? "task";
        let text: string | null = null;
        if (ev.kind === "message") {
          text = (ev.text || "").replace(/\s+/g, " ").trim();
          if (text.length > 100) text = text.slice(0, 97) + "…";
        } else if (ev.kind === "tool_call") {
          text = `→ ${ev.tool}`;
        } else if (ev.kind === "status") {
          text = `→ ${ev.status}`;
        } else if (ev.kind === "exit") {
          text = `exit ${ev.code ?? "?"}`;
        }
        if (!text) return;
        setEntries((prev) => {
          const next: ActivityEntry = {
            id: `${msg.taskId}-${msg.ts}-${Math.random().toString(36).slice(2, 6)}`,
            taskId: msg.taskId,
            taskTitle: title,
            text,
            kind: ev.kind,
            ts: msg.ts,
          };
          return [next, ...prev].slice(0, 10);
        });
      });
      ws.addEventListener("close", () => {
        if (closed) return;
        reconnectTimer = setTimeout(open, 2000);
      });
    };
    open();
    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try {
        ws?.close();
      } catch {
        // already closed
      }
    };
  }, [client]);

  if (entries.length === 0) {
    return (
      <div className="text-[11px] text-ink-400 dark:text-ink-500 italic">
        Waiting for events…
      </div>
    );
  }
  return (
    <ul className="space-y-1">
      {entries.map((e) => (
        <li key={e.id}>
          <Link
            to={`/tasks/${e.taskId}`}
            className="block px-1 py-1 rounded hover:bg-paper-50 dark:hover:bg-ink-800/60 transition-colors"
          >
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-[10px] tabular-nums text-ink-400 dark:text-ink-500 shrink-0 w-10">
                {formatTs(e.ts)}
              </span>
              <span className="text-[11px] text-ink-700 dark:text-ink-200 truncate flex-1">
                {e.taskTitle}
              </span>
            </div>
            <div
              className={cn(
                "ml-12 mt-0.5 text-[11px] truncate",
                e.kind === "tool_call" || e.kind === "tool_result"
                  ? "font-mono text-ink-500 dark:text-ink-400"
                  : "text-ink-700 dark:text-ink-200",
              )}
            >
              {e.text}
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/* ── Running task row ────────────────────────────────────────────── */

function RunningRow({ task }: { task: Task }) {
  const tokens = (task.totalInputTokens ?? 0) + (task.totalOutputTokens ?? 0);
  const statusLabel =
    task.status === "running"
      ? "running"
      : task.status === "waiting_input"
      ? "needs input"
      : task.status === "waiting_perm"
      ? "needs approval"
      : task.status;
  const statusTone =
    task.status === "waiting_input" || task.status === "waiting_perm"
      ? "text-amber-700 dark:text-amber-300"
      : "text-ember-700 dark:text-ember-300";
  return (
    <li>
      <Link
        to={`/tasks/${task.id}`}
        className="flex items-center gap-3 px-4 py-2.5 hover:bg-paper-100/60 dark:hover:bg-ink-700/60 transition-colors"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-ember-500 animate-blink shrink-0" />
        <span className="flex-1 min-w-0">
          <span className="block text-[13px] font-medium text-ink-900 dark:text-ink-50 truncate">
            {task.title}
          </span>
          <span className="block mt-0.5 font-mono text-[10px] text-ink-500 dark:text-ink-400 truncate">
            {task.agent} · {task.branch}
          </span>
        </span>
        <span
          className={cn(
            "font-mono text-[10px] uppercase tracking-[0.12em] shrink-0",
            statusTone,
          )}
        >
          {statusLabel}
        </span>
        <span className="font-mono text-[10px] tabular-nums text-ink-500 dark:text-ink-400 shrink-0 hidden sm:inline w-20 text-right">
          {formatTokens(tokens)} tok
        </span>
        <ArrowUpRight className="h-3.5 w-3.5 text-ink-400 dark:text-ink-500 shrink-0" />
      </Link>
    </li>
  );
}

/* ── Completed task row ──────────────────────────────────────────── */

function DoneRow({ task }: { task: Task }) {
  const ok = task.status === "done";
  return (
    <li>
      <Link
        to={`/tasks/${task.id}`}
        className="flex items-center gap-3 px-4 py-2.5 hover:bg-paper-100/60 dark:hover:bg-ink-700/60 transition-colors"
      >
        <span
          className={cn(
            "font-mono text-[11px] shrink-0 w-3 text-center",
            ok
              ? "text-emerald-700 dark:text-emerald-300"
              : task.status === "stopped"
              ? "text-ink-500 dark:text-ink-400"
              : "text-red-700 dark:text-red-300",
          )}
        >
          {ok ? "✓" : task.status === "stopped" ? "■" : "✗"}
        </span>
        <span className="flex-1 min-w-0">
          <span className="block text-[13px] text-ink-900 dark:text-ink-50 truncate">
            {task.title}
          </span>
          <span className="block mt-0.5 font-mono text-[10px] text-ink-500 dark:text-ink-400 truncate">
            {task.agent} · {task.branch} · {formatTs(task.updatedAt)}
            {task.prUrl && (
              <>
                {" · "}
                <span className="text-ember-700 dark:text-ember-300">PR</span>
              </>
            )}
          </span>
        </span>
        <span className="font-mono text-[10px] tabular-nums text-ink-400 dark:text-ink-500 shrink-0 hidden sm:inline">
          {formatCost(task.totalCostUsd)}
        </span>
        <ArrowUpRight className="h-3.5 w-3.5 text-ink-400 dark:text-ink-500 shrink-0" />
      </Link>
    </li>
  );
}

/* ── First-run hints ─────────────────────────────────────────────── */

function FirstRunHints() {
  return (
    <Lane kicker="getting started" title="next steps">
      <ul className="rounded-md border border-ink-900/10 bg-paper-50 dark:border-ink-50/10 dark:bg-ink-800 divide-y divide-ink-900/[0.06] dark:divide-ink-50/[0.06] overflow-hidden">
        <HintRow
          to="/templates"
          glyph="▤"
          title="Save a template"
          body="Lock down a prompt with placeholders so cron can fire it later."
        />
        <HintRow
          to="/schedules"
          glyph="◇"
          title="Schedule a recurring task"
          body="Cron fires templates on its own — nightly tests, weekly audits, etc."
        />
        <HintRow
          to="/plugins"
          glyph="∷"
          title="Connect a chat bridge"
          body="Telegram or Discord — talk to your agents from your phone."
        />
      </ul>
    </Lane>
  );
}

function HintRow({
  to,
  glyph,
  title,
  body,
}: {
  to: string;
  glyph: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <li>
      <Link
        to={to}
        className="flex items-center gap-3 px-4 py-3 hover:bg-paper-100 dark:hover:bg-ink-700 transition-colors"
      >
        <span className="font-mono text-[14px] text-ember-500 w-6 shrink-0 grid place-items-center">
          {glyph}
        </span>
        <span className="flex-1 min-w-0">
          <span className="block text-[13px] font-medium text-ink-900 dark:text-ink-50">
            {title}
          </span>
          <span className="block mt-0.5 text-[11px] text-ink-500 dark:text-ink-400">
            {body}
          </span>
        </span>
        <ArrowUpRight className="h-3.5 w-3.5 text-ink-400 dark:text-ink-500 shrink-0" />
      </Link>
    </li>
  );
}
