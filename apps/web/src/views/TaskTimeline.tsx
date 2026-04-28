import { useEffect, useRef, useState } from "react";
import { Loader2, Send, User2, Wrench } from "lucide-react";
import type { Message } from "@agentd/contracts";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Kbd } from "@/components/ui/kbd";
import { cn, formatTs } from "@/lib/utils";
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
}: {
  taskId: string;
  messages: Message[];
  appendLocal: (role: Message["role"], content: string) => void;
  onError: (m: string) => void;
  disabled: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [text, setText] = useState("");
  const send = useSendInput(taskId);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight });
  }, [messages.length]);

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
                  void submit();
                }
              }}
              placeholder={
                disabled
                  ? "Task is closed — read-only"
                  : "Send input to agent…"
              }
              rows={3}
              data-shortcut-target="chat-input"
              disabled={disabled}
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
            "border-vermilion-500/30 bg-vermilion-500/15 text-vermilion-700 dark:text-vermilion-300",
          m.role === "tool" &&
            "border-ink-900/15 bg-cream-100 text-ink-500 dark:border-ink-50/15 dark:bg-ink-700 dark:text-ink-400",
          m.role === "system" &&
            "border-ink-900/10 bg-cream-100 text-ink-400 dark:border-ink-50/10 dark:bg-ink-700 dark:text-ink-500",
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
                "text-vermilion-700 dark:text-vermilion-300",
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
