import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  ListPlus,
  Loader2,
  Send,
  User2,
  Wrench,
  X,
} from "lucide-react";
import type { Message } from "@agentd/contracts";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Kbd } from "@/components/ui/kbd";
import { useApp, useClient } from "@/AppContext";
import { cn, formatTokens, formatTs } from "@/lib/utils";
import { CodeBlock } from "@/components/code-block";
import { ToolLine, WorkCard, pairToolEvents } from "@/components/tool-line";
import type { TaskPlanItem } from "@/views/TaskPlan";
import {
  useFireQueuedSteer,
  useRemoveQueuedSteer,
  useSendInput,
  useTaskSteer,
} from "@/queries";

const ROLE_GLYPH: Record<Message["role"], React.ReactNode> = {
  user: <User2 className="h-3 w-3" />,
  agent: <span className="font-display italic font-medium">a</span>,
  tool: <Wrench className="h-3 w-3" />,
  system: <span className="font-mono text-[8px]">sys</span>,
};

const ROLE_LABEL: Record<Message["role"], string> = {
  user: "you",
  agent: "agent",
  tool: "tool",
  system: "system",
};

export function TaskTimeline({
  taskId,
  messages,
  appendLocal,
  onError,
  disabled,
  lastToolHint,
  streams,
  totalTokens,
  contextWindow,
  turn,
  plan,
  compactedAt,
}: {
  taskId: string;
  messages: Message[];
  appendLocal: (role: Message["role"], content: string) => void;
  onError: (m: string) => void;
  /** True while the agent is mid-turn — disables submit but not typing. */
  disabled: boolean;
  /** Optional one-line hint shown next to the thinking pulse. */
  lastToolHint?: string | null;
  /** In-flight streaming text per content-block, keyed by streamId. */
  streams?: Record<string, string>;
  /** Total tokens used in this conversation so far. */
  totalTokens?: number;
  /** Model context window (default 200_000). */
  contextWindow?: number;
  /** Per-turn meter — `startedAt` set => mid-turn, `tokens` accumulated. */
  turn?: { startedAt: number | null; tokens: number };
  /** Live plan from the agent's most recent TodoWrite/update_plan call. */
  plan?: TaskPlanItem[];
  /**
   * Timestamp of the most recent /compact. The timeline draws a
   * "context compacted" divider before the first message that came
   * after this point, so the operator can see which prior messages
   * have been summarized out of the agent's working memory.
   */
  compactedAt?: number | null;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const client = useClient();
  const { toast } = useApp();
  const [compacting, setCompacting] = useState(false);

  const window = contextWindow ?? 200_000;
  const used = totalTokens ?? 0;
  const usagePct = Math.min(100, Math.round((used / window) * 100));
  const overSoftLimit = usagePct >= 80;

  const compact = async () => {
    setCompacting(true);
    try {
      await client.compactTask(taskId);
      toast("Sent /compact — agent will summarize and continue");
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setCompacting(false);
    }
  };

  const streamEntries = streams ? Object.entries(streams) : [];

  // Group walking is O(n) over messages; computing it once per change
  // beats the original code path which called groupTaskMessages twice
  // per iteration (O(n²)) inside the map. On a long codex chat this
  // alone made the input feel laggy.
  const groups = useMemo(() => groupTaskMessages(messages), [messages]);

  /**
   * Stick-to-bottom UX. Auto-scroll runs only when the operator is
   * already at (or within ~120px of) the bottom. The moment they
   * scroll up to read older context, we lift the lock so new content
   * doesn't yank them back. Resume sticky as soon as they return to
   * the bottom — manually or via the "↓ jump" pill.
   *
   * Implementation: sentinel <div> at the very bottom of the message
   * list + a ResizeObserver on the scrollable inner content. Whenever
   * the inner content's height changes (new message, streaming token,
   * markdown layout settling, code block mounting) and we're sticky,
   * we scroll the sentinel into view. This is far more robust than
   * race-y rAF + scrollHeight math.
   */
  const [stickToBottom, setStickToBottom] = useState(true);
  const [hasNewBelow, setHasNewBelow] = useState(false);
  const STICK_THRESHOLD = 120;
  const stickRef = useRef(true);
  stickRef.current = stickToBottom;
  const innerRef = useRef<HTMLDivElement | null>(null);

  const isAtBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD;
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
    setStickToBottom(true);
    setHasNewBelow(false);
  }, []);

  // Watch the user's scroll. Re-arm stickiness when they return to
  // the bottom; lift it the moment they pull away.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom = isAtBottom();
      setStickToBottom(atBottom);
      if (atBottom) setHasNewBelow(false);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [isAtBottom]);

  // ResizeObserver on the inner content — fires whenever content
  // height changes (new message added, streaming token, async-loaded
  // image, markdown laid out). If we're sticky, snap the scrollbar
  // to the absolute bottom (scrollTop = scrollHeight) so even the
  // container's padding is fully scrolled past — visually flush.
  useEffect(() => {
    const inner = innerRef.current;
    const scroller = scrollRef.current;
    if (!inner || !scroller) return;
    const ro = new ResizeObserver(() => {
      if (stickRef.current) {
        scroller.scrollTop = scroller.scrollHeight;
        setHasNewBelow(false);
      } else {
        setHasNewBelow(true);
      }
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, []);

  // Tick once a second while a turn is live so the elapsed display moves.
  // When the turn settles (`startedAt = null`) we stop ticking — the meter
  // freezes on the final value until the next turn starts.
  const [, force] = useState(0);
  useEffect(() => {
    if (!turn?.startedAt) return;
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [turn?.startedAt]);
  const elapsedMs = turn?.startedAt ? Date.now() - turn.startedAt : 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {overSoftLimit && (
        <div
          className={cn(
            "flex items-center gap-3 border-b px-5 py-2",
            usagePct >= 92
              ? "border-red-500/30 bg-red-500/[0.06]"
              : "border-amber-500/30 bg-amber-500/[0.06]",
          )}
        >
          <AlertTriangle
            className={cn(
              "h-3.5 w-3.5 shrink-0",
              usagePct >= 92
                ? "text-red-700 dark:text-red-300"
                : "text-amber-700 dark:text-amber-300",
            )}
          />
          <div className="flex-1 min-w-0">
            <div
              className={cn(
                "text-[12px] font-medium",
                usagePct >= 92
                  ? "text-red-700 dark:text-red-300"
                  : "text-amber-700 dark:text-amber-300",
              )}
            >
              {usagePct >= 92
                ? "Context nearly full — compact to keep working"
                : "Conversation getting heavy"}
            </div>
            <div className="font-mono text-[10px] text-ink-500 dark:text-ink-400">
              {formatTokens(used)} / {formatTokens(window)} tok ({usagePct}%) — /compact summarizes the trail and continues
            </div>
          </div>
          <Button
            size="xs"
            variant={usagePct >= 92 ? "default" : "outline"}
            onClick={compact}
            disabled={compacting || disabled}
          >
            {compacting ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : null}
            Compact now
          </Button>
        </div>
      )}
      <div className="relative flex-1 min-h-0">
        {!stickToBottom && hasNewBelow && (
          <button
            type="button"
            onClick={() => scrollToBottom("smooth")}
            title="Jump to latest"
            className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 inline-flex items-center gap-1.5 h-7 px-3 rounded-full bg-ember-500 text-white shadow-lg shadow-ember-900/20 hover:bg-ember-400 active:scale-[0.96] transition-all animate-fade-in font-mono text-[10.5px] uppercase tracking-[0.1em] font-semibold"
          >
            <ArrowDown className="h-3 w-3" />
            new
          </button>
        )}
        <div ref={scrollRef} className="absolute inset-0 overflow-y-auto">
        <div ref={innerRef} className="mx-auto max-w-3xl px-6 py-6 lg:py-8">
          {messages.length === 0 ? (
            <div className="flex h-full items-center justify-center py-16">
              <div className="text-center text-sm text-ink-500 dark:text-ink-400">
                Waiting for the agent to wake up…
              </div>
            </div>
          ) : (
            <ol className="space-y-5">
              {groups.map((g, gi) => {
                // /compact divider sits above the first message in
                // the group whose ts falls after the watermark.
                const firstTs = g.firstTs;
                const prevGroup = groups[gi - 1];
                const showDivider =
                  compactedAt != null &&
                  firstTs >= compactedAt &&
                  (!prevGroup || prevGroup.firstTs < compactedAt);
                return (
                  <Fragment key={g.key}>
                    {showDivider && <CompactDivider ts={compactedAt!} />}
                    {g.kind === "tools" ? (
                      <li>
                        <WorkCard pairs={g.pairs} />
                      </li>
                    ) : (
                      <TimelineItem message={g.message} />
                    )}
                  </Fragment>
                );
              })}
              {/* In-flight streaming bubbles — same prefix style as
                  the persisted agent rows, with a blinking λ. */}
              {streamEntries.map(([streamId, text]) => (
                <li key={`stream:${streamId}`}>
                  <div className="flex items-start gap-2.5">
                    <span className="shrink-0 mt-0.5 font-mono text-[14px] font-semibold leading-none text-ember-500 animate-blink select-none">
                      λ
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-2 mb-1.5">
                        <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-ember-700 dark:text-ember-300">
                          agent
                        </span>
                        <ShimmerText className="font-mono text-[10px] uppercase tracking-[0.06em]">
                          streaming
                        </ShimmerText>
                      </div>
                      <div className="relative">
                        <Markdown text={text} />
                        <span className="inline-block w-1.5 h-4 align-text-bottom bg-ember-500/70 ml-0.5 animate-blink" />
                      </div>
                    </div>
                  </div>
                </li>
              ))}
              {disabled && streamEntries.length === 0 && (
                <li>
                  <div className="flex items-start gap-2.5">
                    <span className="shrink-0 mt-0.5 font-mono text-[14px] font-semibold leading-none text-ember-500 animate-blink select-none">
                      λ
                    </span>
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <ShimmerText className="text-[12.5px] font-medium">
                        agent is thinking
                      </ShimmerText>
                      {turn?.startedAt && (
                        <span className="font-mono text-[10px] tabular-nums text-ember-700/80 dark:text-ember-300/80">
                          {formatElapsed(elapsedMs)}
                          {turn.tokens > 0
                            ? ` · ${formatTokens(turn.tokens)} tok`
                            : ""}
                        </span>
                      )}
                      <span className="font-mono text-[10px] text-ink-500 dark:text-ink-400 truncate">
                        {lastToolHint ?? "…"}
                      </span>
                    </div>
                  </div>
                </li>
              )}
            </ol>
          )}
        </div>
        </div>
      </div>

      <TaskComposer
        taskId={taskId}
        disabled={disabled}
        appendLocal={appendLocal}
        onError={onError}
        plan={plan}
      />
    </div>
  );
}

/**
 * Chat input + queue strip + plan strip. Lives in its own component so
 * keystrokes only re-render the composer — not the entire message
 * history above it. Without this split, every character typed would
 * walk the full message tree (markdown, code blocks, autoAnimate, the
 * resize observer chain), which makes typing in long sessions
 * unusable. `React.memo` keeps it from re-rendering on every WS event
 * the parent fires (deltas, usage, etc.) — only `disabled` and `plan`
 * actually flow into the composer.
 */
const TaskComposer = memo(function TaskComposer({
  taskId,
  disabled,
  appendLocal,
  onError,
  plan,
}: {
  taskId: string;
  disabled: boolean;
  appendLocal: (role: Message["role"], content: string) => void;
  onError: (m: string) => void;
  plan?: TaskPlanItem[];
}) {
  const [text, setText] = useState("");
  const send = useSendInput(taskId);
  const client = useClient();
  const steerQ = useTaskSteer(taskId);
  const removeQueued = useRemoveQueuedSteer(taskId);
  const fireQueued = useFireQueuedSteer(taskId);
  const queue = steerQ.data?.queue ?? [];

  const [queueRef] = useAutoAnimate<HTMLUListElement>({
    duration: 420,
    easing: "cubic-bezier(0.16, 1, 0.3, 1)",
  });

  const submit = async () => {
    const msg = text.trim();
    if (!msg) return;
    setText("");
    if (disabled) {
      try {
        await client.steerTask(taskId, msg, "queue");
        await steerQ.refetch();
      } catch (e) {
        onError((e as Error).message);
      }
      return;
    }
    appendLocal("user", msg);
    try {
      await send.mutateAsync(msg);
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const fireRow = async (index: number, line: string) => {
    appendLocal("user", line);
    try {
      await fireQueued.mutateAsync(index);
    } catch (e) {
      onError((e as Error).message);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className="border-t border-ink-900/10 dark:border-ink-50/10 px-6 py-4"
    >
      <div className="mx-auto max-w-3xl">
        {plan && plan.length > 0 && <PlanStrip plan={plan} />}
        {queue.length > 0 && (
          <div className="mb-2.5 overflow-hidden rounded-lg border border-violet-500/30 bg-gradient-to-br from-violet-500/[0.07] via-violet-500/[0.04] to-transparent shadow-[0_1px_0_rgba(139,92,246,0.06),0_8px_24px_-12px_rgba(139,92,246,0.18)] dark:from-violet-500/[0.12] dark:via-violet-500/[0.07] animate-fade-in">
            <header className="flex items-center justify-between gap-2 px-3 py-1.5 bg-gradient-to-r from-violet-500/[0.08] to-transparent border-b border-violet-500/15">
              <span className="inline-flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-violet-700 dark:text-violet-300 font-semibold">
                <span className="h-2 w-2 rounded-full bg-violet-500" />
                Queue
                <span className="rounded-full px-1.5 py-px bg-violet-500/20 text-[9px] font-bold tabular-nums">
                  {queue.length}
                </span>
              </span>
              <span className="font-mono text-[9px] text-violet-700/60 dark:text-violet-300/60">
                click ↑ steer to fire after next tool call
              </span>
            </header>
            <ul
              ref={queueRef}
              className="divide-y divide-violet-500/10"
            >
              {queue.map((line, i) => (
                <li
                  key={`${i}-${line.slice(0, 12)}`}
                  className="group flex items-start gap-2.5 px-3 py-2 hover:bg-violet-500/[0.04] dark:hover:bg-violet-500/[0.06] transition-colors animate-slide-in"
                >
                  <span className="mt-0.5 grid place-items-center size-5 rounded-full bg-violet-500/15 text-violet-700 dark:text-violet-300 font-mono text-[10px] tabular-nums font-semibold shrink-0">
                    {i + 1}
                  </span>
                  <span className="flex-1 min-w-0 whitespace-pre-wrap break-words text-[12.5px] leading-snug text-violet-900 dark:text-violet-100 pt-0.5">
                    {line}
                  </span>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => void fireRow(i, line)}
                      disabled={fireQueued.isPending}
                      title="Steer — send to the agent now (lands after the next tool call)"
                      className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md font-mono text-[10px] uppercase tracking-[0.1em] font-semibold bg-gradient-to-b from-violet-500 to-violet-600 text-white shadow-sm shadow-violet-900/20 hover:from-violet-400 hover:to-violet-500 active:from-violet-600 active:to-violet-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      {fireQueued.isPending ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <ArrowRight className="h-3 w-3" />
                      )}
                      steer
                    </button>
                    <button
                      type="button"
                      onClick={() => void removeQueued.mutateAsync(i)}
                      title="Remove from queue"
                      className="grid place-items-center size-7 rounded-md text-violet-700/50 hover:bg-violet-500/20 hover:text-violet-700 dark:text-violet-300/50 dark:hover:text-violet-300 opacity-0 group-hover:opacity-100 transition-all"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex items-start gap-2.5">
          <span
            className={cn(
              "shrink-0 mt-1.5 font-mono text-[14px] font-semibold leading-none transition-colors select-none",
              disabled
                ? "text-violet-500 animate-blink"
                : "text-sky-700 dark:text-sky-300",
            )}
          >
            ›
          </span>
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                void submit();
              }
            }}
            placeholder={
              disabled
                ? "type to queue — agent fires it after the next tool call"
                : "send input to the agent"
            }
            rows={3}
            data-shortcut-target="chat-input"
            className={cn(
              "flex-1 resize-none border-none shadow-none bg-transparent focus-visible:ring-0 px-0 py-1 font-mono text-[13px] leading-snug placeholder:text-ink-400/60 dark:placeholder:text-ink-500/60",
            )}
            aria-label="Message"
          />
          <div className="shrink-0 mt-0.5 flex items-center gap-1.5">
            <span className="hidden sm:flex items-center gap-1 text-2xs text-ink-400 dark:text-ink-500">
              <Kbd>⌘</Kbd>
              <Kbd>↵</Kbd>
            </span>
            <Button
              type="submit"
              size="sm"
              disabled={send.isPending || !text.trim()}
            >
              {send.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : disabled ? (
                <ListPlus className="h-3.5 w-3.5" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
              {disabled ? "Queue" : "Send"}
            </Button>
          </div>
        </div>
      </div>
    </form>
  );
});

/**
 * Parse a `[result <tool> ok|err] <output>` message into its parts.
 * Returns null when the message isn't a tool result (so the caller
 * can fall through to the regular tool_call render).
 */
function parseToolResultMessage(
  content: string,
): { tool: string; ok: boolean; output: string } | null {
  const m = content.match(/^\[result ([^\s\]]+) (ok|err)\]\s*([\s\S]*)$/);
  if (!m) return null;
  return {
    tool: m[1]!,
    ok: m[2] === "ok",
    output: m[3] ?? "",
  };
}

type TaskGroup =
  | {
      kind: "message";
      key: string;
      firstTs: number;
      message: Message;
    }
  | {
      kind: "tools";
      key: string;
      firstTs: number;
      pairs: ReturnType<typeof pairToolEvents>;
    };

/**
 * Walk the flat message stream and bundle consecutive tool messages
 * (`[call X]` followed by `[result X ok|err] …`) into a single
 * group so the timeline renders one `<WorkCard>` per agent turn,
 * not one row per tool. Non-tool messages stay as their own groups.
 */
function groupTaskMessages(messages: Message[]): TaskGroup[] {
  const out: TaskGroup[] = [];
  let buf: Array<{
    kind: "tool_use" | "tool_result";
    name?: string;
    input?: unknown;
    ok?: boolean;
    preview?: string;
  }> = [];
  let bufFirstTs = 0;
  let bufKey = "";
  const flushTools = () => {
    if (buf.length === 0) return;
    const pairs = pairToolEvents(buf);
    if (pairs.length > 0) {
      out.push({ kind: "tools", key: bufKey, firstTs: bufFirstTs, pairs });
    }
    buf = [];
    bufKey = "";
    bufFirstTs = 0;
  };
  for (const m of messages) {
    if (m.role !== "tool") {
      flushTools();
      out.push({ kind: "message", key: m.id, firstTs: m.ts, message: m });
      continue;
    }
    const result = parseToolResultMessage(m.content);
    if (result) {
      buf.push({
        kind: "tool_result",
        name: result.tool,
        ok: result.ok,
        preview: result.output,
      });
      continue;
    }
    const callMatch = m.content.match(/^\[call ([^\]]+)\]\s*([\s\S]*)$/);
    if (!callMatch) {
      // Unknown tool message shape — flush + render as its own
      // single-row group via TimelineItem fallback.
      flushTools();
      out.push({ kind: "message", key: m.id, firstTs: m.ts, message: m });
      continue;
    }
    let input: unknown = {};
    try {
      input = JSON.parse(callMatch[2]!);
    } catch {
      // bad json in args — keep raw
    }
    if (buf.length === 0) {
      bufFirstTs = m.ts;
      bufKey = `tools:${m.id}`;
    }
    buf.push({ kind: "tool_use", name: callMatch[1]!.trim(), input });
  }
  flushTools();
  return out;
}

function TimelineItem({ message: m }: { message: Message }) {
  // Structured system messages (`agentd-progress`, `agentd-share`,
  // `agentd-ask`) keep their styled-chip render — they carry
  // semantic meaning the operator scans for.
  if (m.role === "system") {
    const meta = parseSystemMessage(m.content);
    if (meta) return <StructuredItem ts={m.ts} {...meta} />;
    // Plain system rows (raw stderr, etc.) — single line, low key.
    return (
      <li className="flex items-start gap-2">
        <span className="font-mono text-[12px] text-ink-400 dark:text-ink-500 leading-none select-none mt-1">
          ·
        </span>
        <pre className="flex-1 whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-ink-500 dark:text-ink-400">
          {m.content}
        </pre>
      </li>
    );
  }

  // Tool messages should never reach this branch — `groupTaskMessages`
  // bundles them into a `<WorkCard>` group ahead of the render.
  // Fallback rendering for any orphan tool message that slipped past.
  if (m.role === "tool") {
    return (
      <li>
        <ToolLine content={m.content} />
      </li>
    );
  }

  // User + agent rows — terminal-style prefix matches brainstorm + workshop.
  const isUser = m.role === "user";
  return (
    <li>
      <div className="flex items-start gap-2.5">
        <span
          className={cn(
            "shrink-0 mt-0.5 font-mono text-[14px] font-semibold leading-none select-none",
            isUser
              ? "text-sky-700 dark:text-sky-300"
              : "text-ember-700 dark:text-ember-300",
          )}
        >
          {isUser ? "›" : "λ"}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 mb-1.5">
            <span
              className={cn(
                "font-mono text-[10px] uppercase tracking-[0.1em]",
                isUser
                  ? "text-sky-700 dark:text-sky-300"
                  : "text-ember-700 dark:text-ember-300",
              )}
            >
              {isUser ? "you" : "agent"}
            </span>
            <span className="font-mono text-[10px] tabular-nums text-ink-300 dark:text-ink-600">
              {formatTs(m.ts)}
            </span>
          </div>
          {isUser ? (
            <div className="font-mono whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink-800 dark:text-ink-100">
              {m.content}
            </div>
          ) : (
            <Markdown text={m.content} />
          )}
        </div>
      </div>
    </li>
  );
}

type StructuredKind = "progress" | "progress-done" | "share" | "ask";

interface ParsedSystem {
  kind: StructuredKind;
  text: string;
}

/**
 * Recognize the system-message shapes the daemon writes for the
 * agent's structured calls:
 *   [progress · done] X      → progress-done
 *   [progress] X             → progress
 *   [share] X                → share
 *   [ask] question\n1. opt   → ask
 * Anything else falls back to the generic system rendering.
 */
function parseSystemMessage(content: string): ParsedSystem | null {
  if (content.startsWith("[progress · done]")) {
    return {
      kind: "progress-done",
      text: content.slice("[progress · done]".length).trim(),
    };
  }
  if (content.startsWith("[progress]")) {
    return {
      kind: "progress",
      text: content.slice("[progress]".length).trim(),
    };
  }
  if (content.startsWith("[share]")) {
    return {
      kind: "share",
      text: content.slice("[share]".length).trim(),
    };
  }
  if (content.startsWith("[ask]")) {
    return {
      kind: "ask",
      text: content.slice("[ask]".length).trim(),
    };
  }
  return null;
}

function StructuredItem({
  kind,
  text,
  ts,
}: ParsedSystem & { ts: number }) {
  // Per-kind styling: emerald for done, ember for in-flight progress,
  // violet for shares, amber for asks.
  const style = (() => {
    switch (kind) {
      case "progress-done":
        return {
          border: "border-emerald-500/30",
          bg: "bg-emerald-500/[0.07]",
          dot: "bg-emerald-500",
          dotPulse: false,
          tone: "text-emerald-700 dark:text-emerald-300",
          label: "✓ done",
        };
      case "progress":
        return {
          border: "border-ember-500/30",
          bg: "bg-ember-500/[0.06]",
          dot: "bg-ember-500",
          dotPulse: true,
          tone: "text-ember-700 dark:text-ember-300",
          label: "progress",
        };
      case "share":
        return {
          border: "border-violet-500/30",
          bg: "bg-violet-500/[0.06]",
          dot: "bg-violet-500",
          dotPulse: false,
          tone: "text-violet-700 dark:text-violet-300",
          label: "💭 share",
        };
      case "ask":
        return {
          border: "border-amber-500/30",
          bg: "bg-amber-500/[0.07]",
          dot: "bg-amber-500",
          dotPulse: true,
          tone: "text-amber-700 dark:text-amber-300",
          label: "❓ ask",
        };
    }
  })();

  return (
    <li className="relative">
      <span
        className={cn(
          "absolute -left-7 top-1.5 size-2 rounded-full",
          style.dot,
          style.dotPulse && "animate-blink",
        )}
      />
      <div
        className={cn(
          "rounded-md border px-2.5 py-1 transition-all",
          style.border,
          style.bg,
        )}
      >
        <div className="flex items-baseline gap-2 flex-wrap">
          <span
            className={cn(
              "font-mono text-2xs font-semibold uppercase tracking-[0.1em] shrink-0",
              style.tone,
            )}
          >
            {style.label}
          </span>
          <span className="whitespace-pre-wrap break-words text-[12.5px] leading-snug text-ink-800 dark:text-ink-100 flex-1 min-w-0">
            {text}
          </span>
          <span className="font-mono text-2xs text-ink-400 dark:text-ink-500 shrink-0 ml-auto">
            {formatTs(ts)}
          </span>
        </div>
      </div>
    </li>
  );
}

/**
 * Markdown renderer used for agent + system messages and the in-flight
 * streaming bubble. Renders GitHub-flavored markdown — code fences, lists,
 * tables, links — with our color tokens and a monospace block for code.
 */
function Markdown({ text }: { text: string }) {
  return (
    <div className="prose prose-sm max-w-none dark:prose-invert text-sm leading-relaxed text-ink-900 dark:text-ink-50 break-words">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => (
            <p className="my-1.5 first:mt-0 last:mb-0">{children}</p>
          ),
          ul: ({ children }) => (
            <ul className="my-1.5 ml-4 list-disc space-y-1">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="my-1.5 ml-4 list-decimal space-y-1">{children}</ol>
          ),
          li: ({ children }) => <li className="leading-snug">{children}</li>,
          h1: ({ children }) => (
            <h1 className="mt-3 mb-1.5 text-[14px] font-semibold tracking-tight">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="mt-3 mb-1.5 text-[13px] font-semibold tracking-tight">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="mt-3 mb-1 text-[13px] font-semibold tracking-tight">
              {children}
            </h3>
          ),
          strong: ({ children }) => (
            <strong className="font-semibold text-ink-900 dark:text-ink-50">
              {children}
            </strong>
          ),
          em: ({ children }) => <em className="italic">{children}</em>,
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="text-ember-700 underline-offset-2 hover:underline dark:text-ember-300"
            >
              {children}
            </a>
          ),
          code: (props) => {
            const { children, className } = props as {
              children?: React.ReactNode;
              className?: string;
            };
            // Fenced block: hand off to <CodeBlock> for syntax
            // highlighting + line numbers + copy button (claude-code
            // style). Inline code: render as a small chip.
            const isFenced = (className ?? "").includes("language-");
            if (isFenced) {
              const lang = (className ?? "")
                .replace(/^language-/, "")
                .trim();
              const text =
                typeof children === "string"
                  ? children
                  : Array.isArray(children)
                    ? children.join("")
                    : String(children ?? "");
              return <CodeBlock code={text} language={lang} />;
            }
            return (
              <code className="rounded bg-ink-900/[0.06] px-1 py-0.5 font-mono text-[12px] text-ink-900 dark:bg-ink-50/[0.08] dark:text-ink-50">
                {children}
              </code>
            );
          },
          // <pre> wraps a <code> block — but we replace the whole
          // code path with <CodeBlock> above, so <pre> just renders
          // children to preserve any non-fenced cases.
          pre: ({ children }) => <>{children}</>,
          blockquote: ({ children }) => (
            <blockquote className="my-1.5 border-l-2 border-ember-500/40 pl-3 text-ink-700 dark:text-ink-200">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-3 border-ink-900/[0.08] dark:border-ink-50/[0.08]" />,
          table: ({ children }) => (
            <div className="my-2 overflow-x-auto">
              <table className="border-collapse text-[12px]">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-ink-900/[0.08] px-2 py-1 text-left font-semibold dark:border-ink-50/[0.08]">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border border-ink-900/[0.08] px-2 py-1 dark:border-ink-50/[0.08]">
              {children}
            </td>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

/**
 * Compact plan render that lives above the chat input. Highlights
 * what the agent is working on right now in an ember band, fades
 * completed steps with green strikethrough, lists what's next. Click
 * the header to expand/collapse the full list.
 *
 * The colour language matches the right-side todos timeline so the
 * operator's eye reads both the same way: emerald = done, ember =
 * active, ink = pending.
 */
function PlanStrip({ plan }: { plan: TaskPlanItem[] }) {
  const [expanded, setExpanded] = useState(false);
  const inProgress = plan.find((p) => p.status === "in_progress");
  const pending = plan.filter((p) => p.status === "pending");
  const done = plan.filter((p) => p.status === "completed").length;
  const total = plan.length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  const head = inProgress ?? pending[0];
  const restPending = inProgress ? pending : pending.slice(1);
  const collapsedRest = restPending.slice(0, 2);
  const overflow = restPending.length - collapsedRest.length;

  // Same FLIP animator as the right timeline / queue so plan items
  // glide into their new position when the agent updates the list.
  const [planRef] = useAutoAnimate<HTMLUListElement>({
    duration: 420,
    easing: "cubic-bezier(0.16, 1, 0.3, 1)",
  });

  return (
    <div className="mb-2.5 overflow-hidden rounded-lg border border-ink-900/[0.08] bg-gradient-to-br from-paper-100 to-paper-50 shadow-[0_1px_0_rgba(10,8,5,0.04)] dark:from-ink-800/60 dark:to-ink-800/30 dark:border-ink-50/[0.08]">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="group flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-ink-900/[0.02] dark:hover:bg-ink-50/[0.02] transition-colors"
        title={expanded ? "Collapse plan" : "Expand plan"}
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 text-ink-400 dark:text-ink-500 shrink-0 transition-transform" />
        ) : (
          <ChevronRight className="h-3 w-3 text-ink-400 dark:text-ink-500 shrink-0 transition-transform" />
        )}
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] font-semibold text-violet-700 dark:text-violet-300 shrink-0">
          Plan
        </span>
        {/* Mini progress ribbon — fills emerald as the agent ticks
            items off. */}
        <span className="relative h-1 w-12 rounded-full bg-ink-900/[0.08] dark:bg-ink-50/[0.08] overflow-hidden shrink-0">
          <span
            className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-emerald-400 to-emerald-500 transition-all duration-500"
            style={{ width: `${pct}%` }}
          />
        </span>
        <span className="font-mono text-[10px] tabular-nums text-ink-500 dark:text-ink-400 shrink-0">
          {done}/{total}
        </span>
        {head && !expanded && (
          <span className="flex items-center gap-1.5 min-w-0 flex-1">
            <PlanGlyph status={head.status} />
            <span
              className={cn(
                "truncate text-[12.5px]",
                head.status === "in_progress"
                  ? "text-ink-900 dark:text-ink-50 font-medium"
                  : "text-ink-700 dark:text-ink-200",
              )}
            >
              {head.activeForm ?? head.content}
            </span>
          </span>
        )}
      </button>
      {expanded ? (
        <ul
          ref={planRef}
          className="relative px-4 pb-3 pt-2 border-t border-ink-900/[0.04] dark:border-ink-50/[0.04] before:absolute before:left-[1.45rem] before:top-3 before:bottom-3 before:w-px before:bg-gradient-to-b before:from-ink-900/15 before:via-ink-900/10 before:to-ink-900/5 dark:before:from-ink-50/15 dark:before:via-ink-50/10 dark:before:to-ink-50/5"
        >
          {plan.map((item, i) => (
            <li
              key={i}
              className={cn(
                "group relative flex items-start gap-2.5 pl-7 py-1.5 -ml-2 pr-2 rounded-md transition-colors duration-300",
                item.status === "in_progress" &&
                  "bg-gradient-to-r from-ember-500/[0.10] via-ember-500/[0.04] to-transparent",
                item.status === "pending" &&
                  "hover:bg-ink-900/[0.025] dark:hover:bg-ink-50/[0.025]",
              )}
            >
              <span className="absolute left-[0.3rem] top-2 z-10">
                <PlanGlyph status={item.status} />
              </span>
              <span
                className={cn(
                  "flex-1 min-w-0 text-[12.5px] leading-snug break-words transition-colors duration-300",
                  item.status === "completed" &&
                    "line-through decoration-emerald-500/70 decoration-[1.5px] text-emerald-700/85 dark:text-emerald-300/85",
                  item.status === "in_progress" &&
                    "text-ink-900 dark:text-ink-50 font-medium",
                  item.status === "pending" && "text-ink-700 dark:text-ink-200",
                )}
              >
                {item.status === "in_progress"
                  ? (item.activeForm ?? item.content)
                  : item.content}
              </span>
              {item.status === "in_progress" && (
                <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-ember-700 dark:text-ember-300 shrink-0 inline-flex items-center gap-1">
                  <span className="size-1 rounded-full bg-ember-500 animate-blink" />
                  now
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        collapsedRest.length > 0 && (
          <ul className="px-3 pb-2 space-y-0.5 border-t border-ink-900/[0.04] dark:border-ink-50/[0.04] pt-1.5">
            {collapsedRest.map((item, i) => (
              <li key={i} className="flex items-center gap-2 pl-1">
                <PlanGlyph status="pending" />
                <span className="truncate text-[11.5px] text-ink-500 dark:text-ink-400">
                  {item.content}
                </span>
              </li>
            ))}
            {overflow > 0 && (
              <li className="pl-6 font-mono text-[10px] text-ink-400 dark:text-ink-500 italic">
                +{overflow} more
              </li>
            )}
          </ul>
        )
      )}
    </div>
  );
}

function PlanGlyph({ status }: { status: TaskPlanItem["status"] }) {
  if (status === "completed") {
    return (
      <span className="relative inline-grid place-items-center size-3.5 rounded-full border border-emerald-500/70 bg-gradient-to-br from-emerald-400 to-emerald-500 text-white shrink-0 shadow-[0_0_0_1px_rgba(16,185,129,0.15)]">
        <Check className="h-2.5 w-2.5 stroke-[3] animate-check-pop" />
      </span>
    );
  }
  if (status === "in_progress") {
    return (
      <span className="inline-grid place-items-center size-3.5 rounded-full border border-ember-500/70 bg-ember-500/20 shrink-0">
        <span className="size-1.5 rounded-full bg-ember-500" />
      </span>
    );
  }
  return (
    <span className="inline-block size-3.5 rounded-full border-[1.5px] border-ink-900/25 dark:border-ink-50/25 shrink-0 transition-colors hover:border-ember-500/50" />
  );
}

/**
 * Visual divider at the most recent /compact watermark. Messages
 * above are still in the agent's working memory; messages below
 * have been summarized away. Doesn't hide the older messages —
 * the operator can still scroll up and read them.
 */
function CompactDivider({ ts }: { ts: number }) {
  return (
    <li
      aria-hidden
      className="relative -ml-9 my-3 flex items-center gap-2 list-none"
    >
      <span className="h-px flex-1 bg-gradient-to-r from-transparent via-violet-500/30 to-violet-500/30" />
      <span className="inline-flex items-center gap-1.5 rounded-full border border-violet-500/30 bg-violet-500/[0.07] px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-violet-700 dark:text-violet-300">
        <span className="size-1 rounded-full bg-violet-500" />
        context compacted · {formatTs(ts)}
      </span>
      <span className="h-px flex-1 bg-gradient-to-l from-transparent via-violet-500/30 to-violet-500/30" />
    </li>
  );
}

/**
 * "Thinking" text with a gradient wave that sweeps across — the
 * same fading animation codex uses for its status line. The text
 * stays readable (mid-tone ember) while a brighter highlight
 * travels left-to-right and back, so the whole label feels alive
 * without distracting from what's around it.
 *
 * Implementation: 200%-wide gradient clipped to text, animated via
 * the `shimmer` keyframe (already defined in tailwind.config).
 */
function ShimmerText({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "bg-clip-text text-transparent",
        "bg-[linear-gradient(90deg,rgba(194,65,12,0.45),rgba(194,65,12,1),rgba(194,65,12,0.45))]",
        "dark:bg-[linear-gradient(90deg,rgba(252,165,107,0.4),rgba(252,165,107,1),rgba(252,165,107,0.4))]",
        "bg-[length:200%_100%] animate-shimmer",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** "0.4s", "12s", "1m 03s" — compact like Codex/claude-code. */
function formatElapsed(ms: number): string {
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem.toString().padStart(2, "0")}s`;
}
