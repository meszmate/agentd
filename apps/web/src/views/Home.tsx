import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  FolderGit2,
  Sparkles,
  Star,
  StarOff,
} from "lucide-react";
import type { AgentEvent, Task, WsServerEvent } from "@agentd/contracts";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useClient } from "@/AppContext";
import { useSchedules, useTasks, useTemplates } from "@/queries";
import {
  cn,
  formatCost,
  formatTokens,
  formatTs,
  formatTsAbsolute,
  shortId,
} from "@/lib/utils";

const PINS_KEY = "agentd.pinnedRepos";

interface ActivityEntry {
  id: string;
  taskId: string;
  taskTitle: string;
  text: string;
  kind: AgentEvent["kind"];
  ts: number;
}

function loadPins(): string[] {
  try {
    const raw = localStorage.getItem(PINS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}
function savePins(pins: string[]): void {
  localStorage.setItem(PINS_KEY, JSON.stringify(pins));
}

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Burning the midnight oil.";
  if (h < 12) return "Good morning.";
  if (h < 18) return "Good afternoon.";
  return "Good evening.";
}

export function Home() {
  const tasksQ = useTasks();
  const schedulesQ = useSchedules();
  const templatesQ = useTemplates();

  const tasks = tasksQ.data?.tasks ?? [];
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
    const openPrs = tasks.filter((t) => !!t.prUrl);
    const totalTok = tasks.reduce(
      (s, t) =>
        s + (t.totalInputTokens ?? 0) + (t.totalOutputTokens ?? 0),
      0,
    );
    return {
      todayCount: todayTasks.length,
      activeCount: active.length,
      todaysSpend,
      openPrCount: openPrs.length,
      totalTok,
    };
  }, [tasks, todayMs]);

  const recentRepos = useMemo(() => {
    const seen = new Map<string, { path: string; lastTs: number; count: number }>();
    for (const t of tasks) {
      const cur = seen.get(t.repoPath);
      if (cur) {
        cur.count += 1;
        cur.lastTs = Math.max(cur.lastTs, t.createdAt);
      } else {
        seen.set(t.repoPath, {
          path: t.repoPath,
          lastTs: t.createdAt,
          count: 1,
        });
      }
    }
    return [...seen.values()].sort((a, b) => b.lastTs - a.lastTs).slice(0, 8);
  }, [tasks]);

  const upcomingFires = useMemo(() => {
    const items = schedulesQ.data?.schedules ?? [];
    const now = Date.now();
    const soon = now + 24 * 60 * 60 * 1000;
    return items
      .filter((s) => s.enabled && s.nextRunAt && s.nextRunAt <= soon)
      .sort((a, b) => (a.nextRunAt! - b.nextRunAt!))
      .slice(0, 5);
  }, [schedulesQ.data]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl px-6 py-8 lg:px-10 lg:py-10">
        <Hero stats={stats} />
        <StatStrip stats={stats} />

        <div className="mt-10 grid gap-8 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <ActivityFeed tasks={tasks} />
          </div>
          <div className="space-y-8">
            <NextFires items={upcomingFires} />
            <PinnedRepos recentRepos={recentRepos} />
            <TemplatesQuick
              count={templatesQ.data?.templates.length ?? 0}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function Hero({ stats }: { stats: { activeCount: number } }) {
  return (
    <header className="rise rise-1">
      <div className="label-section mb-3">Workspace</div>
      <h1 className="display text-5xl sm:text-6xl text-ink-900 dark:text-ink-50">
        {greeting()}{" "}
        <span className="text-ink-400 dark:text-ink-500">
          {stats.activeCount > 0
            ? `${stats.activeCount} ${stats.activeCount === 1 ? "agent" : "agents"} working.`
            : "Spawn an agent to get started."}
        </span>
      </h1>
    </header>
  );
}

function StatStrip({
  stats,
}: {
  stats: {
    todayCount: number;
    activeCount: number;
    todaysSpend: number;
    openPrCount: number;
    totalTok: number;
  };
}) {
  return (
    <div className="rise rise-2 mt-8 grid grid-cols-2 sm:grid-cols-4 border-y border-ink-900/10 dark:border-ink-50/10 divide-x divide-ink-900/10 dark:divide-ink-50/10">
      <Stat label="Today" value={String(stats.todayCount)} hint="runs" />
      <Stat
        label="Active"
        value={String(stats.activeCount)}
        hint={stats.activeCount === 1 ? "agent" : "agents"}
        accent={stats.activeCount > 0}
      />
      <Stat
        label="Today's spend"
        value={formatCost(stats.todaysSpend)}
        hint={`${formatTokens(stats.totalTok)} tok total`}
      />
      <Stat
        label="Open PRs"
        value={String(stats.openPrCount)}
        hint="awaiting review"
      />
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: string;
  hint?: string;
  accent?: boolean;
}) {
  return (
    <div className="px-5 py-4">
      <div className="label-section mb-2">{label}</div>
      <div
        className={cn(
          "num text-3xl sm:text-4xl tracking-tight",
          accent ? "text-vermilion-600 dark:text-vermilion-400" : "text-ink-900 dark:text-ink-50",
        )}
      >
        {value}
      </div>
      {hint && (
        <div className="mt-1 text-2xs text-ink-500 dark:text-ink-400">{hint}</div>
      )}
    </div>
  );
}

function ActivityFeed({ tasks }: { tasks: Task[] }) {
  const client = useClient();
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [live, setLive] = useState(false);
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
          if (text.length > 160) text = text.slice(0, 157) + "…";
        } else if (ev.kind === "tool_call") {
          text = `→ ${ev.tool}`;
        } else if (ev.kind === "status") {
          text = `status → ${ev.status}`;
        } else if (ev.kind === "exit") {
          text = `exited ${ev.code ?? "?"}`;
        } else if (ev.kind === "tool_result") {
          text = `← ${ev.tool} ${ev.ok ? "ok" : "err"}`;
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
          return [next, ...prev].slice(0, 25);
        });
      });
      ws.addEventListener("open", () => setLive(true));
      ws.addEventListener("close", () => {
        setLive(false);
        if (closed) return;
        reconnectTimer = setTimeout(open, 2000);
      });
      ws.addEventListener("error", () => setLive(false));
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

  return (
    <section className="rise rise-3">
      <div className="mb-4 flex items-baseline justify-between">
        <h2 className="display text-2xl text-ink-900 dark:text-ink-50">
          Activity
        </h2>
        <div className="flex items-center gap-3">
          <span
            className={cn(
              "flex items-center gap-1.5 font-mono text-2xs uppercase tracking-[0.12em]",
              live
                ? "text-vermilion-600 dark:text-vermilion-400"
                : "text-ink-400 dark:text-ink-500",
            )}
          >
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                live
                  ? "bg-vermilion-500 animate-blink"
                  : "bg-ink-300 dark:bg-ink-600",
              )}
            />
            {live ? "live" : "off"}
          </span>
          <Link
            to="/activity"
            className="font-mono text-2xs uppercase tracking-[0.12em] text-ink-500 hover:text-vermilion-600 dark:text-ink-400 dark:hover:text-vermilion-400"
          >
            Open ↗
          </Link>
        </div>
      </div>

      {entries.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-ink-900/10 dark:border-ink-50/10 px-5 py-10 text-center">
          <Sparkles className="mx-auto h-5 w-5 text-ink-300 dark:text-ink-600" />
          <p className="mt-2 text-sm text-ink-500 dark:text-ink-400">
            Nothing yet. Spawn a task and events will stream in here.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-ink-900/10 dark:divide-ink-50/10 border-y border-ink-900/10 dark:border-ink-50/10">
          {entries.map((e) => (
            <li
              key={e.id}
              className="grid grid-cols-[100px_1fr_auto] items-baseline gap-3 py-2.5"
            >
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="font-mono text-2xs uppercase tracking-[0.08em] text-ink-400 dark:text-ink-500 cursor-help">
                      {formatTs(e.ts)}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>{formatTsAbsolute(e.ts)}</TooltipContent>
                </Tooltip>
              </TooltipProvider>
              <span className="text-sm text-ink-700 dark:text-ink-200">
                <Link
                  to={`/tasks/${e.taskId}`}
                  className="font-medium text-ink-900 hover:text-vermilion-600 dark:text-ink-50 dark:hover:text-vermilion-400"
                >
                  {e.taskTitle}
                </Link>
                <span className="mx-2 text-ink-300 dark:text-ink-600">·</span>
                <span
                  className={cn(
                    e.kind === "tool_call" || e.kind === "tool_result"
                      ? "font-mono text-xs text-ink-500 dark:text-ink-400"
                      : "",
                  )}
                >
                  {e.text}
                </span>
              </span>
              <span className="font-mono text-2xs text-ink-300 dark:text-ink-600">
                {shortId(e.taskId)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function NextFires({
  items,
}: {
  items: { id: string; name: string; nextRunAt: number | null; cron: string }[];
}) {
  return (
    <section className="rise rise-4">
      <h2 className="display text-2xl text-ink-900 dark:text-ink-50">
        Up next
      </h2>
      <div className="mt-1 mb-3 text-2xs text-ink-500 dark:text-ink-400">
        Schedules firing in the next 24 hours.
      </div>
      {items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-ink-900/10 dark:border-ink-50/10 px-4 py-6 text-center text-2xs text-ink-500 dark:text-ink-400">
          Nothing scheduled.
        </div>
      ) : (
        <ul className="space-y-2">
          {items.map((s) => (
            <li
              key={s.id}
              className="flex items-baseline justify-between gap-3 border-b border-ink-900/10 dark:border-ink-50/10 pb-2"
            >
              <div className="min-w-0">
                <div className="text-sm font-medium text-ink-900 dark:text-ink-50 truncate">
                  {s.name}
                </div>
                <div className="font-mono text-2xs text-ink-500 dark:text-ink-400">
                  {s.cron}
                </div>
              </div>
              <div className="shrink-0 text-right">
                <div className="num text-base text-vermilion-600 dark:text-vermilion-400">
                  {s.nextRunAt ? formatTs(s.nextRunAt) : "—"}
                </div>
                <div className="font-mono text-[10px] text-ink-400 dark:text-ink-500">
                  {s.nextRunAt ? new Date(s.nextRunAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      <Link
        to="/schedules"
        className="mt-3 inline-flex items-center gap-1.5 font-mono text-2xs uppercase tracking-[0.12em] text-ink-500 hover:text-vermilion-600 dark:text-ink-400 dark:hover:text-vermilion-400"
      >
        All schedules <ArrowRight className="h-3 w-3" />
      </Link>
    </section>
  );
}

function PinnedRepos({
  recentRepos,
}: {
  recentRepos: { path: string; count: number; lastTs: number }[];
}) {
  const [pins, setPins] = useState<string[]>(() => loadPins());

  const toggle = (path: string) => {
    setPins((cur) => {
      const next = cur.includes(path)
        ? cur.filter((p) => p !== path)
        : [path, ...cur].slice(0, 8);
      savePins(next);
      return next;
    });
  };

  // Pinned first (in user's order), then recents not already pinned.
  const list = useMemo(() => {
    const seen = new Set<string>();
    const ordered: { path: string; count: number; pinned: boolean }[] = [];
    for (const p of pins) {
      const r = recentRepos.find((x) => x.path === p);
      ordered.push({ path: p, count: r?.count ?? 0, pinned: true });
      seen.add(p);
    }
    for (const r of recentRepos) {
      if (seen.has(r.path)) continue;
      ordered.push({ path: r.path, count: r.count, pinned: false });
    }
    return ordered.slice(0, 6);
  }, [pins, recentRepos]);

  return (
    <section className="rise rise-4">
      <h2 className="display text-2xl text-ink-900 dark:text-ink-50">Repos</h2>
      <div className="mt-1 mb-3 text-2xs text-ink-500 dark:text-ink-400">
        Pinned + recent paths.
      </div>
      {list.length === 0 ? (
        <div className="rounded-xl border border-dashed border-ink-900/10 dark:border-ink-50/10 px-4 py-6 text-center text-2xs text-ink-500 dark:text-ink-400">
          Spawn a task — repos will collect here.
        </div>
      ) : (
        <ul className="space-y-1">
          {list.map((r) => (
            <li
              key={r.path}
              className="group flex items-center gap-2 rounded-md border border-transparent px-2 py-1.5 hover:border-ink-900/10 hover:bg-ink-900/[0.02] dark:hover:border-ink-50/10 dark:hover:bg-ink-50/[0.02]"
            >
              <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-ink-400 dark:text-ink-500" />
              <span className="flex-1 truncate font-mono text-xs">
                {r.path}
              </span>
              <span className="font-mono text-2xs text-ink-400 dark:text-ink-500 shrink-0">
                {r.count}
              </span>
              <button
                type="button"
                onClick={() => toggle(r.path)}
                aria-label={r.pinned ? "Unpin repo" : "Pin repo"}
                className="rounded p-1 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-vermilion-500/30"
              >
                {r.pinned ? (
                  <Star className="h-3 w-3 fill-vermilion-500 text-vermilion-500" />
                ) : (
                  <StarOff className="h-3 w-3 text-ink-400" />
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function TemplatesQuick({ count }: { count: number }) {
  return (
    <section className="rise rise-5">
      <h2 className="display text-2xl text-ink-900 dark:text-ink-50">
        Templates
      </h2>
      <div className="mt-1 mb-3 text-2xs text-ink-500 dark:text-ink-400">
        Reusable prompts with placeholders.
      </div>
      <Link
        to="/templates"
        className="flex items-center justify-between rounded-xl border border-ink-900/10 bg-cream-50 px-4 py-3 transition-colors hover:bg-ink-900/[0.02] dark:border-ink-50/10 dark:bg-ink-800 dark:hover:bg-ink-50/[0.03]"
      >
        <span>
          <span className="block text-sm font-medium text-ink-900 dark:text-ink-50">
            Browse {count} templates
          </span>
          <span className="block text-2xs text-ink-500 dark:text-ink-400">
            One-tap run with arg substitution.
          </span>
        </span>
        <ArrowRight className="h-4 w-4 text-vermilion-500" />
      </Link>
    </section>
  );
}
