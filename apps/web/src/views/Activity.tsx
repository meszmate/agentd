import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Pause, Play, Trash2 } from "lucide-react";
import type { AgentEvent, WsServerEvent } from "@agentd/contracts";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useClient } from "@/AppContext";
import { useTasks } from "@/queries";
import {
  cn,
  formatTs,
  formatTsAbsolute,
  shortId,
} from "@/lib/utils";

type Kind = AgentEvent["kind"];

interface FlatEvent {
  id: string;
  taskId: string;
  taskTitle: string;
  taskAgent: "claude" | "codex";
  kind: Kind;
  ts: number;
  // Pre-rendered text for display.
  primary: string;
  secondary?: string;
}

const KIND_LABEL: Record<Kind, string> = {
  message: "msg",
  tool_call: "→ tool",
  tool_result: "← tool",
  permission_request: "perm",
  status: "status",
  raw: "raw",
  exit: "exit",
  usage: "usage",
};

const KIND_TONE: Record<Kind, string> = {
  message: "text-ink-700 dark:text-ink-200",
  tool_call: "text-sky-700 dark:text-sky-300",
  tool_result: "text-sky-700 dark:text-sky-300",
  permission_request: "text-amber-700 dark:text-amber-300",
  status: "text-vermilion-700 dark:text-vermilion-300",
  raw: "text-ink-500 dark:text-ink-400",
  exit: "text-ink-500 dark:text-ink-400",
  usage: "text-emerald-700 dark:text-emerald-300",
};

const ALL_KINDS: Kind[] = [
  "message",
  "tool_call",
  "tool_result",
  "permission_request",
  "status",
  "exit",
  "usage",
];

function renderEvent(ev: AgentEvent): { primary: string; secondary?: string } {
  switch (ev.kind) {
    case "message": {
      const text = (ev.text || "").replace(/\s+/g, " ").trim();
      return {
        primary: text.length > 280 ? text.slice(0, 277) + "…" : text,
        secondary: ev.role,
      };
    }
    case "tool_call":
      return {
        primary: ev.tool,
        secondary: JSON.stringify(ev.args).slice(0, 120),
      };
    case "tool_result":
      return {
        primary: `${ev.tool} ${ev.ok ? "ok" : "err"}`,
        secondary: String(ev.output).slice(0, 200),
      };
    case "permission_request":
      return { primary: ev.tool, secondary: "awaiting decision" };
    case "status":
      return { primary: ev.status };
    case "exit":
      return { primary: `code ${ev.code ?? "?"}` };
    case "usage": {
      const tok = (ev.inputTokens ?? 0) + (ev.outputTokens ?? 0);
      const cost =
        ev.costUsd != null ? `$${ev.costUsd.toFixed(4)}` : "";
      return { primary: `${tok} tok ${cost}`.trim() };
    }
    case "raw":
      return { primary: ev.text.slice(0, 200) };
  }
}

