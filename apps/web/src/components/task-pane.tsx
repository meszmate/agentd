import { useEffect, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { AlertCircle, ArrowUpRight, Maximize2, Minimize2 } from "lucide-react";
import type { Message, Task } from "@agentd/contracts";
import { useTask } from "@/queries";
import { useTaskRt } from "@/store";
import { useRealtime } from "@/realtime";
import { cn, formatTokens } from "@/lib/utils";
import { StatusDot } from "@/components/ui/status-dot";

/**
 * Read-only live view of a single task for the grid overlay.
 *
 * The full task page (TaskTimeline + composer) is way too dense to fit
 * 6+ to a screen, so this pane shows only the signal that matters at a
 * glance: status, latest stream / agent reply tail, current tool hint,
 * a "needs approval" pulse when waiting_perm. Click anywhere on the
 * pane (or the title) to navigate to /tasks/:id and steer it. The
 * focus toggle resizes the pane in-place — handled by the parent grid
 * via the `focused` prop + `onToggleFocus` callback.
 *
 * Read-only by design: no composer, no mutations. All realtime data is
 * already cached by the global WS bus in qk.task(id) + useTaskRt(id), so
 * mounting a pane just subscribes to slices that another route is already
 * keeping fresh — no extra network round-trips.
 */
export function TaskPane({
  task,
  focused,
  onToggleFocus,
  density,
}: {
  task: Task;
  focused: boolean;
  onToggleFocus: () => void;
  /** "tile" = small/medium dashboard tile; "focused" = expanded pane. */
  density: "tile" | "focused";
}) {
  const navigate = useNavigate();
  const taskQ = useTask(task.id);
  const messages: Message[] = taskQ.data?.messages ?? [];
  const rt = useTaskRt(task.id);
  const { latestByTask, pulses } = useRealtime();
  const latest = latestByTask[task.id];
  const pulseTs = pulses[task.id] ?? 0;
  const hot = Date.now() - pulseTs < 1500;

  const needsApproval = task.status === "waiting_perm";
  const isRunning =
    task.status === "running" ||
    task.status === "waiting_input" ||
    task.status === "waiting_perm";

  // Build the visible transcript tail. Tiles see only the last few
  // entries — there's no room for more and the goal is "what's it
  // doing right now," not full history. Focused panes get a deeper
  // slice but still no tool-call rendering (kept text-only on purpose
  // so the pane stays readable at a quick glance).
  const tail = useMemo(() => {
    const tailSize = density === "focused" ? 16 : 5;
    return collectTail(messages, tailSize);
  }, [messages, density]);

  // Auto-scroll the transcript to the bottom whenever new content lands.
  // Always sticky — these panes are passive viewers, the operator isn't
  // reading scrollback here (they'd click into /tasks/:id for that).
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [tail.length, rt.streams, rt.lastToolHint]);

  const open = () => navigate(`/tasks/${task.id}`);

  const streamText =
    Object.values(rt.streams || {}).join("\n\n") || null;
  const hint = rt.lastToolHint ?? latest?.text ?? null;

  const totalTok =
    (task.totalInputTokens ?? 0) + (task.totalOutputTokens ?? 0);

  return (
    <div
      className={cn(
        "group relative flex h-full min-h-0 flex-col overflow-hidden rounded-md border bg-paper-50 transition-shadow dark:bg-ink-800",
        focused
          ? "border-ember-500/40 shadow-[0_8px_28px_rgba(0,0,0,0.08)]"
          : "border-ink-900/10 hover:border-ink-900/20 dark:border-ink-50/10 dark:hover:border-ink-50/20",
        needsApproval &&
          "border-amber-500/50 ring-2 ring-amber-500/30 animate-pulse-ring",
        hot && !needsApproval && "ring-1 ring-ember-500/30",
      )}
    >
      {/* Header */}
      <div className="flex h-8 items-center gap-2 border-b border-ink-900/[0.06] px-2.5 dark:border-ink-50/[0.06] shrink-0">
        <StatusDot status={task.status} size="sm" />
        <button
          type="button"
          onClick={open}
          title={`${task.title} · open task`}
          className="flex-1 min-w-0 text-left text-[12px] font-medium text-ink-900 truncate hover:text-ember-600 dark:text-ink-50 dark:hover:text-ember-400"
        >
          {task.title}
        </button>
        {needsApproval && (
          <span
            title="permission requested — open task to approve"
            className="inline-flex items-center gap-1 h-5 px-1.5 rounded font-mono text-[10px] font-medium uppercase tracking-[0.06em] bg-amber-500/15 text-amber-700 border border-amber-500/30 dark:text-amber-300 animate-pulse"
          >
            <AlertCircle className="h-3 w-3" /> approve
          </span>
        )}
        <button
          type="button"
          onClick={onToggleFocus}
          title={focused ? "Shrink" : "Focus"}
          aria-label={focused ? "Shrink pane" : "Focus pane"}
          className="inline-flex h-5 w-5 items-center justify-center rounded text-ink-500 transition-colors hover:bg-ink-900/[0.06] hover:text-ink-900 dark:text-ink-400 dark:hover:bg-ink-50/[0.06] dark:hover:text-ink-50"
        >
          {focused ? (
            <Minimize2 className="h-3 w-3" />
          ) : (
            <Maximize2 className="h-3 w-3" />
          )}
        </button>
        <button
          type="button"
          onClick={open}
          title="Open task"
          aria-label="Open task"
          className="inline-flex h-5 w-5 items-center justify-center rounded text-ink-500 transition-colors hover:bg-ink-900/[0.06] hover:text-ink-900 dark:text-ink-400 dark:hover:bg-ink-50/[0.06] dark:hover:text-ink-50"
        >
          <ArrowUpRight className="h-3 w-3" />
        </button>
      </div>

      {/* Meta strip — agent · branch · model */}
      <div className="flex h-6 items-center gap-2 border-b border-ink-900/[0.04] px-2.5 dark:border-ink-50/[0.04] shrink-0 overflow-hidden">
        <span className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-ink-400 dark:text-ink-500 shrink-0">
          {task.agent}
        </span>
        <span className="font-mono text-[10px] text-ink-500 dark:text-ink-400 truncate min-w-0">
          {task.branch}
        </span>
      </div>

      {/* Transcript tail */}
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto px-2.5 py-2 text-[11.5px] leading-snug"
      >
        {tail.length === 0 && !streamText ? (
          <div className="flex h-full items-center justify-center text-[11px] text-ink-400 dark:text-ink-500">
            {isRunning ? "waking up…" : "no messages yet"}
          </div>
        ) : (
          <ol className="space-y-1.5">
            {tail.map((m) => (
              <li key={m.id} className="flex gap-1.5 min-w-0">
                <span
                  className={cn(
                    "shrink-0 font-mono text-[9px] uppercase tracking-[0.08em] mt-[2px] w-8",
                    m.role === "user"
                      ? "text-ink-700 dark:text-ink-200"
                      : m.role === "agent"
                        ? "text-ember-700 dark:text-ember-300"
                        : "text-ink-400 dark:text-ink-500",
                  )}
                >
                  {ROLE_GLYPH[m.role]}
                </span>
                <span
                  className={cn(
                    "flex-1 min-w-0 text-ink-700 dark:text-ink-200",
                    density === "tile" && "line-clamp-3",
                    m.role === "system" &&
                      "text-ink-400 dark:text-ink-500 italic",
                  )}
                >
                  {compactText(m.content)}
                </span>
              </li>
            ))}
            {streamText && (
              <li className="flex gap-1.5 min-w-0">
                <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.08em] mt-[2px] w-8 text-ember-700 dark:text-ember-300">
                  λ
                </span>
                <span
                  className={cn(
                    "flex-1 min-w-0 text-ink-700 dark:text-ink-200",
                    density === "tile" && "line-clamp-4",
                  )}
                >
                  {compactText(streamText)}
                  <span className="ml-0.5 inline-block h-3 w-1 align-text-bottom bg-ember-500/70 animate-blink" />
                </span>
              </li>
            )}
          </ol>
        )}
      </div>

      {/* Footer — live hint + token meter */}
      <div className="flex h-6 items-center gap-2 border-t border-ink-900/[0.06] px-2.5 dark:border-ink-50/[0.06] shrink-0">
        <span className="font-mono text-[10px] text-ink-500 dark:text-ink-400 truncate min-w-0 flex-1">
          {isRunning ? hint ?? "…" : statusLabel(task.status)}
        </span>
        <span className="font-mono text-[10px] tabular-nums text-ink-400 dark:text-ink-500 shrink-0">
          {formatTokens(totalTok)} tok
        </span>
      </div>
    </div>
  );
}

