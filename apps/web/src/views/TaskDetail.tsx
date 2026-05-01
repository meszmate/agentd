import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  CheckSquare,
  ExternalLink,
  MoreHorizontal,
  PanelRight,
  PanelRightClose,
  RotateCcw,
  Square,
  Trash2,
} from "lucide-react";
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
} from "react-resizable-panels";
import type { AgentEvent, Message, Task } from "@agentd/contracts";
import { Button } from "@/components/ui/button";
import {
  PageTopbar,
  Spacer,
  VRule,
} from "@/components/ui/page-topbar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  qk,
  useRemoveTask,
  useStopTask,
  useTask,
  useTaskStream,
} from "@/queries";
import { useApp, useClient } from "@/AppContext";
import {
  cn,
  formatCost,
  formatTokens,
  shortId,
} from "@/lib/utils";
import { TaskTimeline } from "@/views/TaskTimeline";
import { TaskWorkspace } from "@/views/TaskWorkspace";
import { ShipMenu } from "@/components/ship-menu";
import type { TaskPlanItem } from "@/views/TaskPlan";

const WORKSPACE_OPEN_KEY = "agentd.task.workspaceOpen";

export function TaskDetail({ task }: { task: Task }) {
  const navigate = useNavigate();
  const { toast } = useApp();
  const onError = useCallback((m: string) => toast(m, true), [toast]);

  const taskQ = useTask(task.id);
  const stop = useStopTask(task.id);
  const remove = useRemoveTask();
  const qc = useQueryClient();

  const [messages, setMessages] = useState<Message[]>([]);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [lastToolHint, setLastToolHint] = useState<string | null>(null);
  /**
   * In-flight streaming bubbles — one per content-block. Accumulates
   * `message_delta` events into the bubble's text; `message_end` removes
   * the bubble (the final committed text arrives via the regular
   * `message` event right after).
   */
  const [streams, setStreams] = useState<Record<string, string>>({});
  /**
   * Latest TodoWrite / update_plan snapshot from the agent. Replaced
   * wholesale on each tool call (those tools always send the full plan,
   * not deltas).
   */
  const [plan, setPlan] = useState<TaskPlanItem[]>([]);
  const [planUpdatedAt, setPlanUpdatedAt] = useState<number | null>(null);
  const [workspaceOpen, setWorkspaceOpen] = useState<boolean>(() => {
    const v = localStorage.getItem(WORKSPACE_OPEN_KEY);
    return v == null ? true : v === "1";
  });

  useEffect(() => {
    localStorage.setItem(WORKSPACE_OPEN_KEY, workspaceOpen ? "1" : "0");
  }, [workspaceOpen]);

  useEffect(() => {
    if (loadedFor === task.id) return;
    if (!taskQ.data) return;
    setMessages(taskQ.data.messages);
    setLoadedFor(task.id);
  }, [task.id, taskQ.data, loadedFor]);

  const appendLocal = useCallback(
    (role: Message["role"], content: string) => {
      setMessages((prev) => [
        ...prev,
        {
          id: "tmp_" + Math.random().toString(36).slice(2),
          taskId: task.id,
          role,
          content,
          ts: Date.now(),
        },
      ]);
    },
    [task.id],
  );

  const handleEvent = useCallback(
    ({
      event,
      taskId: evTaskId,
    }: {
      taskId: string;
      event: AgentEvent;
      ts: number;
    }) => {
      if (evTaskId !== task.id) return;
      if (event.kind === "message") {
        appendLocal(event.role, event.text);
        setLastToolHint(null);
      } else if (event.kind === "message_delta") {
        setStreams((prev) => ({
          ...prev,
          [event.streamId]: (prev[event.streamId] ?? "") + event.delta,
        }));
      } else if (event.kind === "message_end") {
        setStreams((prev) => {
          if (!(event.streamId in prev)) return prev;
          const next = { ...prev };
          delete next[event.streamId];
          return next;
        });
      } else if (event.kind === "tool_call") {
        // Intercept the agent's plan tools — render them as a structured
        // checklist instead of a wall of JSON. Both Claude (TodoWrite)
        // and Codex (update_plan) send the full snapshot per call.
        const planItems = parsePlan(event.tool, event.args);
        if (planItems) {
          setPlan(planItems);
          setPlanUpdatedAt(Date.now());
          setLastToolHint(`✓ plan · ${planItems.length} item${planItems.length === 1 ? "" : "s"}`);
          // Don't litter the timeline with the raw JSON for plan tools.
          return;
        }
        const args =
          typeof event.args === "object" && event.args
            ? Object.entries(event.args)
                .slice(0, 1)
                .map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 40)}`)
                .join(" ")
            : "";
        setLastToolHint(`→ ${event.tool}${args ? " " + args : ""}`);
        appendLocal(
          "tool",
          `[${event.tool}] ${JSON.stringify(event.args).slice(0, 400)}`,
        );
      } else if (event.kind === "tool_result") {
        appendLocal(
          "tool",
          `[${event.tool}] ${event.ok ? "ok" : "err"}: ${String(
            event.output,
          ).slice(0, 400)}`,
        );
      } else if (event.kind === "raw") {
        appendLocal("system", event.text);
      } else if (
        event.kind === "status" ||
        event.kind === "exit" ||
        event.kind === "usage"
      ) {
        if (event.kind === "exit" || event.kind === "status") {
          setLastToolHint(null);
        }
        void qc.invalidateQueries({ queryKey: qk.tasks() });
        void qc.invalidateQueries({ queryKey: qk.task(task.id) });
      }
    },
    [task.id, qc, appendLocal],
  );

  const { live } = useTaskStream(task.id, handleEvent);

  const totalTokens = useMemo(
    () => (task.totalInputTokens ?? 0) + (task.totalOutputTokens ?? 0),
    [task.totalInputTokens, task.totalOutputTokens],
  );
  const isTerminal =
    task.status === "done" ||
    task.status === "failed" ||
    task.status === "stopped";
  // The chat input should ONLY be locked while the agent is mid-turn —
  // a finished task can be continued via `--continue` (the daemon spawns
  // a fresh runner inside sendInput).
  const isRunning =
    task.status === "running" ||
    task.status === "waiting_input" ||
    task.status === "waiting_perm";

  const onStop = async () => {
    try {
      await stop.mutateAsync();
      toast("Task stopped");
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const onRemove = async () => {
    if (!confirm(`Remove task "${task.title}" and its worktree?`)) return;
    try {
      await remove.mutateAsync(task.id);
      navigate("/tasks", { replace: true });
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const client = useClient();
  const onClose = async (reason: string) => {
    try {
      await client.closeTask(task.id, reason);
      void qc.invalidateQueries({ queryKey: qk.tasks() });
      void qc.invalidateQueries({ queryKey: qk.task(task.id) });
      toast(`Task closed (${reason})`);
    } catch (e) {
      onError((e as Error).message);
    }
  };
  const onReopen = async () => {
    try {
      await client.reopenTask(task.id);
      void qc.invalidateQueries({ queryKey: qk.tasks() });
      void qc.invalidateQueries({ queryKey: qk.task(task.id) });
      toast("Task reopened");
    } catch (e) {
      onError((e as Error).message);
    }
  };
  const onCheckMerged = async () => {
    try {
      const r = await client.checkPrState(task.id, true);
      if (!r.prUrl) {
        toast("No PR linked to this task", true);
        return;
      }
      if (r.merged) {
        toast(`PR is merged · task ${r.autoClosed ? "auto-closed" : "still open"}`);
        void qc.invalidateQueries({ queryKey: qk.task(task.id) });
        void qc.invalidateQueries({ queryKey: qk.tasks() });
      } else {
        toast(`PR state: ${r.state ?? "unknown"} (not merged)`);
      }
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const statusTone =
    task.status === "running"
      ? "bg-ember-500/10 text-ember-700 dark:text-ember-300"
      : task.status === "done"
      ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
      : task.status === "failed"
      ? "bg-red-500/10 text-red-700 dark:text-red-300"
      : task.status === "waiting_input" || task.status === "waiting_perm"
      ? "bg-amber-500/10 text-amber-700 dark:text-amber-300"
      : "bg-ink-900/[0.05] text-ink-500 dark:bg-ink-50/[0.05] dark:text-ink-400";

  return (
    <div className="flex h-full flex-col">
      {/* h-12 detail topbar */}
      <PageTopbar>
        <Link
          to="/tasks"
          className="text-[11px] text-ink-400 hover:text-ink-900 transition-colors dark:hover:text-ink-50"
        >
          ← Tasks
        </Link>
        <VRule />
        <span className="text-[13px] text-ink-900 dark:text-ink-50 font-medium truncate max-w-[44ch]">
          {task.title}
        </span>
        <span
          className={cn(
            "shrink-0 inline-flex items-center h-5 px-1.5 rounded font-mono text-[10px] font-medium uppercase tracking-[0.08em]",
            statusTone,
          )}
        >
          {task.status}
        </span>
        {task.closedAt && (
          <span
            className="shrink-0 inline-flex items-center gap-1 h-5 px-1.5 rounded font-mono text-[10px] font-medium uppercase tracking-[0.08em] bg-ink-900/[0.05] text-ink-500 dark:bg-ink-50/[0.05] dark:text-ink-400"
            title={`closed ${new Date(task.closedAt).toLocaleString()}${task.closedReason ? ` (${task.closedReason})` : ""}`}
          >
            <CheckSquare className="h-3 w-3" />
            closed{task.closedReason ? ` · ${task.closedReason}` : ""}
          </span>
        )}
        <LiveBadge live={live} terminal={isTerminal} />

        <Spacer />

        {/* stats */}
        <ContextUsage totalTokens={totalTokens} />
        <span className="hidden md:flex items-center gap-3 font-mono text-[11px] tabular-nums text-ink-400 dark:text-ink-500">
          <span>{formatTokens(totalTokens)} tok</span>
          <span>{formatCost(task.totalCostUsd)}</span>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="cursor-help">{shortId(task.id)}</span>
              </TooltipTrigger>
              <TooltipContent>
                <span className="font-mono text-[10px]">{task.id}</span>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </span>

        {task.prUrl && (
          <Button asChild variant="outline" size="xs">
            <a href={task.prUrl} target="_blank" rel="noreferrer">
              <ExternalLink className="h-3 w-3" /> PR
            </a>
          </Button>
        )}
        <ShipMenu task={task} />
        {!isTerminal && (
          <Button
            variant="outline"
            size="xs"
            onClick={onStop}
            disabled={stop.isPending}
          >
            <Square className="h-3 w-3" /> Stop
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setWorkspaceOpen((v) => !v)}
          aria-label={workspaceOpen ? "Hide workspace" : "Show workspace"}
          title={workspaceOpen ? "Hide workspace" : "Show workspace"}
        >
          {workspaceOpen ? (
            <PanelRightClose className="h-3.5 w-3.5" />
          ) : (
            <PanelRight className="h-3.5 w-3.5" />
          )}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="More">
              <MoreHorizontal className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[14rem]">
            <DropdownMenuLabel>Task</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {task.closedAt ? (
              <DropdownMenuItem onClick={onReopen}>
                <RotateCcw /> Reopen
              </DropdownMenuItem>
            ) : (
              <>
                <DropdownMenuItem onClick={() => onClose("merged")}>
                  <CheckSquare /> Close · merged
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onClose("abandoned")}>
                  <CheckSquare /> Close · abandoned
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onClose("manual")}>
                  <CheckSquare /> Close · manual
                </DropdownMenuItem>
                {task.prUrl && (
                  <DropdownMenuItem onClick={onCheckMerged}>
                    <ExternalLink /> Check PR merged → auto-close
                  </DropdownMenuItem>
                )}
              </>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={onRemove}
              className="text-red-700 focus:text-red-700 dark:text-red-300 dark:focus:text-red-300"
            >
              <Trash2 /> Remove + worktree
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </PageTopbar>

      {/* Sub-strip: branch, repo, base */}
      <div className="flex h-9 items-center gap-3 px-5 border-b border-ink-900/[0.06] dark:border-ink-50/[0.06] bg-paper-50 dark:bg-ink-900 shrink-0 overflow-x-auto">
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-400 dark:text-ink-500 shrink-0">
          {task.agent}
        </span>
        <span className="text-ink-300 dark:text-ink-600 shrink-0">·</span>
        <span className="font-mono text-[11px] text-ink-700 dark:text-ink-200 shrink-0">
          {task.branch}
        </span>
        <span className="font-mono text-[10px] text-ink-400 dark:text-ink-500 shrink-0">
          ← {task.baseBranch}
        </span>
        <span className="text-ink-300 dark:text-ink-600 shrink-0">·</span>
        <span className="font-mono text-[11px] text-ink-500 dark:text-ink-400 truncate">
          {task.repoPath}
        </span>
        {(task.skills?.length ?? 0) > 0 && (
          <>
            <span className="text-ink-300 dark:text-ink-600 shrink-0">·</span>
            <div className="flex items-center gap-1 shrink-0">
              {task.skills!.map((id) => (
                <span
                  key={id}
                  title={id}
                  className="inline-flex items-center gap-1 h-5 px-1.5 rounded font-mono text-[10px] uppercase tracking-[0.06em] bg-ember-500/10 text-ember-700 dark:text-ember-300 border border-ember-500/20"
                >
                  ◆ {id.split(":")[1]}
                </span>
              ))}
            </div>
          </>
        )}
        {task.permissionMode && task.permissionMode !== "bypassPermissions" && (
          <>
            <span className="text-ink-300 dark:text-ink-600 shrink-0">·</span>
            <span
              title={
                task.permissionMode === "plan"
                  ? "read-only — agent cannot modify files"
                  : "auto-allow file edits, refuse other tools"
              }
              className="inline-flex items-center gap-1 h-5 px-1.5 rounded font-mono text-[10px] uppercase tracking-[0.06em] bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-500/20 shrink-0"
            >
              {task.permissionMode === "plan" ? "plan" : "accept-edits"}
            </span>
          </>
        )}
        <span className="text-ink-300 dark:text-ink-600 shrink-0">·</span>
        <ThinkingLevelChip task={task} />
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0">
        {workspaceOpen ? (
          <PanelGroup direction="horizontal" className="h-full">
            <Panel id={`tl-${task.id}`} defaultSize={52} minSize={32}>
              <TaskTimeline
                taskId={task.id}
                messages={messages}
                appendLocal={appendLocal}
                onError={onError}
                disabled={isRunning}
                lastToolHint={lastToolHint}
                streams={streams}
                totalTokens={totalTokens}
              />
            </Panel>
            <PanelResizeHandle className="w-px bg-ink-900/10 hover:bg-ember-500/40 transition-colors dark:bg-ink-50/10" />
            <Panel id={`ws-${task.id}`} defaultSize={48} minSize={28}>
              <TaskWorkspace task={task} onError={onError} plan={plan} planUpdatedAt={planUpdatedAt} />
            </Panel>
          </PanelGroup>
        ) : (
          <TaskTimeline
            taskId={task.id}
            messages={messages}
            appendLocal={appendLocal}
            onError={onError}
            disabled={isRunning}
                lastToolHint={lastToolHint}
                streams={streams}
                totalTokens={totalTokens}
          />
        )}
      </div>
    </div>
  );
}

const THINKING_LEVELS = [
  { value: "low", label: "low", hint: "fastest, minimal reasoning" },
  { value: "medium", label: "medium", hint: "balanced" },
  { value: "high", label: "high", hint: "default" },
  { value: "max", label: "max", hint: "extended thinking budget" },
  { value: "xhigh", label: "xhigh", hint: "deepest tier" },
] as const;

type ThinkingLevelValue = (typeof THINKING_LEVELS)[number]["value"];

/**
 * Inline thinking-level dropdown on the task header. Mutating it does NOT
 * interrupt the in-flight turn — the new level applies to the next runner
 * spawn (next user message or steered queue drain).
 */
function ThinkingLevelChip({ task }: { task: Task }) {
  const client = useClient();
  const qc = useQueryClient();
  const { toast } = useApp();
  const current = (task.thinkingLevel ?? "high") as ThinkingLevelValue;
  const set = async (level: ThinkingLevelValue) => {
    if (level === current) return;
    try {
      const res = await client.setTaskThinkingLevel(task.id, level);
      if (res.task) {
        qc.setQueryData(qk.task(task.id), { task: res.task });
      }
      toast(`thinking → ${level} (applies next turn)`);
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title="Change reasoning effort for the next turn"
          className="inline-flex items-center gap-1 h-5 px-1.5 rounded font-mono text-[10px] uppercase tracking-[0.06em] bg-violet-500/10 text-violet-700 dark:text-violet-300 border border-violet-500/20 hover:bg-violet-500/20 transition-colors shrink-0"
        >
          think:{current}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-44">
        <DropdownMenuLabel className="text-[10px] uppercase tracking-[0.12em]">
          Thinking · next turn
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {THINKING_LEVELS.map((m) => (
          <DropdownMenuItem
            key={m.value}
            onClick={() => void set(m.value)}
            className={cn(
              "flex items-baseline justify-between gap-2",
              m.value === current && "text-ember-700 dark:text-ember-300",
            )}
          >
            <span className="font-mono">{m.label}</span>
            <span className="text-[10px] text-ink-400 dark:text-ink-500">
              {m.hint}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function LiveBadge({ live, terminal }: { live: boolean; terminal: boolean }) {
  if (terminal) {
    return (
      <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-400 dark:text-ink-500">
        closed
      </span>
    );
  }
  return (
    <span
      className={cn(
        "flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.08em]",
        live
          ? "text-ember-700 dark:text-ember-300"
          : "text-ink-400 dark:text-ink-500",
      )}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          live
            ? "bg-ember-500 animate-blink"
            : "bg-ink-300 dark:bg-ink-600",
        )}
      />
      {live ? "live" : "off"}
    </span>
  );
}

function ContextUsage({ totalTokens }: { totalTokens: number }) {
  const window = 200_000;
  const pct = Math.min(100, Math.round((totalTokens / window) * 100));
  const tone =
    pct >= 80 ? "danger" : pct >= 60 ? "warn" : "ok";
  const dot =
    tone === "danger"
      ? "bg-red-500 animate-blink"
      : tone === "warn"
      ? "bg-amber-500"
      : "bg-emerald-500";
  const text =
    tone === "danger"
      ? "text-red-700 dark:text-red-300"
      : tone === "warn"
      ? "text-amber-700 dark:text-amber-300"
      : "text-ink-400 dark:text-ink-500";
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              "hidden md:inline-flex items-center gap-1.5 font-mono text-[10px] tabular-nums uppercase tracking-[0.06em] cursor-help",
              text,
            )}
          >
            <span className={cn("h-1.5 w-1.5 rounded-full", dot)} />
            ctx {pct}%
          </span>
        </TooltipTrigger>
        <TooltipContent>
          <span className="font-mono text-[10px]">
            {totalTokens.toLocaleString()} / {window.toLocaleString()} ·
            open the Context tab to compact
          </span>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * Normalize a plan-tool call's args into a TaskPlanItem[]. Returns null
 * for tools that aren't plan tools, so the caller can fall through to
 * the generic tool_call rendering. Lenient about shape so Codex's
 * update_plan and other agent dialects don't all need bespoke parsers.
 */
function parsePlan(tool: string, args: unknown): TaskPlanItem[] | null {
  if (
    tool !== "TodoWrite" &&
    tool !== "todo_write" &&
    tool !== "update_plan" &&
    tool !== "UpdatePlan" &&
    tool !== "Plan"
  ) {
    return null;
  }
  if (!args || typeof args !== "object") return null;
  const a = args as Record<string, unknown>;
  // Try common keys for the array of items.
  const list =
    (Array.isArray(a.todos) && (a.todos as unknown[])) ||
    (Array.isArray(a.plan) && (a.plan as unknown[])) ||
    (Array.isArray(a.items) && (a.items as unknown[])) ||
    null;
  if (!list) return null;
  const out: TaskPlanItem[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const content = String(r.content ?? r.step ?? r.task ?? r.title ?? "").trim();
    if (!content) continue;
    const rawStatus = String(r.status ?? r.state ?? "pending").toLowerCase();
    const status: TaskPlanItem["status"] =
      rawStatus === "completed" ||
      rawStatus === "done" ||
      rawStatus === "complete"
        ? "completed"
        : rawStatus === "in_progress" ||
            rawStatus === "in-progress" ||
            rawStatus === "active" ||
            rawStatus === "running"
          ? "in_progress"
          : "pending";
    const item: TaskPlanItem = { content, status };
    if (typeof r.activeForm === "string" && r.activeForm) {
      item.activeForm = r.activeForm;
    }
    out.push(item);
  }
  return out;
}
