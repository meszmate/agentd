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
import {
  Count,
  Kicker,
  PageTopbar,
  Spacer,
  VRule,
} from "@/components/ui/page-topbar";
import { useClient } from "@/AppContext";
import { useTasks } from "@/queries";
import { useNavigate } from "react-router-dom";
import { useVimList } from "@/lib/useVimList";
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
  primary: string;
  secondary?: string;
}

const KIND_LABEL: Record<Kind, string> = {
  message: "msg",
  message_delta: "δ",
  message_end: "/δ",
  tool_input_delta: "→δ",
  tool_call: "→ tool",
  tool_result: "← tool",
  permission_request: "perm",
  status: "status",
  raw: "raw",
  exit: "exit",
  usage: "usage",
  queue_updated: "queue",
  progress: "step",
  share: "💭 share",
  ask: "❓ ask",
  answer: "↳ answer",
  todos_updated: "todos",
};

const KIND_TONE: Record<Kind, string> = {
  message: "text-ink-700 dark:text-ink-200",
  message_delta: "text-ink-400 dark:text-ink-500",
  message_end: "text-ink-400 dark:text-ink-500",
  tool_input_delta: "text-ink-400 dark:text-ink-500",
  tool_call: "text-sky-700 dark:text-sky-300",
  tool_result: "text-sky-700 dark:text-sky-300",
  permission_request: "text-amber-700 dark:text-amber-300",
  status: "text-ember-700 dark:text-ember-300",
  raw: "text-ink-500 dark:text-ink-400",
  exit: "text-ink-500 dark:text-ink-400",
  usage: "text-emerald-700 dark:text-emerald-300",
  queue_updated: "text-violet-700 dark:text-violet-300",
  progress: "text-violet-700 dark:text-violet-300",
  share: "text-violet-700 dark:text-violet-300",
  ask: "text-amber-700 dark:text-amber-300",
  answer: "text-amber-700 dark:text-amber-300",
  todos_updated: "text-violet-700 dark:text-violet-300",
};

