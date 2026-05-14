import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowUpRight,
  Check,
  Maximize2,
  Minimize2,
  X,
} from "lucide-react";
import { agentContextWindow, type Message, type Task } from "@agentd/contracts";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { useApp } from "@/AppContext";
import { qk, useModels, useTask } from "@/queries";
import { useTaskRt } from "@/store";
import { useRealtime } from "@/realtime";
import { cn, formatTokens } from "@/lib/utils";
import { StatusDot } from "@/components/ui/status-dot";
import { parseToolCall, TOOL_ICONS } from "@/components/tool-line";
import { TaskTimeline } from "@/views/TaskTimeline";
import { TaskWorkspace } from "@/views/TaskWorkspace";

/**
 * Live view of a single task for the grid overlay. Two modes:
 *
 * - `density="tile"` — compact at-a-glance card. Latest stream / agent
 *   reply tail, status badge, tool hint, "needs approval" pulse when
 *   waiting_perm. No composer. Designed to fit 6+ to a screen.
 *
 * - `density="focused"` — full task experience embedded in the pane.
 *   Renders the same TaskTimeline component that powers /tasks/:id:
 *   thinking pulse with elapsed timer + tool hint, full markdown +
 *   code blocks, paired tool diffs (WorkCard), ask/answer flow,
 *   steer queue, plan strip, context-window warning, send/queue
 *   composer with the same keyboard shortcuts. The operator can
 *   manage the task from inside the overlay without dropping into
 *   /tasks/:id.
 *
 * All realtime data lives in the global qk.task(id) cache + the
 * per-task rt slice in zustand, so mounting either mode just
 * subscribes to existing live state — no extra network calls.
 */
export function TaskPane({
  task,
  focused,
  onToggleFocus,
  density,
  verbose = false,
}: {
  task: Task;
  focused: boolean;
  onToggleFocus: () => void;
  /** "tile" = small/medium dashboard tile; "focused" = expanded pane. */
  density: "tile" | "focused";
  /**
   * When true, include agent tool calls in the transcript tail —
   * Bash commands, file edits with +N/-M counts, Reads, etc. —
   * rendered as a single icon + summary line each so a tile can
   * still show "what is this agent doing right now" without
   * exploding the height. Off by default; flipped by the grid's
   * verbose toggle (persisted as `gridVerbose` pref).
   */
  verbose?: boolean;
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

  // Build the visible transcript tail for TILE mode only — focused
  // panes hand rendering off to TaskTimeline, which walks the
  // messages list itself. Tiles see the last few entries; tool calls
  // come in via the verbose toggle so a quiet glance stays quiet.
  const tail = useMemo(() => {
    if (density === "focused") return [];
    const tailSize = verbose ? 8 : 5;
    return collectTail(messages, tailSize, verbose);
  }, [messages, density, verbose]);

  // Auto-scroll the tile transcript on new content, but only when
  // already near the bottom — the operator may have scrolled up to
  // read older context and shouldn't get yanked back on every token.
  // Focused panes don't use this; TaskTimeline has its own
  // stick-to-bottom logic with a ResizeObserver + "↓ new" pill.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (density === "focused") return;
    const el = scrollRef.current;
    if (!el) return;
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (fromBottom < 48) {
      el.scrollTop = el.scrollHeight;
    }
  }, [density, tail.length, rt.streams, rt.lastToolHint]);

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

      {focused ? (
        // Full task experience: same TaskTimeline that powers
        // /tasks/:id, just with dense padding so it fits the pane.
        // Streams, thinking pulse, ask/answer, queue, plan strip,
        // context-window warning, send/queue composer — all of it.
        // No transcript tail / MiniComposer / footer in this mode;
        // TaskTimeline handles all of that.
        <div className="flex-1 min-h-0">
          <FocusedBody task={task} />
        </div>
      ) : (
        <>
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
                {tail.map((m) => {
                  if (m.role === "tool") {
                    return (
                      <li key={m.id}>
                        <ToolRow message={m} />
                      </li>
                    );
                  }
                  return (
                    <li key={m.id} className="flex gap-1.5 min-w-0">
                      <RoleGlyph role={m.role} streaming={false} />
                      <AgentText
                        text={m.content}
                        role={m.role}
                        verbose={verbose}
                        density={density}
                      />
                    </li>
                  );
                })}
                {streamText && (
                  <li className="flex gap-1.5 min-w-0">
                    {/* Streaming glyph breathes so the eye reads
                        "actively generating" without watching the
                        tokens themselves. */}
                    <RoleGlyph role="agent" streaming />
                    <AgentText
                      text={streamText}
                      role="agent"
                      verbose={verbose}
                      density={density}
                      streaming
                    />
                  </li>
                )}
              </ol>
            )}
          </div>

          {/* Footer — live hint + token meter. Finished tiles swap
              the hint for a duration ("12m · done") so the operator
              can see at a glance how long this one took, which is
              more useful than a stale tool name once a task wraps. */}
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
        </>
      )}
    </div>
  );
}