export function Activity() {
  const client = useClient();
  const tasksQ = useTasks();
  const [events, setEvents] = useState<FlatEvent[]>([]);
  const [live, setLive] = useState(false);
  const [paused, setPaused] = useState(false);
  const [enabledKinds, setEnabledKinds] = useState<Set<Kind>>(
    () => new Set(ALL_KINDS),
  );
  const [taskFilter, setTaskFilter] = useState<string>("all");

  const meta = useRef(new Map<string, { title: string; agent: "claude" | "codex" }>());
  useEffect(() => {
    const m = meta.current;
    for (const t of tasksQ.data?.tasks ?? []) {
      m.set(t.id, { title: t.title, agent: t.agent });
    }
  }, [tasksQ.data]);

  // WS firehose.
  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const open = () => {
      ws = client.watch(null, (msg: WsServerEvent) => {
        if (msg.type !== "event") return;
        const m = meta.current.get(msg.taskId);
        const r = renderEvent(msg.event);
        const e: FlatEvent = {
          id: `${msg.taskId}-${msg.ts}-${Math.random().toString(36).slice(2, 6)}`,
          taskId: msg.taskId,
          taskTitle: m?.title ?? "task",
          taskAgent: m?.agent ?? "claude",
          kind: msg.event.kind,
          ts: msg.ts,
          primary: r.primary,
          secondary: r.secondary,
        };
        setEvents((prev) => [e, ...prev].slice(0, 500));
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

  const filtered = useMemo(() => {
    return events.filter((e) => {
      if (!enabledKinds.has(e.kind)) return false;
      if (taskFilter !== "all" && e.taskId !== taskFilter) return false;
      return true;
    });
  }, [events, enabledKinds, taskFilter]);

  const toggleKind = useCallback((k: Kind) => {
    setEnabledKinds((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }, []);

  const taskOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const e of events) {
      if (!seen.has(e.taskId)) seen.set(e.taskId, e.taskTitle);
    }
    return [...seen.entries()].slice(0, 20);
  }, [events]);

  const counts = useMemo(() => {
    const c: Record<Kind, number> = {
      message: 0,
      tool_call: 0,
      tool_result: 0,
      permission_request: 0,
      status: 0,
      raw: 0,
      exit: 0,
      usage: 0,
    };
    for (const e of events) c[e.kind] += 1;
    return c;
  }, [events]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header band */}
      <div className="border-b border-ink-900/10 dark:border-ink-50/10 px-6 lg:px-10 py-6">
        <div className="mx-auto max-w-6xl">
          <div className="flex items-end justify-between gap-4 mb-3">
            <div>
              <div className="label-section mb-2">Observe</div>
              <h1 className="display text-4xl text-ink-900 dark:text-ink-50">
                Activity
              </h1>
              <p className="mt-1 max-w-2xl text-sm text-ink-500 dark:text-ink-400">
                Cross-task event firehose. {events.length} events in buffer.
              </p>
            </div>
            <div className="flex items-center gap-2">
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
                      ? paused
                        ? "bg-amber-500"
                        : "bg-vermilion-500 animate-blink"
                      : "bg-ink-300 dark:bg-ink-600",
                  )}
                />
                {!live ? "off" : paused ? "paused" : "live"}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPaused((p) => !p)}
              >
                {paused ? (
                  <Play className="h-3.5 w-3.5" />
                ) : (
                  <Pause className="h-3.5 w-3.5" />
                )}
                {paused ? "Resume" : "Pause"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setEvents([])}
                disabled={events.length === 0}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Clear
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {ALL_KINDS.map((k) => {
              const on = enabledKinds.has(k);
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => toggleKind(k)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-2xs uppercase tracking-[0.06em] transition-colors",
                    on
                      ? "border-ink-900/15 bg-ink-900/[0.05] text-ink-900 dark:border-ink-50/15 dark:bg-ink-50/[0.05] dark:text-ink-50"
                      : "border-ink-900/10 bg-transparent text-ink-400 hover:bg-ink-900/[0.03] dark:border-ink-50/10 dark:text-ink-500 dark:hover:bg-ink-50/[0.03]",
                  )}
                >
                  {KIND_LABEL[k]}
                  <span className="font-mono text-2xs text-ink-400 dark:text-ink-500">
                    {counts[k] || 0}
                  </span>
                </button>
              );
            })}

            <div className="ml-auto flex items-center gap-2">
              <span className="font-mono text-2xs uppercase tracking-[0.12em] text-ink-400 dark:text-ink-500">
                task
              </span>
              <select
                value={taskFilter}
                onChange={(e) => setTaskFilter(e.target.value)}
                className="h-7 rounded-md border border-ink-900/15 bg-cream-50 px-2 font-mono text-xs text-ink-900 dark:border-ink-50/15 dark:bg-ink-800 dark:text-ink-50"
              >
                <option value="all">all</option>
                {taskOptions.map(([id, title]) => (
                  <option key={id} value={id}>
                    {title.slice(0, 30)} ({shortId(id)})
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </div>

      {/* Event stream */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-6 lg:px-10 py-4">
          {filtered.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-ink-900/10 dark:border-ink-50/10 px-5 py-16 text-center">
              <p className="text-sm text-ink-500 dark:text-ink-400">
                {events.length === 0
                  ? live
                    ? "Waiting for events…"
                    : "Connecting…"
                  : "No events match the current filter."}
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-ink-900/10 dark:divide-ink-50/10">
              {filtered.map((e) => (
                <li
                  key={e.id}
                  className="grid grid-cols-[80px_120px_1fr] items-baseline gap-3 py-2.5"
                >
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="font-mono text-2xs uppercase tracking-[0.06em] text-ink-400 dark:text-ink-500 cursor-help">
                          {formatTs(e.ts)}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>{formatTsAbsolute(e.ts)}</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>

                  <Link
                    to={`/tasks/${e.taskId}`}
                    className="truncate text-xs text-ink-900 hover:text-vermilion-600 dark:text-ink-50 dark:hover:text-vermilion-400"
                    title={e.taskTitle}
                  >
                    <span className="font-medium">{e.taskTitle}</span>
                  </Link>

                  <div className="min-w-0 flex flex-wrap items-baseline gap-2">
                    <span
                      className={cn(
                        "shrink-0 font-mono text-2xs uppercase tracking-[0.06em]",
                        KIND_TONE[e.kind],
                      )}
                    >
                      {KIND_LABEL[e.kind]}
                    </span>
                    <span className="text-sm text-ink-700 dark:text-ink-200 break-words">
                      {e.primary}
                    </span>
                    {e.secondary && (
                      <span className="font-mono text-2xs text-ink-400 dark:text-ink-500 break-words">
                        {e.secondary}
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
