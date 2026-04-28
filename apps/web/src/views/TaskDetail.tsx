import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ExternalLink,
  GitBranch,
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
import { Badge } from "@/components/ui/badge";
import { StatusPill } from "@/components/ui/status-dot";
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

  return (
    <div className="flex h-full flex-col">
      {/* Detail header */}
      <header className="border-b border-ink-900/10 dark:border-ink-50/10 px-6 py-4 shrink-0">
        <div className="flex items-center gap-3">
          <Link
            to="/tasks"
            className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 font-mono text-2xs uppercase tracking-[0.12em] text-ink-500 transition-colors hover:bg-ink-900/[0.04] hover:text-ink-900 dark:text-ink-400 dark:hover:bg-ink-50/[0.04] dark:hover:text-ink-50"
          >
            <ArrowLeft className="h-3 w-3" />
            All tasks
          </Link>
          <span className="vrule h-4" />
          <StatusPill status={task.status} />
          <LiveBadge live={live} terminal={isTerminal} />
          <div className="ml-auto flex items-center gap-1.5">
            {task.prUrl && (
              <Button asChild variant="outline" size="sm">
                <a href={task.prUrl} target="_blank" rel="noreferrer">
                  <ExternalLink className="h-3.5 w-3.5" />
                  PR
                </a>
              </Button>
            )}
            {!isTerminal && (
              <Button
                variant="outline"
                size="sm"
                onClick={onStop}
                disabled={stop.isPending}
              >
                <Square className="h-3.5 w-3.5" />
                Stop
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setWorkspaceOpen((v) => !v)}
              aria-label={workspaceOpen ? "Close workspace" : "Open workspace"}
              title={workspaceOpen ? "Close workspace" : "Open workspace"}
            >
              {workspaceOpen ? (
                <PanelRightClose className="h-4 w-4" />
              ) : (
                <PanelRight className="h-4 w-4" />
              )}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="More">
                  <MoreHorizontal className="h-4 w-4" />
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
          </div>
        </div>

        <h1 className="display text-3xl text-ink-900 dark:text-ink-50 mt-3 leading-tight">
          {task.title}
        </h1>

        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-2xs text-ink-500 dark:text-ink-400">
          <Badge variant="secondary" className="font-mono">
            {task.agent}
          </Badge>
          <span className="flex items-center gap-1.5">
            <GitBranch className="h-3 w-3" />
            <span className="text-ink-900 dark:text-ink-50">{task.branch}</span>
            <span className="text-ink-400 dark:text-ink-500">←</span>
            <span>{task.baseBranch}</span>
          </span>
          <Stat label="tok" value={totalTokens > 0 ? formatTokens(totalTokens) : "—"} />
          <Stat label="cost" value={formatCost(task.totalCostUsd)} />
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="cursor-help">id:{shortId(task.id)}</span>
              </TooltipTrigger>
              <TooltipContent>
                <span className="font-mono text-2xs">{task.id}</span>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <span className="ml-auto truncate max-w-[40ch]">{task.repoPath}</span>
        </div>
      </header>

      {/* Body — timeline + workspace drawer */}
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
            <PanelResizeHandle className="w-px bg-ink-900/10 dark:bg-ink-50/10 hover:bg-vermilion-500/40 transition-colors" />
            <Panel id={`ws-${task.id}`} defaultSize={48} minSize={28}>
              <TaskWorkspace task={task} onError={onError} />
            </Panel>
          </PanelGroup>
        ) : (
          <div className="mx-auto h-full max-w-4xl">
            <TaskTimeline
              taskId={task.id}
              messages={messages}
              appendLocal={appendLocal}
              onError={onError}
              disabled={isTerminal}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function LiveBadge({ live, terminal }: { live: boolean; terminal: boolean }) {
  if (terminal) {
    return (
      <span className="font-mono text-2xs uppercase tracking-[0.08em] text-ink-400 dark:text-ink-500">
        closed
      </span>
    );
  }
  return (
    <span
      className={cn(
        "flex items-center gap-1.5 font-mono text-2xs uppercase tracking-[0.08em]",
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
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className="text-ink-400 dark:text-ink-500">{label}</span>
      <span className="text-ink-900 dark:text-ink-50">{value}</span>
    </span>
  );
}