/**
 * Renders the full task-page experience — chat timeline + workspace
 * tabs (Live tool feed, Diff, Todos, Files, Log, Context, Term) —
 * inside the grid overlay's focused pane. Mirrors TaskDetail's body:
 * same PanelGroup split, same TaskTimeline + TaskWorkspace, same
 * context-token + context-window math, same optimistic appendLocal.
 * The operator gets the actual task experience without leaving the
 * overlay.
 */
function FocusedBody({ task }: { task: Task }) {
  const { toast } = useApp();
  const taskQ = useTask(task.id);
  const messages: Message[] = taskQ.data?.messages ?? [];
  const rt = useTaskRt(task.id);
  const { streams, plan, lastToolHint } = rt;
  const turn = useMemo(
    () => ({ startedAt: rt.turnStartedAt, tokens: rt.turnTokens }),
    [rt.turnStartedAt, rt.turnTokens],
  );
  const modelsQ = useModels();
  const qc = useQueryClient();

  // Current-turn working-context tokens (NOT lifetime spend — that
  // re-counts prior turns and would inflate the meter into the
  // millions while the real working context is tiny). Same shape
  // as TaskDetail.contextTokens.
  const contextTokens = useMemo(() => {
    const inT = task.latestTurnInputTokens;
    const outT = task.latestTurnOutputTokens;
    if (inT == null && outT == null) return 0;
    return (inT ?? 0) + (outT ?? 0);
  }, [task.latestTurnInputTokens, task.latestTurnOutputTokens]);
  const contextWindow = useMemo(() => {
    const agent = task.agent as "claude" | "codex";
    const resolved = (
      task.model?.trim() ||
      modelsQ.data?.defaults?.[agent]?.trim() ||
      ""
    ).toLowerCase();
    const entry = resolved
      ? (modelsQ.data?.models?.[agent] ?? []).find(
          (m) =>
            m.id.toLowerCase() === resolved ||
            m.aliases?.some((a) => a.toLowerCase() === resolved),
        )
      : undefined;
    return entry?.contextWindow ?? agentContextWindow(task.agent);
  }, [modelsQ.data, task.agent, task.model]);

  const isRunning =
    task.status === "running" ||
    task.status === "waiting_input" ||
    task.status === "waiting_perm";

  const onError = useCallback((m: string) => toast(m, true), [toast]);

  // Optimistic user-message append. Writes straight into the
  // qk.task cache so the row shows the moment Send is pressed;
  // the realtime bus then dedupes the server-shape row a few
  // hundred ms later. Same pattern TaskDetail.appendLocal uses.
  const appendLocal = useCallback(
    (role: Message["role"], content: string) => {
      const ts = Date.now();
      qc.setQueryData(qk.task(task.id), (cur: unknown) => {
        const prev = cur as
          | { task: Task; messages: Message[] }
          | undefined;
        if (!prev || !prev.task) return cur;
        return {
          ...prev,
          messages: [
            ...prev.messages,
            {
              id: "tmp_" + Math.random().toString(36).slice(2),
              taskId: task.id,
              role,
              content,
              ts,
            },
          ],
        };
      });
    },
    [task.id, qc],
  );

  return (
    <PanelGroup
      direction="horizontal"
      className="h-full"
      autoSaveId={`grid-focused-${task.id}`}
    >
      <Panel id={`tl-${task.id}`} defaultSize={55} minSize={32}>
        <TaskTimeline
          taskId={task.id}
          messages={messages}
          appendLocal={appendLocal}
          onError={onError}
          disabled={isRunning}
          lastToolHint={lastToolHint}
          streams={streams}
          totalTokens={contextTokens}
          contextWindow={contextWindow}
          turn={turn}
          plan={plan}
          compactedAt={task.lastCompactedAt ?? null}
          dense
        />
      </Panel>
      <PanelResizeHandle className="w-px bg-ink-900/10 hover:bg-ember-500/40 transition-colors dark:bg-ink-50/10" />
      <Panel id={`ws-${task.id}`} defaultSize={45} minSize={24}>
        <TaskWorkspace
          task={task}
          onError={onError}
          plan={plan}
          messages={messages}
        />
      </Panel>
    </PanelGroup>
  );
}

