import { useState } from "react";
import {
  AlertTriangle,
  BookText,
  ChevronDown,
  FileText,
  Loader2,
  Sparkles,
  Wand2,
} from "lucide-react";
import type { Task } from "@agentd/contracts";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCompactTask, useTaskContext } from "@/queries";
import { useApp } from "@/AppContext";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { cn, formatTokens } from "@/lib/utils";

/**
 * Context inspector + compaction control. Mirrors Claude Code's pattern:
 * a usage bar showing how much of the conversation window is filled, plus
 * a `/compact` button (with optional focus) that nudges the agent to
 * summarize and shed working memory mid-task. The system-prompt suffix
 * (skills + agentInstructions) has its own budget, displayed alongside.
 */
export function TaskContext({ task }: { task: Task }) {
  const ctxQ = useTaskContext(task.id);

  if (ctxQ.isLoading) {
    return (
      <div className="px-5 py-4 space-y-3">
        <Skeleton className="h-4 w-1/2" />
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="rounded-lg border border-ink-900/10 dark:border-ink-50/10 p-3 space-y-2"
          >
            <Skeleton className="h-3 w-1/3" />
            <Skeleton className="h-2.5 w-full" />
            <Skeleton className="h-2.5 w-5/6" />
          </div>
        ))}
      </div>
    );
  }
  if (!ctxQ.data) {
    return (
      <div className="flex h-full items-center justify-center text-[12px] text-ink-500 dark:text-ink-400">
        Couldn't load context.
      </div>
    );
  }

  const { agentInstructions, skills, repoCanonical, suffix, conversation, catalogs } =
    ctxQ.data;

  const conversationPct = Math.round(
    (conversation.used / conversation.window) * 100,
  );
  const suffixPct = Math.min(
    100,
    Math.round((suffix.used / suffix.budget) * 100),
  );
  const overBudget = suffix.trimmed.length > 0;
  const conversationHot = conversationPct >= 80;

  return (
    <ScrollArea className="h-full">
      <div className="px-5 py-4 space-y-4">
        {/* Conversation usage — Claude-style bar */}
        <UsageBar
          label="Conversation"
          hint={
            conversationHot
              ? "near the model's limit · /compact to free space"
              : "tokens used in this task so far"
          }
          used={conversation.used}
          window={conversation.window}
          pct={conversationPct}
          tone={
            conversationPct < 60
              ? "ok"
              : conversationPct < 80
              ? "warn"
              : "danger"
          }
          right={<CompactDialogTrigger task={task} hot={conversationHot} />}
        />

        {/* Skill suffix usage */}
        <UsageBar
          label="System suffix"
          hint={
            overBudget
              ? `${suffix.trimmed.length} skill${suffix.trimmed.length === 1 ? "" : "s"} auto-trimmed to fit ${formatTokens(suffix.budget)} budget`
              : `${formatTokens(suffix.used)} of ${formatTokens(suffix.budget)} budget · skills + agent policy`
          }
          used={suffix.used}
          window={suffix.budget}
          pct={suffixPct}
          tone={overBudget ? "warn" : suffixPct < 80 ? "ok" : "warn"}
        />

        {suffix.trimmed.length > 0 && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2">
            <AlertTriangle className="h-3.5 w-3.5 text-amber-700 dark:text-amber-300 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="text-[11px] text-amber-700 dark:text-amber-300 font-medium">
                Auto-trimmed to fit budget
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                {suffix.trimmed.map((id) => (
                  <span
                    key={id}
                    className="inline-flex items-center h-5 px-1.5 rounded font-mono text-[10px] uppercase tracking-[0.06em] bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-500/30"
                  >
                    {id}
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}

        <hr className="border-ink-900/[0.06] dark:border-ink-50/[0.06]" />

        {agentInstructions && (
          <ContextBlock
            icon={<Sparkles className="h-3.5 w-3.5" />}
            label="Agent policy"
            hint="from Settings → Agent policy"
            body={agentInstructions}
          />
        )}

        {repoCanonical && (
          <ContextBlock
            icon={<FileText className="h-3.5 w-3.5" />}
            label={`Repo · ${repoCanonical.path}`}
            hint="picked up from the worktree"
            body={repoCanonical.content}
          />
        )}

        {skills.length === 0 ? (
          <div className="rounded-lg border border-dashed border-ink-900/15 dark:border-ink-50/15 px-4 py-6 text-center text-[11px] text-ink-500 dark:text-ink-400">
            No skills activated for this task.
          </div>
        ) : (
          skills.map((s) => {
            const wasTrimmed = suffix.trimmed.includes(s.id);
            return (
              <ContextBlock
                key={s.id}
                icon={<BookText className="h-3.5 w-3.5" />}
                label={`Skill · ${s.displayName}`}
                hint={s.id}
                body={s.body}
                accent={!wasTrimmed}
                trimmed={wasTrimmed}
              />
            );
          })
        )}

        {/* Repo-context catalog — what we actually inject */}
        {catalogs?.repo?.sections?.length ? (
          <div className="rounded-lg border border-ink-900/10 dark:border-ink-50/10 bg-paper-50 dark:bg-ink-800 overflow-hidden">
            <div className="flex items-baseline gap-2 px-4 py-2 border-b border-ink-900/[0.06] dark:border-ink-50/[0.06]">
              <FileText className="h-3.5 w-3.5 text-ember-500" />
              <span className="text-[12px] font-medium text-ink-900 dark:text-ink-50">
                Repo context (catalog)
              </span>
              <span className="ml-auto font-mono text-[10px] text-ink-500 dark:text-ink-400">
                {catalogs.repo.sections.reduce((s, x) => s + x.entries.length, 0)} pointers
              </span>
            </div>
            <div className="divide-y divide-ink-900/[0.06] dark:divide-ink-50/[0.06]">
              {catalogs.repo.sections.map((sec) => (
                <div key={sec.key} className="px-4 py-2.5">
                  <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-500 dark:text-ink-400 mb-1">
                    {sec.title}
                  </div>
                  <ul className="space-y-1">
                    {sec.entries.map((e) => (
                      <li key={e.relPath} className="flex items-baseline gap-2">
                        <code className="font-mono text-[11px] text-ember-700 dark:text-ember-300 shrink-0">
                          {e.relPath}
                        </code>
                        <span className="text-[11px] text-ink-700 dark:text-ink-200">
                          — {e.hint}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            <p className="border-t border-ink-900/[0.06] dark:border-ink-50/[0.06] bg-paper-100/40 dark:bg-ink-900/30 px-4 py-1.5 text-[10px] text-ink-500 dark:text-ink-400">
              Agent reads each on demand — none of these contents are pasted into the prompt.
            </p>
          </div>
        ) : null}

        {/* Skills catalog — names + paths only, not the bodies */}
        {catalogs?.skills?.entries?.length ? (
          <div className="rounded-lg border border-ink-900/10 dark:border-ink-50/10 bg-paper-50 dark:bg-ink-800 overflow-hidden">
            <div className="flex items-baseline gap-2 px-4 py-2 border-b border-ink-900/[0.06] dark:border-ink-50/[0.06]">
              <BookText className="h-3.5 w-3.5 text-ember-500" />
              <span className="text-[12px] font-medium text-ink-900 dark:text-ink-50">
                Skills catalog
              </span>
              <span className="ml-auto font-mono text-[10px] text-ink-500 dark:text-ink-400">
                {catalogs.skills.entries.length} active
              </span>
            </div>
            <ul className="divide-y divide-ink-900/[0.06] dark:divide-ink-50/[0.06]">
              {catalogs.skills.entries.map((e) => (
                <li key={e.id} className="px-4 py-2.5">
                  <div className="flex items-baseline gap-2">
                    <span className="text-[12px] font-medium text-ink-900 dark:text-ink-50">
                      {e.displayName ?? e.name}
                    </span>
                    <code className="font-mono text-[10px] text-ink-400 dark:text-ink-500">
                      {e.id}
                    </code>
                  </div>
                  {e.description && (
                    <p className="mt-0.5 text-[11px] text-ink-500 dark:text-ink-400 leading-snug">
                      {e.description}
                    </p>
                  )}
                  <div className="mt-1 font-mono text-[10px] text-ember-700 dark:text-ember-300 truncate">
                    {e.skillFile}
                  </div>
                </li>
              ))}
            </ul>
            <p className="border-t border-ink-900/[0.06] dark:border-ink-50/[0.06] bg-paper-100/40 dark:bg-ink-900/30 px-4 py-1.5 text-[10px] text-ink-500 dark:text-ink-400">
              Agent reads SKILL.md when relevant — only this catalog is injected up front.
            </p>
          </div>
        ) : null}

        {!agentInstructions && !repoCanonical && skills.length === 0 && (
          <div className="rounded-lg border border-ink-900/10 dark:border-ink-50/10 bg-paper-100 dark:bg-ink-800 px-4 py-3 text-[11px] text-ink-500 dark:text-ink-400">
            No additional context being injected. The agent runs on its
            default system prompt only.
          </div>
        )}
      </div>
    </ScrollArea>
  );
}

function UsageBar({
  label,
  hint,
  used,
  window,
  pct,
  tone,
  right,
}: {
  label: string;
  hint: string;
  used: number;
  window: number;
  pct: number;
  tone: "ok" | "warn" | "danger";
  right?: React.ReactNode;
}) {
  const barColor =
    tone === "danger"
      ? "bg-red-500"
      : tone === "warn"
      ? "bg-amber-500"
      : "bg-emerald-500";
  const dotColor =
    tone === "danger"
      ? "bg-red-500 animate-blink"
      : tone === "warn"
      ? "bg-amber-500"
      : "bg-emerald-500";
  return (
    <section>
      <div className="flex items-baseline gap-2 mb-1.5">
        <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", dotColor)} />
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-500 dark:text-ink-400 font-medium">
          {label}
        </span>
        <span className="font-mono text-[11px] tabular-nums text-ink-700 dark:text-ink-200">
          {formatTokens(used)}
        </span>
        <span className="text-ink-300 dark:text-ink-600">/</span>
        <span className="font-mono text-[11px] tabular-nums text-ink-400 dark:text-ink-500">
          {formatTokens(window)}
        </span>
        <span
          className={cn(
            "font-mono text-[10px] tabular-nums",
            tone === "danger"
              ? "text-red-700 dark:text-red-300 font-medium"
              : tone === "warn"
              ? "text-amber-700 dark:text-amber-300"
              : "text-ink-500 dark:text-ink-400",
          )}
        >
          {pct}%
        </span>
        {right && <span className="ml-auto">{right}</span>}
      </div>
      <div className="h-1.5 rounded-full overflow-hidden bg-ink-900/[0.05] dark:bg-ink-50/[0.05]">
        <div
          className={cn("h-full transition-[width] duration-300", barColor)}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
      <p className="mt-1 text-[10px] text-ink-500 dark:text-ink-400">{hint}</p>
    </section>
  );
}

function CompactDialogTrigger({ task, hot }: { task: Task; hot: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size="xs"
        variant={hot ? "default" : "outline"}
        onClick={() => setOpen(true)}
        className={cn(hot && "animate-blink")}
      >
        <Wand2 className="h-3 w-3" />
        Compact
      </Button>
      {open && (
        <CompactDialog task={task} open={open} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

function CompactDialog({
  task,
  open,
  onClose,
}: {
  task: Task;
  open: boolean;
  onClose: () => void;
}) {
  const compact = useCompactTask(task.id);
  const { toast } = useApp();
  const [focus, setFocus] = useState("");

  const submit = async () => {
    try {
      const r = await compact.mutateAsync(focus.trim());
      toast(`Compaction sent · ${r.directive.slice(0, 32)}…`);
      onClose();
      setFocus("");
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Compact context</DialogTitle>
          <DialogDescription>
            {task.agent === "claude" ? (
              <>
                Sends Claude Code's native{" "}
                <span className="font-mono text-ink-700 dark:text-ink-200">
                  /compact
                </span>{" "}
                command. The agent summarizes its history and continues with a
                smaller working memory.
              </>
            ) : (
              <>
                Tells Codex to summarize what it's done so far and continue
                from a compact summary, dropping intermediate scratch work.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <label className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-500 dark:text-ink-400 font-medium">
            Focus (optional)
          </label>
          <Textarea
            rows={3}
            value={focus}
            onChange={(e) => setFocus(e.target.value)}
            placeholder="e.g. focus on the database migration"
            className="text-sm"
            autoFocus
          />
          <p className="text-[10px] text-ink-500 dark:text-ink-400">
            What to keep front-of-mind. Leave blank for a generic summary.
          </p>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={compact.isPending}>
            {compact.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Wand2 className="h-3.5 w-3.5" />
            )}
            Send {task.agent === "claude" ? "/compact" : "summary"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ContextBlock({
  icon,
  label,
  hint,
  body,
  accent,
  trimmed,
}: {
  icon: React.ReactNode;
  label: string;
  hint: string;
  body: string;
  accent?: boolean;
  trimmed?: boolean;
}) {
  const [open, setOpen] = useState(true);
  const tokens = Math.ceil(body.length / 4);
  return (
    <div
      className={cn(
        "rounded-lg border overflow-hidden",
        trimmed
          ? "border-amber-500/30 bg-amber-500/[0.04] opacity-70"
          : accent
          ? "border-ember-500/25 bg-ember-500/[0.03]"
          : "border-ink-900/10 bg-paper-50 dark:border-ink-50/10 dark:bg-ink-800",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-ink-900/[0.02] dark:hover:bg-ink-50/[0.02]"
      >
        <span
          className={cn(
            "shrink-0",
            trimmed
              ? "text-amber-600"
              : accent
              ? "text-ember-500"
              : "text-ink-400 dark:text-ink-500",
          )}
        >
          {icon}
        </span>
        <span className="text-[12px] font-medium text-ink-900 dark:text-ink-50 truncate">
          {label}
        </span>
        <span className="font-mono text-[10px] text-ink-400 dark:text-ink-500 truncate">
          {hint}
        </span>
        {trimmed && (
          <span className="inline-flex items-center h-4 px-1 rounded font-mono text-[9px] uppercase tracking-[0.08em] bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-500/30">
            trimmed
          </span>
        )}
        <span className="ml-auto font-mono text-[10px] tabular-nums text-ink-400 dark:text-ink-500">
          ~{tokens} tok
        </span>
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 text-ink-400 transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      {open && (
        <pre className="border-t border-ink-900/[0.06] dark:border-ink-50/[0.06] px-3 py-2.5 font-mono text-[11px] leading-relaxed text-ink-700 dark:text-ink-200 whitespace-pre-wrap break-words max-h-[400px] overflow-y-auto">
          {body || "(empty)"}
        </pre>
      )}
    </div>
  );
}
