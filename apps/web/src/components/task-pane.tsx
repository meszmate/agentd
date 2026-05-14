import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertCircle,
  ArrowUpRight,
  Check,
  Maximize2,
  Minimize2,
  X,
} from "lucide-react";
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
  const { latestByTask, pulses, lastStatusChange } = useRealtime();
  const latest = latestByTask[task.id];
  const pulseTs = pulses[task.id] ?? 0;
  const hot = Date.now() - pulseTs < 1500;

  const needsApproval = task.status === "waiting_perm";
  const isRunning =
    task.status === "running" ||
    task.status === "waiting_input" ||
    task.status === "waiting_perm";
  const isFinished =
    task.status === "done" ||
    task.status === "failed" ||
    task.status === "stopped";

  // Did THIS task just transition into its terminal state? Used to
  // play the celebrate flash once and then settle. We compare the
  // recorded status-change ts against a render-time `now` so the
  // flash fires for ~1.4s after the transition then idles.
  const flipTs = lastStatusChange[task.id]?.ts ?? 0;
  const justFinished = isFinished && Date.now() - flipTs < 1400;

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

  // "Hover lift" — driven from state rather than CSS :hover so we can
  // suppress it when the pane is already focused (focused panes have
  // their own larger shadow and a hover lift would make them feel
  // floaty).
  const [hovered, setHovered] = useState(false);

  const open = () => navigate(`/tasks/${task.id}`);

  const streamText =
    Object.values(rt.streams || {}).join("\n\n") || null;
  const hint = rt.lastToolHint ?? latest?.text ?? null;

  const totalTok =
    (task.totalInputTokens ?? 0) + (task.totalOutputTokens ?? 0);

  // Duration label for finished tiles ("12m · done"). Falls back to
  // updated-at when createdAt is missing (shouldn't happen, but safe).
  const durationLabel = useMemo(() => {
    if (!isFinished) return null;
    const start = task.createdAt ?? task.updatedAt;
    const end = task.updatedAt;
    const ms = Math.max(0, end - start);
    return formatDuration(ms);
  }, [isFinished, task.createdAt, task.updatedAt]);

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={cn(
        // Base — every pane gets the same surface + transitions. We
        // animate transform AND shadow so the hover-lift reads as a
        // genuine vertical motion rather than a flat color swap.
        "group relative flex h-full min-h-0 flex-col overflow-hidden rounded-lg border bg-paper-50 transition-all duration-200 dark:bg-ink-800",
        // Default border — different per status so even at rest a
        // wall of tiles encodes which ones need eyes vs ambient.
        focused
          ? "border-ember-500/40 shadow-[0_12px_40px_-12px_rgba(220,38,38,0.25)]"
          : task.status === "running"
            ? "border-ember-500/20 shadow-sm"
            : task.status === "done"
              ? "border-emerald-500/15"
              : task.status === "failed"
                ? "border-red-500/30"
                : "border-ink-900/10 dark:border-ink-50/10",
        // Hover lift — only when not focused (focused panes shouldn't
        // wobble). Slight upward translate + deeper shadow.
        hovered && !focused && "-translate-y-0.5 shadow-md",
        // Waiting-perm gets the full siren treatment: amber border +
        // pulsing halo so blocked tasks pop visually anywhere on the
        // grid. Overrides the per-status default border above.
        needsApproval &&
          "border-amber-500/60 ring-1 ring-amber-500/40 animate-alert-ring",
        // Recently-pulsed (any event in the last 1.5s) gets a faint
        // ember ring so the operator can see "this one just did
        // something" without staring at the transcript.
        hot && !needsApproval && !justFinished && "ring-1 ring-ember-500/30",
        // Just-finished celebrate flash — plays once for ~1.4s and
        // then settles. Pairs with `done` border color so the green
        // halo and the green border resolve together.
        justFinished && "animate-done-celebrate border-emerald-500",
        // Finished tiles dim out so the eye lands on the live ones
        // first. Recovered on hover so the operator can still read.
        isFinished &&
          !focused &&
          "opacity-70 hover:opacity-100 transition-opacity",
      )}
    >
      {/* Live activity sweep — thin gradient bar along the very top
          edge of running tiles. Beats the status dot for "alive"
          signaling because it covers the full width and moves
          continuously, so the eye can lock onto it from across a
          dense grid. Hidden for non-running statuses. */}
      {isRunning && !needsApproval && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-px overflow-hidden"
        >
          <div
            className="h-full w-full animate-tile-sweep"
            style={{
              background:
                "linear-gradient(90deg, transparent 0%, rgba(220,38,38,0) 25%, rgba(220,38,38,0.6) 50%, rgba(220,38,38,0) 75%, transparent 100%)",
              backgroundSize: "200% 100%",
            }}
          />
        </div>
      )}

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
        {task.status === "waiting_input" && (
          <span
            title="agent asked a question — open task to answer"
            className="inline-flex items-center gap-1 h-5 px-1.5 rounded font-mono text-[10px] font-medium uppercase tracking-[0.06em] bg-amber-500/10 text-amber-700 border border-amber-500/25 dark:text-amber-300"
          >
            ? answer
          </span>
        )}
        {justFinished && task.status === "done" && (
          <span
            title="just finished"
            className="inline-flex items-center gap-1 h-5 px-1.5 rounded font-mono text-[10px] font-medium uppercase tracking-[0.06em] bg-emerald-500/15 text-emerald-700 border border-emerald-500/30 dark:text-emerald-300 animate-check-pop"
          >
            <Check className="h-3 w-3" /> done
          </span>
        )}
        {task.status === "failed" && (
          <span
            title="task failed"
            className="inline-flex items-center gap-1 h-5 px-1.5 rounded font-mono text-[10px] font-medium uppercase tracking-[0.06em] bg-red-500/15 text-red-700 border border-red-500/30 dark:text-red-300"
          >
            <X className="h-3 w-3" /> failed
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
                <RoleGlyph role={m.role} streaming={false} />
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
                {/* Streaming glyph breathes so the eye reads "actively
                    generating" without watching the tokens themselves. */}
                <RoleGlyph role="agent" streaming />
                <span
                  className={cn(
                    "flex-1 min-w-0 text-ink-700 dark:text-ink-200",
                    density === "tile" && "line-clamp-4",
                  )}
                >
                  {compactText(streamText)}
                  {/* Sleeker caret — character-stepped blink rather than
                      the heavier opacity fade. Reads as "typing". */}
                  <span className="ml-0.5 inline-block h-3 w-1 align-text-bottom bg-ember-500/80 animate-caret-blink" />
                </span>
              </li>
            )}
          </ol>
        )}
      </div>

      {/* Footer — live hint + token meter. Finished tiles swap the
          hint for a duration ("12m · done") so the operator can see at
          a glance how long this one took, which is more useful than a
          stale tool name once a task wraps. */}
      <div className="flex h-6 items-center gap-2 border-t border-ink-900/[0.06] px-2.5 dark:border-ink-50/[0.06] shrink-0">
        <span className="font-mono text-[10px] text-ink-500 dark:text-ink-400 truncate min-w-0 flex-1">
          {isRunning
            ? hint ?? "…"
            : isFinished && durationLabel
              ? `${durationLabel} · ${statusLabel(task.status)}`
              : statusLabel(task.status)}
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

function RoleGlyph({
  role,
  streaming,
}: {
  role: Message["role"];
  streaming: boolean;
}) {
  return (
    <span
      className={cn(
        "shrink-0 font-mono text-[9px] uppercase tracking-[0.08em] mt-[2px] w-8",
        role === "user"
          ? "text-ink-700 dark:text-ink-200"
          : role === "agent"
            ? "text-ember-700 dark:text-ember-300"
            : "text-ink-400 dark:text-ink-500",
        // Only the streaming λ breathes — static rows shouldn't pulse.
        streaming && role === "agent" && "animate-breathe",
      )}
    >
      {ROLE_GLYPH[role]}
    </span>
  );
}

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

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM === 0 ? `${h}h` : `${h}h ${remM}m`;
}
