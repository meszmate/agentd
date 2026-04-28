import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { AgentEvent, Task, WsServerEvent } from "@agentd/contracts";
import {
  Count,
  Kicker,
  PageTitle,
  PageTopbar,
  Spacer,
  VRule,
} from "@/components/ui/page-topbar";
import { SectionHeader } from "@/components/ui/section-header";
import { StatCell } from "@/components/ui/big-num";
import { useClient } from "@/AppContext";
import { useSchedules, useTasks, useTemplates } from "@/queries";
import {
  cn,
  formatCost,
  formatTokens,
  formatTs,
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
    return Array.isArray(arr)
      ? arr.filter((s): s is string => typeof s === "string")
      : [];
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
  if (h < 5) return "Late night";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
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
      .sort((a, b) => a.nextRunAt! - b.nextRunAt!)
      .slice(0, 6);
  }, [schedulesQ.data]);

  return (
    <div className="flex h-full flex-col">
      {/* Topbar — greeting line with italic name */}
      <PageTopbar>
        <Kicker>workspace</Kicker>
        <VRule />
        <span className="text-[13px] text-ink-900 dark:text-ink-50">
          {greeting()}.{" "}
          {stats.activeCount > 0 ? (
            <em className="italic font-medium">
              {stats.activeCount}{" "}
              {stats.activeCount === 1 ? "agent" : "agents"} working.
            </em>
          ) : (
            <span className="text-ink-500 dark:text-ink-400">
              Nothing running.
            </span>
          )}
        </span>
        <Spacer />
        <Link
          to="/tasks"
          className="inline-flex h-7 items-center gap-1 px-2.5 rounded-md border border-ink-900/10 hover:bg-ink-900/[0.03] text-[12px] text-ink-700 dark:text-ink-200 dark:border-ink-50/10 dark:hover:bg-ink-50/[0.03] transition-colors"
        >
          All tasks
        </Link>
      </PageTopbar>

      {/* Stat strip — borderless grid with vertical dividers */}
      <div className="grid grid-cols-2 md:grid-cols-4 border-b border-ink-900/10 dark:border-ink-50/10 shrink-0">
        <StatCell
          label="Active"
          value={stats.activeCount}
          sublabel={
            stats.activeCount > 0
              ? "running now"
              : "nothing running"
          }
          accent={stats.activeCount > 0}
          href="/tasks"
        />
        <StatCell
          label="Today"
          value={stats.todayCount}
          sublabel={`${tasks.length.toLocaleString()} all-time`}
          href="/tasks"
        />
        <StatCell
          label="Spend / day"
          value={formatCost(stats.todaysSpend)}
          sublabel={`${formatTokens(stats.totalTok)} tok all-time`}
        />
        <StatCell
          label="Open PRs"
          value={stats.openPrCount}
          sublabel="awaiting review"
          last
        />
      </div>

      {/* Two-column body */}
      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[1fr_320px]">
        <section className="flex flex-col min-h-0 lg:border-r lg:border-ink-900/10 dark:lg:border-ink-50/10 overflow-hidden">
          <ActivityFeed tasks={tasks} />
        </section>

        <aside className="flex flex-col min-h-0 bg-cream-100/30 border-t lg:border-t-0 border-ink-900/10 dark:bg-ink-50/[0.015] dark:border-ink-50/10 overflow-hidden">
          <UpcomingPanel items={upcomingFires} />
          <ReposPanel recentRepos={recentRepos} />
          <ShortcutsPanel
            templatesCount={templatesQ.data?.templates.length ?? 0}
            schedulesCount={schedulesQ.data?.schedules.length ?? 0}
          />
        </aside>
      </div>
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
          return [next, ...prev].slice(0, 30);
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
    <>
      <SectionHeader
        label="Activity"
        hint={
          entries.length > 0
            ? `${entries.length} events`
            : live
            ? "waiting…"
            : "connecting…"
        }
        right={
          <>
            <span
              className={cn(
                "flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em]",
                live
                  ? "text-vermilion-700 dark:text-vermilion-300"
                  : "text-ink-400 dark:text-ink-500",
              )}
            >
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  live ? "bg-vermilion-500 animate-blink" : "bg-ink-300",
                )}
              />
              {live ? "live" : "off"}
            </span>
            <Link
              to="/activity"
              className="text-[11px] text-ink-500 hover:text-ink-900 transition-colors dark:text-ink-400 dark:hover:text-ink-50"
            >
              Open →
            </Link>
          </>
        }
      />

      <div className="flex-1 overflow-y-auto">
        {entries.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <div className="text-center text-[12px] text-ink-500 dark:text-ink-400">
              Spawn a task and events stream here.
            </div>
          </div>
        ) : (
          <ul className="divide-y divide-ink-900/[0.06] dark:divide-ink-50/[0.06]">
            {entries.map((e) => (
              <li key={e.id}>
                <Link
                  to={`/tasks/${e.taskId}`}
                  className="group flex items-baseline gap-3 h-11 px-5 hover:bg-cream-100/40 transition-colors dark:hover:bg-ink-50/[0.02]"
                >
                  <span className="font-mono text-[10px] tabular-nums text-ink-400 dark:text-ink-500 w-14 shrink-0">
                    {formatTs(e.ts)}
                  </span>
                  <span className="text-[12px] font-medium text-ink-900 dark:text-ink-50 truncate max-w-[200px]">
                    {e.taskTitle}
                  </span>
                  <span className="text-ink-300 dark:text-ink-600 shrink-0">
                    ·
                  </span>
                  <span
                    className={cn(
                      "text-[12px] truncate flex-1",
                      e.kind === "tool_call" || e.kind === "tool_result"
                        ? "font-mono text-[11px] text-ink-500 dark:text-ink-400"
                        : "text-ink-700 dark:text-ink-200",
                    )}
                  >
                    {e.text}
                  </span>
                  <span className="font-mono text-[10px] text-ink-300 dark:text-ink-600 shrink-0">
                    {shortId(e.taskId)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function UpcomingPanel({
  items,
}: {
  items: { id: string; name: string; nextRunAt: number | null; cron: string }[];
}) {
  return (
    <div className="border-b border-ink-900/10 dark:border-ink-50/10 flex flex-col">
      <SectionHeader
        label="Upcoming"
        hint="next 24h"
        right={
          <span className="font-mono text-[10px] tabular-nums text-ink-400 dark:text-ink-500">
            {items.length}
          </span>
        }
        sticky={false}
      />
      {items.length === 0 ? (
        <div className="px-5 py-5 text-[11px] text-ink-400 dark:text-ink-500">
          Nothing scheduled.
        </div>
      ) : (
        <ul className="divide-y divide-ink-900/[0.06] dark:divide-ink-50/[0.06]">
          {items.map((s) => (
            <li
              key={s.id}
              className="h-11 px-5 flex items-center gap-3 hover:bg-cream-50 dark:hover:bg-ink-50/[0.02] transition-colors"
            >
              <span className="text-[12px] font-medium text-ink-900 dark:text-ink-50 truncate flex-1">
                {s.name}
              </span>
              <span className="font-mono text-[10px] text-ink-400 dark:text-ink-500 truncate max-w-[8ch]">
                {s.cron}
              </span>
              <span className="font-mono text-[10px] tabular-nums text-vermilion-700 dark:text-vermilion-300 w-12 text-right">
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
      )}
    </div>
  );
}

function ReposPanel({
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
    <div className="border-b border-ink-900/10 dark:border-ink-50/10 flex flex-col">
      <SectionHeader
        label="Repos"
        hint="pinned + recent"
        right={
          <span className="font-mono text-[10px] tabular-nums text-ink-400 dark:text-ink-500">
            {list.length}
          </span>
        }
        sticky={false}
      />
      {list.length === 0 ? (
        <div className="px-5 py-5 text-[11px] text-ink-400 dark:text-ink-500">
          Spawn a task — repos collect here.
        </div>
      ) : (
        <ul className="divide-y divide-ink-900/[0.06] dark:divide-ink-50/[0.06]">
          {list.map((r) => (
            <li
              key={r.path}
              className="group h-9 px-5 flex items-center gap-2 hover:bg-cream-50 dark:hover:bg-ink-50/[0.02] transition-colors"
            >
              <button
                type="button"
                onClick={() => toggle(r.path)}
                aria-label={r.pinned ? "Unpin repo" : "Pin repo"}
                className={cn(
                  "font-mono text-[11px] w-3 shrink-0 transition-colors",
                  r.pinned
                    ? "text-vermilion-500"
                    : "text-ink-300 hover:text-vermilion-500 dark:text-ink-600",
                )}
              >
                {r.pinned ? "★" : "☆"}
              </button>
              <span className="font-mono text-[11px] text-ink-700 dark:text-ink-200 truncate flex-1">
                {r.path}
              </span>
              <span className="font-mono text-[10px] tabular-nums text-ink-400 dark:text-ink-500">
                {r.count}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ShortcutsPanel({
  templatesCount,
  schedulesCount,
}: {
  templatesCount: number;
  schedulesCount: number;
}) {
  return (
    <div className="flex flex-col">
      <SectionHeader label="Jump" sticky={false} />
      <ul>
        <Shortcut
          glyph="▤"
          label="Templates"
          count={templatesCount}
          href="/templates"
        />
        <Shortcut
          glyph="◇"
          label="Schedules"
          count={schedulesCount}
          href="/schedules"
        />
        <Shortcut glyph="∷" label="Plugins" href="/plugins" />
        <Shortcut glyph="▢" label="Devices" href="/devices" />
      </ul>
    </div>
  );
}

function Shortcut({
  glyph,
  label,
  href,
  count,
}: {
  glyph: string;
  label: string;
  href: string;
  count?: number;
}) {
  void Count; // suppress unused if count is undefined later
  return (
    <li>
      <Link
        to={href}
        className="group h-9 px-5 flex items-center gap-3 border-b border-ink-900/[0.06] last:border-b-0 hover:bg-cream-50 transition-colors dark:border-ink-50/[0.06] dark:hover:bg-ink-50/[0.02]"
      >
        <span className="font-mono text-[11px] text-ink-400 group-hover:text-vermilion-500 w-3 transition-colors dark:text-ink-500">
          {glyph}
        </span>
        <span className="text-[12px] text-ink-700 group-hover:text-ink-900 flex-1 transition-colors dark:text-ink-200 dark:group-hover:text-ink-50">
          {label}
        </span>
        {count !== undefined && (
          <span className="font-mono text-[10px] tabular-nums text-ink-400 dark:text-ink-500">
            {count}
          </span>
        )}
        <span className="text-[10px] text-ink-300 group-hover:text-ink-500 transition-colors dark:text-ink-600">
          →
        </span>
      </Link>
    </li>
  );
}

void PageTitle;
