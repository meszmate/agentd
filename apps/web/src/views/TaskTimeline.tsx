import { useCallback, useEffect, useRef, useState } from "react";
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
import { ToolLine } from "@/components/tool-line";
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
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [text, setText] = useState("");
  const send = useSendInput(taskId);
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

  /**
   * Stick-to-bottom UX. Auto-scroll runs only when the operator is
   * already at (or within ~80px of) the bottom. The moment they
   * scroll up to read older context, we lift the lock so new content
   * doesn't yank them back. Resume sticky as soon as they return to
   * the bottom — manually or via the "↓ jump" pill.
   */
  const [stickToBottom, setStickToBottom] = useState(true);
  const [hasNewBelow, setHasNewBelow] = useState(false);
  const STICK_THRESHOLD = 80;

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

  // Apply auto-scroll on new content, gated on sticky state. If the
  // user is scrolled up, surface the "↓ jump" pill instead.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (stickToBottom) {
      el.scrollTo({ top: el.scrollHeight });
      setHasNewBelow(false);
    } else {
      setHasNewBelow(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    messages.length,
    streamEntries.map(([, t]) => t.length).join("|"),
    stickToBottom,
  ]);

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

  // Live queue snapshot — server-side state, polled. Renders as the
  // strip above the input so the operator can see what's pending.
  const steerQ = useTaskSteer(taskId);
  const removeQueued = useRemoveQueuedSteer(taskId);
  const queue = steerQ.data?.queue ?? [];

  const fireQueued = useFireQueuedSteer(taskId);

  // FLIP animator on the queue list — rows slide as they're fired or
  // removed, matching the right-side todos timeline feel.
  const [queueRef] = useAutoAnimate<HTMLUListElement>({
    duration: 420,
    easing: "cubic-bezier(0.16, 1, 0.3, 1)",
  });

  const submit = async () => {
    const msg = text.trim();
    if (!msg) return;
    setText("");
    if (disabled) {
      // Mid-turn: queue the message — it does NOT go to the agent
      // until the operator clicks the per-row Steer button. This
      // matches the deliberate "draft then fire" feel claude-code
      // has: type your thoughts now, send when the moment is right.
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
    // Optimistic chat append so the bubble shows up the moment the
    // operator hits Steer — before the server persists.
    appendLocal("user", line);
    try {
      await fireQueued.mutateAsync(index);
    } catch (e) {
      onError((e as Error).message);
    }
  };

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
        <div className="mx-auto max-w-3xl px-6 py-6 lg:py-8">
          {messages.length === 0 ? (
            <div className="flex h-full items-center justify-center py-16">
              <div className="text-center text-sm text-ink-500 dark:text-ink-400">
                Waiting for the agent to wake up…
              </div>
            </div>
          ) : (
            <ol className="relative space-y-4 pl-9 before:absolute before:left-3 before:top-2 before:bottom-2 before:w-px before:bg-ink-900/10 dark:before:bg-ink-50/10">
              {messages.map((m) => (
                <TimelineItem key={m.id} message={m} />
              ))}
              {/* In-flight streaming bubbles. Each delta growing here will
                  vanish when its message_end arrives — the final text lands
                  via the regular message event right after. */}
              {streamEntries.map(([streamId, text]) => (
                <li key={`stream:${streamId}`} className="relative">
                  <span className="absolute -left-9 top-0 flex h-6 w-6 items-center justify-center rounded-full border border-ember-500/30 bg-ember-500/15 text-ember-700 dark:text-ember-300">
                    <span className="font-display italic font-medium">a</span>
                  </span>
                  <div>
                    <div className="flex items-baseline gap-2 mb-1">
                      <span className="text-[11px] uppercase tracking-[0.08em] text-ember-700 dark:text-ember-300 font-medium">
                        agent
                      </span>
                      <span className="font-mono text-[10px] text-ember-600 dark:text-ember-400 animate-blink">
                        ●
                      </span>
                      <span className="font-mono text-[10px] text-ink-400 dark:text-ink-500">
                        streaming
                      </span>
                    </div>
                    <div className="relative">
                      <Markdown text={text} />
                      <span className="inline-block w-1.5 h-4 align-text-bottom bg-ember-500/60 ml-0.5 animate-blink" />
                    </div>
                  </div>
                </li>
              ))}
              {disabled && streamEntries.length === 0 && (
                <li className="relative">
                  <span className="absolute -left-9 top-0 flex h-6 w-6 items-center justify-center rounded-full border border-ember-500/30 bg-ember-500/15">
                    <span className="h-1.5 w-1.5 rounded-full bg-ember-500 animate-blink" />
                  </span>
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="text-[12px] text-ember-700 dark:text-ember-300 font-medium">
                      agent is thinking
                    </span>
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
                </li>
              )}
            </ol>
          )}
        </div>
        </div>
      </div>

      {/* Input */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="border-t border-ink-900/10 dark:border-ink-50/10 px-6 py-4"
      >
        <div className="mx-auto max-w-3xl">
          {/* Inline plan strip — shows the agent's live TodoWrite plan
              right above the input, claude-code style. Highlights the
              in-progress item, lists pending below it, collapses
              completed into a count. Full history lives in the right
              sidebar's Todos tab. */}
          {plan && plan.length > 0 && <PlanStrip plan={plan} />}
          {/* Steer queue — each pending message gets its own row so
              long inputs stay readable. Items live until the operator
              clicks Steer to fire them (writes to stdin for claude,
              SIGINT-respawn for codex). Once fired, the message lands
              in the chat and the row vanishes. */}
          {queue.length > 0 && (
            <div className="mb-2.5 overflow-hidden rounded-lg border border-violet-500/30 bg-gradient-to-br from-violet-500/[0.07] via-violet-500/[0.04] to-transparent shadow-[0_1px_0_rgba(139,92,246,0.06),0_8px_24px_-12px_rgba(139,92,246,0.18)] dark:from-violet-500/[0.12] dark:via-violet-500/[0.07] animate-fade-in">
              <header className="flex items-center justify-between gap-2 px-3 py-1.5 bg-gradient-to-r from-violet-500/[0.08] to-transparent border-b border-violet-500/15">
                <span className="inline-flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-violet-700 dark:text-violet-300 font-semibold">
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inset-0 rounded-full bg-violet-500/50 animate-pulse-ring" />
                    <span className="relative h-2 w-2 rounded-full bg-violet-500" />
                  </span>
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
                        className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md font-mono text-[10px] uppercase tracking-[0.1em] font-semibold bg-gradient-to-b from-violet-500 to-violet-600 text-white shadow-sm shadow-violet-900/20 hover:from-violet-400 hover:to-violet-500 active:from-violet-600 active:to-violet-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all hover:scale-[1.03] active:scale-[0.98]"
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

          <div className="relative">
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
                  ? "Type to queue — click Steer on a row to fire it…"
                  : "Send input to the agent…"
              }
              rows={3}
              data-shortcut-target="chat-input"
              className={cn(
                "resize-none pr-28 text-sm transition",
                disabled && "ring-1 ring-violet-500/30",
              )}
              aria-label="Message"
            />
            <div className="absolute right-2 bottom-2 flex items-center gap-2">
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
    </div>
  );
}

function TimelineItem({ message: m }: { message: Message }) {
  return (
    <li className="relative">
      {/* Glyph in gutter */}
      <span
        className={cn(
          "absolute -left-9 top-0 flex h-6 w-6 items-center justify-center rounded-full border",
          m.role === "user" &&
            "border-sky-500/30 bg-sky-500/15 text-sky-700 dark:text-sky-300",
          m.role === "agent" &&
            "border-ember-500/30 bg-ember-500/15 text-ember-700 dark:text-ember-300",
          m.role === "tool" &&
            "border-ink-900/15 bg-paper-100 text-ink-500 dark:border-ink-50/15 dark:bg-ink-700 dark:text-ink-400",
          m.role === "system" &&
            "border-ink-900/10 bg-paper-100 text-ink-400 dark:border-ink-50/10 dark:bg-ink-700 dark:text-ink-500",
        )}
      >
        {ROLE_GLYPH[m.role]}
      </span>

      {/* Body */}
      <div>
        <div className="flex items-baseline gap-2 mb-1">
          <span
            className={cn(
              "font-mono text-2xs font-medium uppercase tracking-[0.08em]",
              m.role === "user" && "text-sky-700 dark:text-sky-300",
              m.role === "agent" &&
                "text-ember-700 dark:text-ember-300",
              (m.role === "tool" || m.role === "system") &&
                "text-ink-500 dark:text-ink-400",
            )}
          >
            {ROLE_LABEL[m.role]}
          </span>
          <span className="font-mono text-2xs text-ink-400 dark:text-ink-500">
            {formatTs(m.ts)}
          </span>
        </div>
        {m.role === "tool" ? (
          <ToolLine content={m.content} />
        ) : m.role === "user" ? (
          <div className="whitespace-pre-wrap break-words text-sm leading-relaxed text-ink-900 dark:text-ink-50">
            {m.content}
          </div>
        ) : (
          <Markdown text={m.content} />
        )}
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
            // Inline code (no language class) renders as a small chip;
            // fenced code (className like `language-ts`) is rendered by `pre`.
            const isFenced = (className ?? "").includes("language-");
            if (isFenced) {
              return (
                <code className={cn(className, "font-mono text-[12px]")}>
                  {children}
                </code>
              );
            }
            return (
              <code className="rounded bg-ink-900/[0.06] px-1 py-0.5 font-mono text-[12px] text-ink-900 dark:bg-ink-50/[0.08] dark:text-ink-50">
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre className="my-2 overflow-x-auto rounded-md border border-ink-900/10 bg-ink-900/[0.04] p-2.5 font-mono text-[12px] leading-relaxed text-ink-700 dark:border-ink-50/10 dark:bg-ink-50/[0.04] dark:text-ink-200">
              {children}
            </pre>
          ),
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
          className="px-3 pb-2 space-y-1 border-t border-ink-900/[0.04] dark:border-ink-50/[0.04] pt-1.5"
        >
          {plan.map((item, i) => (
            <li
              key={i}
              className={cn(
                "flex items-start gap-2 rounded-md px-1.5 py-0.5 transition-all animate-slide-in",
                item.status === "in_progress" &&
                  "bg-gradient-to-r from-ember-500/[0.08] to-transparent",
              )}
            >
              <span className="mt-1">
                <PlanGlyph status={item.status} />
              </span>
              <span
                className={cn(
                  "flex-1 min-w-0 text-[12.5px] leading-snug transition-all duration-300",
                  item.status === "completed" &&
                    "line-through text-emerald-700/85 dark:text-emerald-300/85",
                  item.status === "in_progress" &&
                    "text-ink-900 dark:text-ink-50 font-medium",
                  item.status === "pending" && "text-ink-700 dark:text-ink-200",
                )}
              >
                {item.status === "in_progress"
                  ? (item.activeForm ?? item.content)
                  : item.content}
              </span>
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
      <span className="relative inline-grid place-items-center size-3.5 rounded-full border border-ember-500/70 bg-ember-500/25 shrink-0 animate-active-glow">
        <span className="absolute inset-0 rounded-full bg-ember-500/30 animate-pulse-ring" />
        <span className="relative size-1.5 rounded-full bg-ember-500" />
      </span>
    );
  }
  return (
    <span className="inline-block size-3.5 rounded-full border-[1.5px] border-ink-900/25 dark:border-ink-50/25 shrink-0 transition-colors hover:border-ember-500/50" />
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