const ROLE_GLYPH: Record<Message["role"], string> = {
  user: "you",
  agent: "λ",
  tool: "tool",
  system: "sys",
};

/**
 * Drop tool-call noise and pre-pruned system meta rows; the pane shows
 * conversational signal only. Keeps the tail size from filling up with
 * `[call Bash]` / `[result Bash ok]` entries that would otherwise crowd
 * out the last actual agent reply.
 */
function collectTail(messages: Message[], n: number): Message[] {
  const filtered = messages.filter((m) => {
    if (m.role === "tool") return false;
    if (m.role === "system") {
      // hide synthetic ask/answer/exit markers — they're chat noise here
      const c = m.content;
      if (/^\[(ask|answer|exit|status|usage)/i.test(c)) return false;
    }
    return m.content.trim().length > 0;
  });
  return filtered.slice(-n);
}

/**
 * Strip code fences / heavy formatting down to a single inline string
 * so the tile can render messages in 3-4 lines without ReactMarkdown's
 * block layout exploding the pane height.
 */
function compactText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "「code」")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s*#+\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function statusLabel(s: Task["status"]): string {
  switch (s) {
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "stopped":
      return "stopped";
    case "idle":
      return "ready";
    case "pending":
      return "pending";
    case "running":
      return "running";
    case "waiting_input":
      return "waiting for input";
    case "waiting_perm":
      return "needs approval";
  }
}