const ROLE_GLYPH: Record<Message["role"], string> = {
  user: "you",
  agent: "λ",
  tool: "tool",
  system: "sys",
};

/**
 * Render an agent / user / system message body for the pane. In
 * compact mode (the default) code fences collapse to a `「code」`
 * placeholder and whitespace is squeezed — fine for "what's the
 * agent saying right now" glances. In verbose mode we instead
 * preserve code blocks as monospace strips (separated from the
 * surrounding prose by a thin left border) and keep whitespace as
 * the agent emitted it. That's the version the user actually wants
 * when they're watching an agent write code — they can see the
 * code, not a placeholder.
 */
function AgentText({
  text,
  role,
  verbose,
  density,
  streaming = false,
}: {
  text: string;
  role: Message["role"];
  verbose: boolean;
  density: "tile" | "focused";
  streaming?: boolean;
}) {
  const clampClass =
    density === "tile"
      ? streaming
        ? verbose
          ? "max-h-32 overflow-hidden"
          : "line-clamp-4"
        : verbose
          ? "max-h-24 overflow-hidden"
          : "line-clamp-3"
      : streaming
        ? "max-h-64 overflow-hidden"
        : undefined;

  const caret = streaming ? (
    <span className="ml-0.5 inline-block h-3 w-1 align-text-bottom bg-ember-500/80 animate-caret-blink" />
  ) : null;

  if (!verbose) {
    return (
      <span
        className={cn(
          "flex-1 min-w-0 text-ink-700 dark:text-ink-200",
          clampClass,
          role === "system" && "text-ink-400 dark:text-ink-500 italic",
        )}
      >
        {compactText(text)}
        {caret}
      </span>
    );
  }

  // Verbose path — split into prose segments and code blocks. Code
  // gets its own block, prose runs inline. Inline backticks stay as
  // a subtle mono span (no separate block treatment) so a sentence
  // mentioning `useEffect` doesn't fragment into three blocks.
  const segments = splitCodeFences(text);
  return (
    <span
      className={cn(
        "flex-1 min-w-0 text-ink-700 dark:text-ink-200",
        clampClass,
        role === "system" && "text-ink-400 dark:text-ink-500 italic",
      )}
    >
      {segments.map((seg, i) =>
        seg.kind === "code" ? (
          <pre
            key={i}
            className="my-1 max-h-40 overflow-hidden whitespace-pre rounded-sm border-l-2 border-ember-500/40 bg-ink-900/[0.04] px-2 py-1 font-mono text-[10.5px] leading-snug text-ink-800 dark:bg-ink-50/[0.04] dark:text-ink-100"
          >
            <code>{seg.text}</code>
          </pre>
        ) : (
          <span key={i} className="whitespace-pre-wrap">
            {renderInlineMono(seg.text)}
          </span>
        ),
      )}
      {caret}
    </span>
  );
}

/**
 * Split a markdown-ish string into prose / fenced-code segments.
 * Fences are ``` blocks; the optional language right after the
 * opening fence is dropped (we don't have a highlighter in the
 * pane). Unbalanced fences (still-streaming code blocks) treat
 * everything after the last `\`\`\`` as code so partial output
 * still renders as code as it streams, not as plain text.
 */
function splitCodeFences(
  text: string,
): Array<{ kind: "code" | "prose"; text: string }> {
  const out: Array<{ kind: "code" | "prose"; text: string }> = [];
  const re = /```[^\n]*\n?/g;
  let lastIdx = 0;
  let inCode = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const before = text.slice(lastIdx, m.index);
    if (before.length > 0) {
      out.push({ kind: inCode ? "code" : "prose", text: before });
    }
    inCode = !inCode;
    lastIdx = re.lastIndex;
  }
  const trailing = text.slice(lastIdx);
  if (trailing.length > 0) {
    out.push({ kind: inCode ? "code" : "prose", text: trailing });
  }
  // Trim trailing whitespace on the last segment so a flapping
  // caret doesn't sit on a blank line beneath the content.
  if (out.length > 0) {
    const last = out[out.length - 1]!;
    out[out.length - 1] = { ...last, text: last.text.replace(/\s+$/, "") };
  }
  return out;
}

/** Wrap inline backticks (`foo`) as subtle mono spans, leave the rest
 *  as plain text. Lightweight — no markdown parser, just the
 *  one inline pattern that actually matters here. */
function renderInlineMono(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /`([^`\n]+)`/g;
  let lastIdx = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > lastIdx) out.push(text.slice(lastIdx, m.index));
    out.push(
      <code
        key={`c-${key++}`}
        className="rounded-sm bg-ink-900/[0.06] px-0.5 font-mono text-[10.5px] text-ink-800 dark:bg-ink-50/[0.06] dark:text-ink-100"
      >
        {m[1]}
      </code>,
    );
    lastIdx = re.lastIndex;
  }
  if (lastIdx < text.length) out.push(text.slice(lastIdx));
  return out;
}

