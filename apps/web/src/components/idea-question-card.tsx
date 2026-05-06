import { useMemo, useState } from "react";
import { CornerDownLeft, MessageCircleQuestion, Pencil } from "lucide-react";
import type { IdeaQuestion } from "@agentd/contracts";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/**
 * Renders a single `<ask-user>` question the agent emitted during
 * brainstorm / idea-workshop chat / plan drafting. Mirrors the
 * AskUserQuestion / request_user_input UX in Claude Code + Codex —
 * each option is a tappable button with a tradeoff line, and the
 * operator can always type their own free-form answer instead.
 *
 * Props:
 *   question  — the parsed `IdeaQuestion`.
 *   onAnswer  — fires with the operator's chosen answer (option label
 *               or free-form text). The caller submits the next chat
 *               turn with this string as the user message.
 *   disabled  — true when a turn is already mid-flight, so the button
 *               row is locked until the previous turn completes.
 *   answered  — once the operator has picked, the card collapses to
 *               a one-line "→ <answer>" trail so the message thread
 *               retains the choice context after a reload.
 */
export function IdeaQuestionCard({
  question,
  onAnswer,
  disabled,
  answered,
  className,
}: {
  question: IdeaQuestion;
  onAnswer: (text: string) => void;
  disabled?: boolean;
  answered?: string | null;
  className?: string;
}) {
  const [otherOpen, setOtherOpen] = useState(false);
  const [otherText, setOtherText] = useState("");

  const allowOther = question.allowOther !== false;
  const optionsKey = useMemo(
    () => question.options.map((o) => o.label).join(""),
    [question.options],
  );

  if (answered) {
    return (
      <div
        key={`${question.id}:${optionsKey}`}
        className={cn(
          "mt-3 rounded-md border border-ink-200/70 bg-ink-50/40 px-3 py-2 dark:border-ink-800/70 dark:bg-ink-900/40",
          className,
        )}
      >
        <div className="flex items-center gap-1.5 text-[10.5px] font-mono uppercase tracking-[0.1em] text-ink-400 dark:text-ink-500">
          <MessageCircleQuestion className="h-3 w-3" />
          {question.header}
          <span className="text-ink-300 dark:text-ink-600">·</span>
          <span className="normal-case tracking-normal text-ink-500 dark:text-ink-400">
            answered
          </span>
        </div>
        <div className="mt-1 text-[12.5px] text-ink-700 dark:text-ink-300">
          → {answered}
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "mt-3 rounded-md border border-ember-300/50 bg-ember-50/40 p-3 dark:border-ember-500/30 dark:bg-ember-500/[0.06]",
        className,
      )}
    >
      <div className="flex items-center gap-1.5 mb-2 text-[10.5px] font-mono uppercase tracking-[0.12em] text-ember-700 dark:text-ember-300">
        <MessageCircleQuestion className="h-3 w-3" />
        <span>{question.header}</span>
      </div>
      <div className="text-[13px] font-medium text-ink-800 dark:text-ink-100 leading-snug">
        {question.question}
      </div>
      <div className="mt-3 flex flex-col gap-1.5">
        {question.options.map((opt, i) => (
          <button
            key={`${question.id}:${i}:${opt.label}`}
            type="button"
            disabled={disabled}
            onClick={() => onAnswer(opt.label)}
            className={cn(
              "group w-full text-left rounded-md border border-ink-200/70 bg-paper px-3 py-2 transition",
              "hover:border-ember-400/60 hover:bg-ember-50/50",
              "dark:border-ink-800/60 dark:bg-ink-900/40 dark:hover:border-ember-500/60 dark:hover:bg-ember-500/[0.08]",
              "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-ink-200/70 disabled:hover:bg-paper dark:disabled:hover:bg-ink-900/40",
            )}
          >
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-[10px] tabular-nums text-ink-400 dark:text-ink-600 select-none">
                {i + 1}.
              </span>
              <span className="text-[13px] font-medium text-ink-800 dark:text-ink-100 group-hover:text-ember-700 dark:group-hover:text-ember-300">
                {opt.label}
              </span>
            </div>
            {opt.description && (
              <div className="mt-0.5 ml-5 text-[11.5px] text-ink-500 dark:text-ink-400 leading-snug">
                {opt.description}
              </div>
            )}
          </button>
        ))}
      </div>
      {allowOther && (
        <div className="mt-2.5">
          {otherOpen ? (
            <div className="flex flex-col gap-1.5">
              <Textarea
                autoFocus
                rows={2}
                placeholder="Type your own answer…"
                value={otherText}
                disabled={disabled}
                onChange={(e) => setOtherText(e.target.value)}
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    (e.metaKey || e.ctrlKey) &&
                    otherText.trim()
                  ) {
                    e.preventDefault();
                    onAnswer(otherText.trim());
                    setOtherText("");
                    setOtherOpen(false);
                  }
                }}
                className="text-[13px]"
              />
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  type="button"
                  disabled={disabled || !otherText.trim()}
                  onClick={() => {
                    if (!otherText.trim()) return;
                    onAnswer(otherText.trim());
                    setOtherText("");
                    setOtherOpen(false);
                  }}
                  className="h-7 px-2 text-[11.5px]"
                >
                  <CornerDownLeft className="h-3 w-3 mr-1" />
                  Send
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  type="button"
                  onClick={() => {
                    setOtherText("");
                    setOtherOpen(false);
                  }}
                  className="h-7 px-2 text-[11.5px] text-ink-500"
                >
                  Cancel
                </Button>
                <span className="ml-auto font-mono text-[10px] text-ink-400 dark:text-ink-600">
                  ⌘↵ to send
                </span>
              </div>
            </div>
          ) : (
            <button
              type="button"
              disabled={disabled}
              onClick={() => setOtherOpen(true)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11.5px] font-medium transition",
                "text-ink-500 hover:text-ember-700 hover:bg-ember-50/50",
                "dark:text-ink-400 dark:hover:text-ember-300 dark:hover:bg-ember-500/[0.08]",
                "disabled:cursor-not-allowed disabled:opacity-50",
              )}
            >
              <Pencil className="h-3 w-3" />
              Other…
            </button>
          )}
        </div>
      )}
    </div>
  );
}
