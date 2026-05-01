import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2, Send, User2, Wrench } from "lucide-react";
import type { Message } from "@agentd/contracts";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Kbd } from "@/components/ui/kbd";
import { useApp, useClient } from "@/AppContext";
import { cn, formatTokens, formatTs } from "@/lib/utils";
import { useSendInput } from "@/queries";

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
  // Auto-scroll on new messages or growing streams.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, streamEntries.map(([, t]) => t.length).join("|")]);

  const submit = async () => {
    const msg = text.trim();
    if (!msg) return;
    setText("");
    appendLocal("user", msg);
    try {
      await send.mutateAsync(msg);
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
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto">
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
                    <div className="text-[13px] text-ink-700 dark:text-ink-200 whitespace-pre-wrap break-words leading-relaxed">
                      {text}
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
                  <div className="flex items-baseline gap-2">
                    <span className="text-[12px] text-ember-700 dark:text-ember-300 font-medium">
                      agent is thinking
                    </span>
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

      {/* Input */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="border-t border-ink-900/10 dark:border-ink-50/10 px-6 py-4"
      >
        <div className="mx-auto max-w-3xl">
          <div className="relative">
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  if (!disabled) void submit();
                }
              }}
              placeholder={
                disabled
                  ? "agent is thinking — finish typing, send when it's done"
                  : "Send input to the agent…"
              }
              rows={3}
              data-shortcut-target="chat-input"
              className="resize-none pr-28 text-sm"
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
                disabled={send.isPending || disabled || !text.trim()}
              >
                {send.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Send className="h-3.5 w-3.5" />
                )}
                Send
              </Button>
            </div>
          </div>
        </div>
      </form>
    </div>
  );
}

function TimelineItem({ message: m }: { message: Message }) {
  const isMonoBlock = m.role === "tool" || m.role === "system";

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
        <div
          className={cn(
            "whitespace-pre-wrap break-words text-sm leading-relaxed text-ink-900 dark:text-ink-50",
            isMonoBlock &&
              "font-mono text-xs text-ink-500 dark:text-ink-400 rounded-md border border-ink-900/10 bg-ink-900/[0.03] px-2.5 py-1.5 dark:border-ink-50/10 dark:bg-ink-50/[0.03]",
          )}
        >
          {m.content}
        </div>
      </div>
    </li>
  );
}