/**
 * Compact tool row for the verbose grid pane. Renders both
 * `[call <Tool>] {…}` (call rows: → arrow, ember tool name, summary)
 * and `[result <Tool> ok|err] <body>` (result rows: ← arrow, status
 * dot, first line of output). Dense by design — a tile is 12 lines
 * tall, every row counts. We don't render the full body / diff
 * here; the operator clicks through to /tasks/:id for that.
 */
function ToolRow({ message }: { message: Message }) {
  // Result rows render differently — they show output preview + ok/err
  // status, no parseable args. Branch up front so the call path
  // doesn't have to handle the no-args case.
  const result = parseToolResult(message.content);
  if (result) {
    return (
      <div className="flex items-center gap-1.5 min-w-0 text-ink-500 dark:text-ink-400">
        <span className="font-mono text-[10px] mt-[1px] text-ink-400 dark:text-ink-500 shrink-0 w-3">
          ←
        </span>
        <span
          className={cn(
            "shrink-0 inline-block h-1.5 w-1.5 rounded-full",
            result.ok
              ? "bg-emerald-500/70"
              : "bg-red-500",
          )}
        />
        <span className="flex-1 min-w-0 font-mono text-[10.5px] text-ink-500 dark:text-ink-400 truncate italic">
          {firstLine(result.output) || (result.ok ? "ok" : "failed")}
        </span>
      </div>
    );
  }

  const parsed = parseToolCall(message.content);
  const Icon = TOOL_ICONS[parsed.kind] ?? TOOL_ICONS.other;
  return (
    <div className="flex items-center gap-1.5 min-w-0 text-ink-600 dark:text-ink-300">
      <span className="font-mono text-[10px] mt-[1px] text-ember-700/70 dark:text-ember-300/70 shrink-0 w-3">
        →
      </span>
      <Icon className="h-3 w-3 shrink-0 text-ink-500 dark:text-ink-400" />
      <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.06em] text-ember-700 dark:text-ember-300">
        {parsed.name}
      </span>
      <span className="flex-1 min-w-0 font-mono text-[11px] text-ink-700 dark:text-ink-200 truncate">
        {parsed.summary}
      </span>
    </div>
  );
}

function firstLine(s: string): string {
  const i = s.indexOf("\n");
  const line = i < 0 ? s : s.slice(0, i);
  return line.length > 120 ? line.slice(0, 117) + "…" : line;
}

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
 * Pick the last `n` "interesting" rows to show in a pane. System
 * bookkeeping (ask/answer/exit/status/usage markers) is always
 * filtered. Tool calls/results are filtered in compact mode and kept
 * in verbose mode — both the call AND the result, so the operator
 * sees what the agent invoked + the bit of output it got back. Two
 * lines per tool isn't free, but it's how every other agent UI
 * (claude-code's terminal, Cursor's inspector) shows it and it
 * matches the operator's mental model.
 */
function collectTail(
  messages: Message[],
  n: number,
  verbose: boolean,
): Message[] {
  const filtered = messages.filter((m) => {
    if (m.role === "system") {
      const c = m.content;
      if (/^\[(ask|answer|exit|status|usage)/i.test(c)) return false;
    }
    if (m.role === "tool") return verbose;
    return m.content.trim().length > 0;
  });
  return filtered.slice(-n);
}

/** `[result <Tool> ok|err] <body>` → structured parts. */
function parseToolResult(
  content: string,
): { tool: string; ok: boolean; output: string } | null {
  const m = content.match(/^\[result ([^\s\]]+)\s+(ok|err)\]\s*([\s\S]*)$/);
  if (!m) return null;
  return { tool: m[1]!, ok: m[2] === "ok", output: (m[3] ?? "").trim() };
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
