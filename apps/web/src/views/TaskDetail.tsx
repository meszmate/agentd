import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckSquare,
  ExternalLink,
  Hash,
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
  DropdownMenuCheckboxItem,
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
  useDiscordChannels,
  useModels,
  usePatchPrefs,
  usePrefs,
  useProject,
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
  // Viewport-width gate for the two-column body. Mobile (<1024px)
  // collapses the workspace panel since both fitting side-by-side
  // produces unreadable column widths.
  const [isWide, setIsWide] = useState<boolean>(() =>
    typeof window === "undefined"
      ? true
      : window.matchMedia("(min-width: 1024px)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const onChange = () => setIsWide(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
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
  /**
   * Per-turn meter — accumulates tokens reported via `usage` events and
   * tracks when the turn started so the timeline can render an
   * elapsed-thinking display next to the pulse. `startedAt = null` means
   * the turn has settled; `tokens` stays put so the operator sees the
   * final cost of the last turn until the next one begins.
   */
  const [turn, setTurn] = useState<{ startedAt: number | null; tokens: number }>(
    { startedAt: null, tokens: 0 },
  );
  const prefsQ = usePrefs();
  const patchPrefs = usePatchPrefs();
  const [workspaceOpen, setWorkspaceOpenState] = useState<boolean>(true);
  const [workspaceHydrated, setWorkspaceHydrated] = useState(false);
  useEffect(() => {
    if (workspaceHydrated) return;
    const v = prefsQ.data?.prefs.taskWorkspaceOpen;
    if (v == null) return;
    setWorkspaceOpenState(v);
    setWorkspaceHydrated(true);
  }, [prefsQ.data, workspaceHydrated]);
  const setWorkspaceOpen = (v: boolean): void => {
    setWorkspaceOpenState(v);
    void patchPrefs.mutateAsync({ taskWorkspaceOpen: v });
  };

  useEffect(() => {
    if (!taskQ.data) return;
    // Always re-sync from the server when the cache updates. The
    // previous `loadedFor` guard meant only the FIRST snapshot ever
    // landed — so if the operator tab-switched away mid-chat and
    // back, the cached pre-chat messages would lock in and the new
    // ones (now persisted server-side) wouldn't appear.
    //
    // Dedupe by id so optimistic tmp_ messages survive briefly
    // until the server-side version arrives. Server-persisted
    // messages always replace tmp_ duplicates with the same ts/role.
    setMessages((prev) => {
      const serverMsgs = taskQ.data.messages;
      const tmpPending = prev.filter(
        (m) =>
          m.id.startsWith("tmp_") &&
          !serverMsgs.some(
            (s) =>
              s.role === m.role &&
              s.content === m.content &&
              Math.abs(s.ts - m.ts) < 10_000,
          ),
      );
      const merged = [...serverMsgs, ...tmpPending];
      merged.sort((a, b) => a.ts - b.ts);
      return merged;
    });
    if (loadedFor !== task.id) setLoadedFor(task.id);
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
          setLastToolHint(
            `✓ plan · ${planItems.length} item${planItems.length === 1 ? "" : "s"}`,
          );
          // Don't litter the timeline with the raw JSON for plan tools.
          return;
        }
        setLastToolHint(`→ ${event.tool}`);
        // Persist in the same `[call <tool>] <argsJson>` shape the daemon
        // writes server-side so the ToolLine renderer treats live + history
        // identically.
        appendLocal(
          "tool",
          `[call ${event.tool}] ${JSON.stringify(event.args ?? {})}`,
        );
        // tool_result events are intentionally dropped from the timeline —
        // the result of "Read foo.ts" is the file contents, which was the
        // noise we just got rid of. Failures still surface via raw stderr.
      } else if (event.kind === "raw") {
        appendLocal("system", event.text);
      } else if (event.kind === "status") {
        if (event.status === "running") {
          setTurn({ startedAt: Date.now(), tokens: 0 });
        } else {
          // Freeze the meter on the final value when the turn settles.
          setTurn((cur) => ({ startedAt: null, tokens: cur.tokens }));
          setLastToolHint(null);
        }
        void qc.invalidateQueries({ queryKey: qk.tasks() });
        void qc.invalidateQueries({ queryKey: qk.task(task.id) });
      } else if (event.kind === "exit") {
        setTurn((cur) => ({ startedAt: null, tokens: cur.tokens }));
        setLastToolHint(null);
        void qc.invalidateQueries({ queryKey: qk.tasks() });
        void qc.invalidateQueries({ queryKey: qk.task(task.id) });
      } else if (event.kind === "usage") {
        // Accumulate per-turn tokens. Cleared by the next "running" status.
        const delta =
          (event.inputTokens ?? 0) +
          (event.outputTokens ?? 0) +
          (event.cacheReadTokens ?? 0) +
          (event.cacheWriteTokens ?? 0);
        setTurn((cur) => ({ ...cur, tokens: cur.tokens + delta }));
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
          {statusLabel(task.status)}
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
        {task.discordThreadId && (
          <DiscordThreadChip
            taskId={task.id}
            projectId={task.projectId ?? null}
            threadId={task.discordThreadId}
          />
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
          onClick={() => setWorkspaceOpen(!workspaceOpen)}
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
        <span className="text-ink-300 dark:text-ink-600 shrink-0">·</span>
        <ModelChip task={task} />
        <span className="text-ink-300 dark:text-ink-600 shrink-0">·</span>
        <AutoFlagsChip task={task} />
        <span className="text-ink-300 dark:text-ink-600 shrink-0">·</span>
        <MirrorChip task={task} />
        {task.councilId && (
          <>
            <span className="text-ink-300 dark:text-ink-600 shrink-0">·</span>
            <CouncilChip task={task} />
          </>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0">
        {/* The two-column split is desktop-only — on mobile the
            workspace panel would crowd out the chat. Mobile gets
            the chat full-width and an inline "Workspace" link the
            operator can tap to drill in (TaskWorkspace itself has
            tabs for files/diff/log/etc). */}
        {workspaceOpen && isWide ? (
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
                turn={turn}
                plan={plan}
                compactedAt={task.lastCompactedAt ?? null}
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
            turn={turn}
            plan={plan}
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

/**
 * Mid-flight toggles for auto-commit + auto-push. The post-turn
 * hook re-reads them on every agent exit so flipping them changes
 * the behavior of the NEXT completed turn — current in-flight turn
 * is unchanged. Pull requests stay manual via the Ship menu.
 */
function AutoFlagsChip({ task }: { task: Task }) {
  const client = useClient();
  const qc = useQueryClient();
  const { toast } = useApp();
  const set = async (patch: { autoCommit?: boolean; autoPush?: boolean }) => {
    try {
      const res = await client.setTaskAutoFlags(task.id, patch);
      if (res.task) qc.setQueryData(qk.task(task.id), { task: res.task });
      const labels: string[] = [];
      if (patch.autoCommit !== undefined)
        labels.push(`auto-commit ${patch.autoCommit ? "on" : "off"}`);
      if (patch.autoPush !== undefined)
        labels.push(`auto-push ${patch.autoPush ? "on" : "off"}`);
      toast(labels.join(" · "));
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  // Compact label of what's on. Defaults to true for autoCommit
  // (legacy behavior) so undefined === on.
  const commitOn = task.autoCommit !== false;
  const summary =
    commitOn && task.autoPush
      ? "commit+push"
      : commitOn
        ? "commit"
        : task.autoPush
          ? "push only"
          : "off";
  const isAnyOn = commitOn || task.autoPush;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title="Toggle auto-commit / auto-push for the next turn"
          className={cn(
            "inline-flex items-center gap-1 h-5 px-1.5 rounded font-mono text-[10px] uppercase tracking-[0.06em] border transition-colors shrink-0",
            isAnyOn
              ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/20 hover:bg-emerald-500/20"
              : "bg-ink-900/[0.04] text-ink-500 dark:text-ink-400 border-ink-900/10 dark:border-ink-50/10 hover:bg-ink-900/[0.08]",
          )}
        >
          auto:{summary}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuLabel className="text-[10px] uppercase tracking-[0.12em]">
          On agent exit · next turn
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={commitOn}
          onCheckedChange={(v) => void set({ autoCommit: !!v })}
        >
          <div className="flex flex-col">
            <span className="text-[12px]">Auto-commit</span>
            <span className="text-[10px] text-ink-400 dark:text-ink-500">
              commit any uncommitted work after each turn
            </span>
          </div>
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={!!task.autoPush}
          onCheckedChange={(v) => void set({ autoPush: !!v })}
          disabled={!commitOn}
        >
          <div className="flex flex-col">
            <span className="text-[12px]">Auto-push</span>
            <span className="text-[10px] text-ink-400 dark:text-ink-500">
              {commitOn
                ? "push the branch upstream after each commit"
                : "needs auto-commit to be on"}
            </span>
          </div>
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ModelChip({ task }: { task: Task }) {
  const client = useClient();
  const qc = useQueryClient();
  const { toast } = useApp();
  const modelsQ = useModels();
  const current = task.model ?? "";
  // Pulled from the server's `cfg.models` so adding a model only
  // means editing config.json once. Always include "(default)" up
  // front so clearing the override is one tap away.
  const agent = task.agent as "claude" | "codex";
  const registryEntries = modelsQ.data?.models[agent] ?? [];
  const defaultId = modelsQ.data?.defaults?.[agent] ?? "";
  // Resolve the visible label: explicit task.model wins; otherwise
  // show the configured default; otherwise fall back to the agent's
  // own default (which the runner picks if we pass nothing). Match
  // against the registry to render the friendly label when known.
  const resolvedId = current || defaultId;
  const resolvedEntry = registryEntries.find(
    (m) =>
      m.id === resolvedId ||
      m.aliases?.some(
        (a) => a.toLowerCase() === resolvedId.toLowerCase(),
      ),
  );
  const chipLabel =
    resolvedEntry?.label || resolvedId || `${agent} default`;
  const isInherited = !current && !!defaultId;
  const suggestions = [
    {
      value: "",
      label: defaultId
        ? `(default · ${defaultId})`
        : "(default)",
    },
    ...registryEntries.map((m) => ({ value: m.id, label: m.label || m.id })),
  ];
  const [draft, setDraft] = useState(current);
  useEffect(() => setDraft(current), [current]);

  const apply = async (next: string) => {
    if (next === current) return;
    try {
      const res = await client.setTaskModel(task.id, next);
      if (res.task) {
        qc.setQueryData(qk.task(task.id), { task: res.task });
      }
      toast(
        next
          ? `model → ${next} (next turn)`
          : "model cleared — using default (next turn)",
      );
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={
            isInherited
              ? `Using project default · ${resolvedId}`
              : `Override active · ${resolvedId || "(agent default)"}`
          }
          className="inline-flex items-center gap-1 h-5 px-1.5 rounded font-mono text-[10px] uppercase tracking-[0.06em] bg-sky-500/10 text-sky-700 dark:text-sky-300 border border-sky-500/20 hover:bg-sky-500/20 transition-colors shrink-0 max-w-[200px]"
        >
          <span className="truncate">model:{chipLabel}</span>
          {isInherited && (
            <span className="font-normal text-[9px] text-sky-700/60 dark:text-sky-300/60">
              ·default
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel className="text-[10px] uppercase tracking-[0.12em]">
          Model · next turn
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {suggestions.map((s) => (
          <DropdownMenuItem
            key={s.value || "_default"}
            onClick={() => void apply(s.value)}
            className={cn(
              "font-mono",
              s.value === current && "text-ember-700 dark:text-ember-300",
            )}
          >
            {s.label}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <form
          className="flex items-center gap-1 px-1 py-1"
          onSubmit={(e) => {
            e.preventDefault();
            void apply(draft.trim());
          }}
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="custom model id…"
            className="flex-1 h-7 px-2 rounded border border-ink-900/15 bg-paper-50 font-mono text-[11px] outline-none focus:border-ember-500/40 dark:border-ink-50/15 dark:bg-ink-800"
          />
          <button
            type="submit"
            className="h-7 px-2 rounded font-mono text-[10px] uppercase tracking-[0.08em] border border-ember-500/40 bg-ember-500/10 text-ember-700 dark:text-ember-300"
          >
            set
          </button>
        </form>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Toggle whether this task mirrors its curated events (progress notes,
 * permission asks, terminal status changes) into a chat. Today the only
 * supported targets come from enabled plugins (Telegram + Discord).
 *
 * The chatId itself comes from the plugin: in Telegram, every operator
 * runs `/whoami` once to discover their id, then drops it here. We
 * keep the input lightweight — the real flow is "open chat, /mirror
 * <task-id>" which is already handled by the bot side.
 */
function MirrorChip({ task }: { task: Task }) {
  const client = useClient();
  const qc = useQueryClient();
  const { toast } = useApp();
  const cur = task.mirrorTo;
  const label = cur
    ? `mirror:${cur.platform === "telegram" ? "tg" : "ds"} ${cur.chatId.slice(-6)}`
    : "mirror:off";
  const [draftId, setDraftId] = useState("");

  const apply = async (
    next: { platform: "telegram" | "discord"; chatId: string } | null,
  ) => {
    try {
      const res = await client.setTaskMirror(task.id, next);
      if (res.task) qc.setQueryData(qk.task(task.id), { task: res.task });
      toast(
        next
          ? `mirroring → ${next.platform}:${next.chatId.slice(-6)}`
          : "mirror off",
      );
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title="Mirror task events to a chat — replies steer the agent"
          className={cn(
            "inline-flex items-center gap-1 h-5 px-1.5 rounded font-mono text-[10px] uppercase tracking-[0.06em] border shrink-0 transition-colors max-w-[180px]",
            cur
              ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/20 hover:bg-emerald-500/20"
              : "bg-ink-900/[0.04] text-ink-500 dark:text-ink-400 border-ink-900/10 dark:border-ink-50/10 hover:bg-ink-900/[0.07]",
          )}
        >
          <span className="truncate">{label}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel className="text-[10px] uppercase tracking-[0.12em]">
          Mirror to chat
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {cur && (
          <DropdownMenuItem
            onClick={() => void apply(null)}
            className="text-red-700 dark:text-red-300"
          >
            Stop mirroring
          </DropdownMenuItem>
        )}
        <div className="px-2 py-1.5">
          <p className="font-mono text-[10px] text-ink-500 dark:text-ink-400">
            Set the chat id directly. Easier path: in your bot chat run{" "}
            <code className="font-mono">/use {task.id.slice(-8)}</code> then{" "}
            <code className="font-mono">/mirror</code> — it self-registers.
          </p>
        </div>
        {(["telegram", "discord"] as const).map((platform) => (
          <form
            key={platform}
            className="flex items-center gap-1 px-1 py-1"
            onSubmit={(e) => {
              e.preventDefault();
              const v = draftId.trim();
              if (!v) return;
              void apply({ platform, chatId: v });
              setDraftId("");
            }}
          >
            <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-500 dark:text-ink-400 w-16 shrink-0">
              {platform}
            </span>
            <input
              value={draftId}
              onChange={(e) => setDraftId(e.target.value)}
              placeholder="chat / channel id"
              className="flex-1 h-7 px-2 rounded border border-ink-900/15 bg-paper-50 font-mono text-[11px] outline-none focus:border-ember-500/40 dark:border-ink-50/15 dark:bg-ink-800"
            />
            <button
              type="submit"
              className="h-7 px-2 rounded font-mono text-[10px] uppercase tracking-[0.08em] border border-ember-500/40 bg-ember-500/10 text-ember-700 dark:text-ember-300"
            >
              set
            </button>
          </form>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Council chip on the task header. The council itself is invisible UI
 * — there's no /councils route. Each member's task page shows whether
 * it won, lost, or is still in flight, and lets the operator override
 * the judge by marking THIS task as the winner.
 *
 *   ✓ winner             — judge picked this task
 *   …  judging           — all members settled, judge running
 *   council 2/3 settled  — still waiting on siblings
 *   council · lost       — judge picked someone else
 */
function CouncilChip({ task }: { task: Task }) {
  const client = useClient();
  const qc = useQueryClient();
  const { toast } = useApp();
  const { data } = useQuery({
    queryKey: ["councils", task.councilId ?? ""] as const,
    queryFn: () => client.getCouncil(task.councilId!),
    enabled: !!task.councilId,
    refetchInterval: 3_000,
  });
  const council = data?.council;
  const isWinner =
    !!council?.winnerTaskId && council.winnerTaskId === task.id;
  const lost =
    !!council?.winnerTaskId && council.winnerTaskId !== task.id;
  const judging = council?.status === "judging";
  const settled =
    council?.taskIds.filter((id) => id === task.id || id !== task.id) ?? [];
  void settled;

  const pick = async () => {
    if (!task.councilId) return;
    try {
      await client.pickCouncilWinner(task.councilId, task.id, "manual pick");
      qc.setQueryData(qk.task(task.id), { task });
      void qc.invalidateQueries({ queryKey: ["councils", task.councilId] });
      toast("set as winner");
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  let label = "council";
  let tone = "bg-violet-500/10 text-violet-700 dark:text-violet-300 border-violet-500/20";
  if (isWinner) {
    label = "✓ winner";
    tone = "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/20";
  } else if (lost) {
    label = "lost";
    tone = "bg-ink-900/[0.04] text-ink-500 dark:text-ink-400 border-ink-900/10 dark:border-ink-50/10";
  } else if (judging) {
    label = "judging…";
    tone = "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/20";
  } else if (council) {
    label = `council · ${council.taskIds.length} members`;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={
            council?.judgeExplanation
              ? `Verdict: ${council.judgeExplanation}`
              : "Council member"
          }
          className={cn(
            "inline-flex items-center gap-1 h-5 px-1.5 rounded font-mono text-[10px] uppercase tracking-[0.06em] border shrink-0 transition-colors",
            tone,
          )}
        >
          {label}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel className="text-[10px] uppercase tracking-[0.12em]">
          Council {task.councilId?.slice(-6)}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {council?.judgeExplanation && (
          <div className="px-2 py-1.5 text-[11px] text-ink-600 dark:text-ink-300 leading-relaxed">
            <span className="font-mono uppercase tracking-[0.08em] text-ink-400 dark:text-ink-500">
              verdict
            </span>
            <div className="mt-0.5">{council.judgeExplanation}</div>
          </div>
        )}
        {council && (
          <div className="px-2 py-1.5 text-[10px] text-ink-500 dark:text-ink-400">
            siblings ({council.taskIds.length}):
            <ul className="mt-1 space-y-0.5">
              {council.taskIds.map((id) => (
                <li key={id}>
                  <Link
                    to={`/tasks/${id}`}
                    className={cn(
                      "font-mono hover:underline",
                      id === task.id && "text-ember-700 dark:text-ember-300",
                      id === council.winnerTaskId &&
                        "text-emerald-700 dark:text-emerald-300",
                    )}
                  >
                    {id === task.id ? "→ " : "  "}
                    {shortId(id)}
                    {id === council.winnerTaskId ? " ✓" : ""}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
        {!isWinner && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => void pick()}>
              <span className="font-mono text-[11px]">
                Mark this as winner
              </span>
            </DropdownMenuItem>
          </>
        )}
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
  const tone: "danger" | "warn" | "ok" =
    pct >= 80 ? "danger" : pct >= 60 ? "warn" : "ok";

  // SVG donut. r=10 gives circumference ~62.8; we paint the fill arc
  // by setting strokeDasharray to (filled, total) and rotating -90°
  // so the arc starts at 12 o'clock.
  const radius = 10;
  const circ = 2 * Math.PI * radius;
  const filled = (pct / 100) * circ;

  const stroke =
    tone === "danger"
      ? "stroke-red-500"
      : tone === "warn"
        ? "stroke-amber-500"
        : "stroke-emerald-500";
  const text =
    tone === "danger"
      ? "text-red-700 dark:text-red-300"
      : tone === "warn"
        ? "text-amber-700 dark:text-amber-300"
        : "text-emerald-700 dark:text-emerald-300";

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="hidden md:inline-flex items-center gap-1.5 cursor-help group"
            aria-label={`Context usage: ${pct}%`}
          >
            <span className="relative grid place-items-center size-6">
              <svg
                viewBox="0 0 24 24"
                className="size-6 -rotate-90 overflow-visible"
              >
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  className="stroke-ink-900/15 dark:stroke-ink-50/15"
                  strokeWidth={2.5}
                  fill="none"
                />
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  className={cn(
                    stroke,
                    "transition-[stroke-dasharray] duration-500",
                    tone === "danger" && "animate-pulse",
                  )}
                  strokeWidth={2.5}
                  strokeLinecap="round"
                  strokeDasharray={`${filled} ${circ}`}
                  fill="none"
                />
              </svg>
              <span
                className={cn(
                  "absolute inset-0 grid place-items-center font-mono text-[8.5px] font-bold tabular-nums leading-none",
                  text,
                )}
              >
                {pct}
              </span>
            </span>
            <span
              className={cn(
                "font-mono text-[10px] uppercase tracking-[0.08em] hidden lg:inline",
                text,
              )}
            >
              ctx
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent>
          <div className="font-mono text-[10px] space-y-0.5">
            <div>
              {totalTokens.toLocaleString()} / {window.toLocaleString()} tokens
            </div>
            <div className="text-ink-400 dark:text-ink-500">
              {pct >= 80
                ? "compact soon — context nearly full"
                : pct >= 60
                  ? "context filling up"
                  : "plenty of room"}
            </div>
          </div>
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

/**
 * Human-friendly task status label for the topbar badge. Distinct
 * from `t.status` which is the wire-level enum.
 */
function statusLabel(s: Task["status"]): string {
  if (s === "running") return "working";
  if (s === "idle") return "ready";
  if (s === "waiting_input") return "needs you";
  if (s === "waiting_perm") return "needs ok";
  if (s === "pending") return "queued";
  return s;
}

/**
 * Chip linking to the per-task Discord thread. Resolves the parent
 * channel's guildId from the cached channel snapshot so we can
 * build a clickable `https://discord.com/channels/<guild>/<thread>`
 * link. Falls back to a non-clickable badge if the guild isn't
 * known yet (e.g. the discord subprocess hasn't reported channels).
 */
function DiscordThreadChip({
  taskId,
  projectId,
  threadId,
}: {
  taskId: string;
  projectId: string | null;
  threadId: string;
}) {
  void taskId;
  const projectQ = useProject(projectId);
  const channelsQ = useDiscordChannels();
  const project = projectQ.data?.project;
  const channelId = project?.discordChannelId ?? null;
  const guildId = useMemo(() => {
    if (!channelId) return null;
    for (const g of channelsQ.data?.guilds ?? []) {
      if (g.channels.some((c) => c.id === channelId)) return g.id;
    }
    return null;
  }, [channelId, channelsQ.data]);
  const href = guildId
    ? `https://discord.com/channels/${guildId}/${threadId}`
    : null;
  const label = "Thread";
  if (!href) {
    return (
      <span
        className="inline-flex h-7 items-center gap-1 px-2 rounded-md border border-ink-900/10 bg-paper-50 font-mono text-[11px] text-ink-500 dark:border-ink-50/10 dark:bg-ink-800 dark:text-ink-400"
        title={`thread ${threadId}`}
      >
        <Hash className="h-3 w-3" /> {label}
      </span>
    );
  }
  return (
    <Button asChild variant="outline" size="xs">
      <a href={href} target="_blank" rel="noreferrer">
        <Hash className="h-3 w-3" /> {label}
      </a>
    </Button>
  );
}
