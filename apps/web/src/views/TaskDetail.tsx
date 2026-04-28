import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  ExternalLink,
  MoreHorizontal,
  PanelRight,
  PanelRightClose,
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
import { useApp } from "@/AppContext";
import {
  cn,
  formatCost,
  formatTokens,
  shortId,
} from "@/lib/utils";
import { TaskTimeline } from "@/views/TaskTimeline";
import { TaskWorkspace } from "@/views/TaskWorkspace";

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
      } else if (event.kind === "tool_call") {
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

  const statusTone =
    task.status === "running"
      ? "bg-vermilion-500/10 text-vermilion-700 dark:text-vermilion-300"
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
        <LiveBadge live={live} terminal={isTerminal} />

        <Spacer />

        {/* stats */}
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
          <DropdownMenuContent align="end" className="min-w-[12rem]">
            <DropdownMenuLabel>Task</DropdownMenuLabel>
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
      <div className="flex h-9 items-center gap-3 px-5 border-b border-ink-900/[0.06] dark:border-ink-50/[0.06] bg-cream-100/30 dark:bg-ink-50/[0.015] shrink-0 overflow-x-auto">
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
                disabled={isTerminal}
              />
            </Panel>
            <PanelResizeHandle className="w-px bg-ink-900/10 hover:bg-vermilion-500/40 transition-colors dark:bg-ink-50/10" />
            <Panel id={`ws-${task.id}`} defaultSize={48} minSize={28}>
              <TaskWorkspace task={task} onError={onError} />
            </Panel>
          </PanelGroup>
        ) : (
          <TaskTimeline
            taskId={task.id}
            messages={messages}
            appendLocal={appendLocal}
            onError={onError}
            disabled={isTerminal}
          />
        )}
      </div>
    </div>
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
          ? "text-vermilion-700 dark:text-vermilion-300"
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
  );
}