const ALL_KINDS: Kind[] = [
  "message",
  "progress",
  "share",
  "ask",
  "answer",
  "tool_call",
  "tool_result",
  "permission_request",
  "status",
  "exit",
  "usage",
  "queue_updated",
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
    case "message_delta":
      return { primary: ev.delta.slice(0, 80), secondary: ev.streamId };
    case "message_end":
      return { primary: "stream done", secondary: ev.streamId };
    case "tool_input_delta":
      return { primary: ev.delta.slice(0, 80), secondary: ev.toolName };
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
      const cost = ev.costUsd != null ? `$${ev.costUsd.toFixed(4)}` : "";
      return { primary: `${tok} tok ${cost}`.trim() };
    }
    case "raw":
      return { primary: ev.text.slice(0, 200) };
    case "progress":
      return {
        primary: ev.done ? `✓ done · ${ev.text}` : `↻ ${ev.text}`,
      };
    case "share":
      return { primary: ev.text };
    case "ask": {
      const opts =
        ev.options.length > 0
          ? ev.options.map((o, i) => `${i + 1}) ${o}`).join("  ")
          : "";
      return { primary: ev.prompt, secondary: opts };
    }
    case "answer":
      return { primary: ev.answer };
    case "queue_updated":
      return { primary: `${ev.queue.length} queued` };
    case "todos_updated":
      return { primary: "todos updated" };
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
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const meta = useRef(new Map<string, { title: string; agent: "claude" | "codex" }>());
  useEffect(() => {
    const m = meta.current;
    for (const t of tasksQ.data?.tasks ?? []) {
      m.set(t.id, { title: t.title, agent: t.agent });
    }
  }, [tasksQ.data]);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const open = () => {
      ws = client.watch(null, (msg: WsServerEvent) => {
        if (msg.type !== "event") return;
        if (pausedRef.current) return;
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

  const filtered = useMemo(
    () =>
      events.filter((e) => {
        if (!enabledKinds.has(e.kind)) return false;
        if (taskFilter !== "all" && e.taskId !== taskFilter) return false;
        return true;
      }),
    [events, enabledKinds, taskFilter],
  );

  const navigate = useNavigate();
  const { isFocused, rowRef } = useVimList(filtered.length, (i) => {
    const e = filtered[i];
    if (e) navigate(`/tasks/${e.taskId}`);
  });

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
      message_delta: 0,
      message_end: 0,
      tool_input_delta: 0,
      tool_call: 0,
      tool_result: 0,
      permission_request: 0,
      status: 0,
      raw: 0,
      exit: 0,
      usage: 0,
      queue_updated: 0,
      progress: 0,
      share: 0,
      ask: 0,
      answer: 0,
      todos_updated: 0,
    };
    for (const e of events) c[e.kind] += 1;
    return c;
  }, [events]);

  return (
    <div className="flex h-full flex-col">
      <PageTopbar>
        <Kicker>observe</Kicker>
        <VRule />
        <span className="text-[13px] text-ink-900 dark:text-ink-50 font-medium">
          Activity
        </span>
        <Count>{events.length}</Count>
        <span className="text-ink-300 dark:text-ink-600">·</span>
        <span
          className={cn(
            "flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em]",
            !live
              ? "text-ink-400 dark:text-ink-500"
              : paused
              ? "text-amber-700 dark:text-amber-300"
              : "text-ember-700 dark:text-ember-300",
          )}
        >
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              !live
                ? "bg-ink-300 dark:bg-ink-600"
                : paused
                ? "bg-amber-500"
                : "bg-ember-500 animate-blink",
            )}
          />
          {!live ? "off" : paused ? "paused" : "live"}
        </span>
        <Spacer />
        <Button
          variant="outline"
          size="xs"
          onClick={() => setPaused((p) => !p)}
        >
          {paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
          {paused ? "Resume" : "Pause"}
        </Button>
        <Button
          variant="outline"
          size="xs"
          onClick={() => setEvents([])}
          disabled={events.length === 0}
        >
          <Trash2 className="h-3 w-3" />
          Clear
        </Button>
      </PageTopbar>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2 px-5 py-2 border-b border-ink-900/10 dark:border-ink-50/10 bg-paper-50 dark:bg-ink-900 shrink-0">
        {ALL_KINDS.map((k) => {
          const on = enabledKinds.has(k);
          return (
            <button
              key={k}
              type="button"
              onClick={() => toggleKind(k)}
              className={cn(
                "inline-flex items-center gap-1.5 h-6 px-2 rounded-md font-mono text-[10px] uppercase tracking-[0.06em] transition-colors",
                on
                  ? "bg-ink-900/[0.06] text-ink-900 dark:bg-ink-50/[0.06] dark:text-ink-50"
                  : "text-ink-400 hover:bg-ink-900/[0.03] dark:text-ink-500 dark:hover:bg-ink-700",
              )}
            >
              {KIND_LABEL[k]}
              <span className="font-mono tabular-nums text-[10px] text-ink-400 dark:text-ink-500">
                {counts[k] || 0}
              </span>
            </button>
          );
        })}
        <div className="ml-auto flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-400 dark:text-ink-500">
            task
          </span>
          <select
            value={taskFilter}
            onChange={(e) => setTaskFilter(e.target.value)}
            className="h-6 rounded-md border border-ink-900/10 bg-paper-50 px-2 font-mono text-[11px] text-ink-900 dark:border-ink-50/10 dark:bg-ink-800 dark:text-ink-50 focus:outline-none focus:border-ink-900/30"
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

      {/* Stream */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[12px] text-ink-500 dark:text-ink-400">
            {events.length === 0
              ? live
                ? "Waiting for events…"
                : "Connecting…"
              : "No events match the current filter."}
          </div>
        ) : (
          <ul className="divide-y divide-ink-900/[0.06] dark:divide-ink-50/[0.06]">
            {filtered.map((e, i) => (
              <li
                key={e.id}
                ref={rowRef(i)}
                className={cn(
                  "grid grid-cols-[60px_180px_80px_1fr] items-baseline gap-3 px-5 py-2 hover:bg-paper-100 transition-colors dark:hover:bg-ink-700",
                  isFocused(i) &&
                    "bg-ember-500/[0.08] dark:bg-ember-500/[0.12] relative before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-ember-500",
                )}
              >
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-400 dark:text-ink-500 cursor-help">
                        {formatTs(e.ts)}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      {formatTsAbsolute(e.ts)}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>

                <Link
                  to={`/tasks/${e.taskId}`}
                  className="truncate text-[12px] font-medium text-ink-900 hover:text-ember-600 dark:text-ink-50 dark:hover:text-ember-400"
                  title={e.taskTitle}
                >
                  {e.taskTitle}
                </Link>

                <span
                  className={cn(
                    "shrink-0 font-mono text-[10px] uppercase tracking-[0.06em]",
                    KIND_TONE[e.kind],
                  )}
                >
                  {KIND_LABEL[e.kind]}
                </span>

                <div className="min-w-0">
                  <span className="text-[12px] text-ink-700 dark:text-ink-200 break-words">
                    {e.primary}
                  </span>
                  {e.secondary && (
                    <span className="ml-2 font-mono text-[10px] text-ink-400 dark:text-ink-500 break-words">
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
  );
}
