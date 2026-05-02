import { useMemo, useState } from "react";
import {
  Bot,
  Check,
  ChevronDown,
  Circle,
  Loader2,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import type { Todo, TodoStatus } from "@agentd/contracts";
import {
  useCreateTodo,
  useDeleteTodo,
  useTodos,
  useUpdateTodo,
} from "@/queries";
import { cn } from "@/lib/utils";

/**
 * Reusable todos panel — works task- or project-scoped via the
 * `taskId` / `projectId` props. Visually sectioned by status so the
 * eye lands on what's *active* first; done/cancelled rows fold into
 * a collapsed history pane the operator can pop open.
 *
 * Agent-source rows (the agent's TodoWrite plan, mirrored via
 * `syncAgentPlan` server-side) wear a small bot glyph so the
 * operator can tell theirs apart from the agent's at a glance.
 */
export function TodosPanel({
  projectId,
  taskId,
  title = "Todos",
  emptyHint,
  compact = false,
}: {
  projectId?: string;
  taskId?: string;
  title?: string;
  emptyHint?: string;
  /** Tighter spacing — used for the right-side task sidebar. */
  compact?: boolean;
}) {
  const scope: { projectId?: string; taskId?: string } = {};
  if (projectId !== undefined) scope.projectId = projectId;
  if (taskId !== undefined) scope.taskId = taskId;

  const todosQ = useTodos(scope);
  const create = useCreateTodo();
  const update = useUpdateTodo();
  const del = useDeleteTodo();

  const items = todosQ.data?.todos ?? [];
  const [draft, setDraft] = useState("");
  const [showHistory, setShowHistory] = useState(false);

  // Buckets in the order we render them — `in_progress` first because
  // that's what the operator looks for when glancing at the panel.
  const buckets = useMemo(() => {
    const inProgress: Todo[] = [];
    const pending: Todo[] = [];
    const done: Todo[] = [];
    const cancelled: Todo[] = [];
    for (const t of items) {
      if (t.status === "in_progress") inProgress.push(t);
      else if (t.status === "pending") pending.push(t);
      else if (t.status === "done") done.push(t);
      else cancelled.push(t);
    }
    return { inProgress, pending, done, cancelled };
  }, [items]);

  const openCount = buckets.inProgress.length + buckets.pending.length;
  const historyCount = buckets.done.length + buckets.cancelled.length;

  const submit = async () => {
    const text = draft.trim();
    if (!text) return;
    await create.mutateAsync({
      ...(projectId ? { projectId } : {}),
      ...(taskId ? { taskId } : {}),
      text,
    });
    setDraft("");
  };

  const setStatus = (todo: Todo, next: TodoStatus) => {
    if (todo.status === next) return;
    void update.mutateAsync({ id: todo.id, patch: { status: next } });
  };

  const rowGap = compact ? "py-1" : "py-1.5";

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="flex items-baseline justify-between border-b border-ink-900/[0.06] px-3 py-2 dark:border-ink-50/[0.06] shrink-0">
        <h3 className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-500 dark:text-ink-400">
          {title}
        </h3>
        <span className="font-mono text-[10px] tabular-nums text-ink-400 dark:text-ink-500">
          {openCount} open
          {historyCount > 0 && ` · ${historyCount} done`}
        </span>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {items.length === 0 ? (
          <div className="px-3 py-6 text-center text-[11px] text-ink-500 dark:text-ink-400 italic">
            {emptyHint ?? "no todos yet — type below to add one"}
          </div>
        ) : (
          <div>
            {buckets.inProgress.length > 0 && (
              <Section label="in progress" tone="ember">
                {buckets.inProgress.map((t) => (
                  <TodoRow
                    key={t.id}
                    todo={t}
                    rowClass={rowGap}
                    onSetStatus={(s) => setStatus(t, s)}
                    onDelete={() => void del.mutateAsync(t.id)}
                  />
                ))}
              </Section>
            )}
            {buckets.pending.length > 0 && (
              <Section
                label="todo"
                tone="ink"
                noTopBorder={buckets.inProgress.length === 0}
              >
                {buckets.pending.map((t) => (
                  <TodoRow
                    key={t.id}
                    todo={t}
                    rowClass={rowGap}
                    onSetStatus={(s) => setStatus(t, s)}
                    onDelete={() => void del.mutateAsync(t.id)}
                  />
                ))}
              </Section>
            )}
            {historyCount > 0 && (
              <Section
                label={`history · ${historyCount}`}
                tone="ink"
                collapsible
                collapsed={!showHistory}
                onToggle={() => setShowHistory((v) => !v)}
                noTopBorder={openCount === 0}
              >
                {showHistory &&
                  [...buckets.done, ...buckets.cancelled].map((t) => (
                    <TodoRow
                      key={t.id}
                      todo={t}
                      rowClass={rowGap}
                      onSetStatus={(s) => setStatus(t, s)}
                      onDelete={() => void del.mutateAsync(t.id)}
                    />
                  ))}
              </Section>
            )}
          </div>
        )}
      </div>

      <form
        className="flex items-center gap-1 border-t border-ink-900/[0.06] px-2 py-2 dark:border-ink-50/[0.06] shrink-0"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="add todo…"
          className="flex-1 h-7 bg-transparent border-0 outline-none focus:ring-0 text-[12px] text-ink-900 dark:text-ink-50 placeholder:text-ink-400"
          spellCheck={false}
        />
        <button
          type="submit"
          disabled={!draft.trim() || create.isPending}
          className="h-7 px-2 rounded font-mono text-[10px] uppercase tracking-[0.08em] border border-ember-500/40 bg-ember-500/10 text-ember-700 dark:text-ember-300 disabled:opacity-40"
        >
          {create.isPending ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Plus className="h-3 w-3" />
          )}
        </button>
      </form>
    </section>
  );
}

function Section({
  label,
  tone,
  collapsible = false,
  collapsed = false,
  onToggle,
  noTopBorder = false,
  children,
}: {
  label: string;
  tone: "ember" | "ink";
  collapsible?: boolean;
  collapsed?: boolean;
  onToggle?: () => void;
  noTopBorder?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={cn(!noTopBorder && "border-t border-ink-900/[0.04] dark:border-ink-50/[0.04]")}>
      <button
        type="button"
        onClick={onToggle}
        disabled={!collapsible}
        className={cn(
          "flex w-full items-center gap-1.5 px-3 py-1 font-mono text-[9px] uppercase tracking-[0.14em]",
          tone === "ember"
            ? "text-ember-700 dark:text-ember-300"
            : "text-ink-400 dark:text-ink-500",
          collapsible && "hover:bg-ink-900/[0.03] dark:hover:bg-ink-50/[0.03] cursor-pointer",
          !collapsible && "cursor-default",
        )}
      >
        {collapsible && (
          <ChevronDown
            className={cn(
              "h-2.5 w-2.5 transition-transform",
              collapsed && "-rotate-90",
            )}
          />
        )}
        <span>{label}</span>
      </button>
      {!collapsed && children}
    </div>
  );
}

function TodoRow({
  todo,
  rowClass,
  onSetStatus,
  onDelete,
}: {
  todo: Todo;
  rowClass: string;
  onSetStatus: (s: TodoStatus) => void;
  onDelete: () => void;
}) {
  const isDone = todo.status === "done";
  const isCancelled = todo.status === "cancelled";
  const isInProgress = todo.status === "in_progress";
  const dim = isDone || isCancelled;

  return (
    <div
      className={cn(
        "group flex items-start gap-2 px-3 hover:bg-ink-900/[0.025] dark:hover:bg-ink-50/[0.025]",
        rowClass,
        dim && "opacity-55",
      )}
    >
      <StatusButton
        status={todo.status}
        onClick={() => onSetStatus(isDone ? "pending" : "done")}
        onLong={() => onSetStatus(isInProgress ? "pending" : "in_progress")}
      />
      <span
        className={cn(
          "flex-1 min-w-0 text-[12px] leading-snug break-words",
          (isDone || isCancelled) && "line-through",
          isCancelled && "text-ink-400 dark:text-ink-500",
          isDone && "text-ink-500 dark:text-ink-400",
        )}
      >
        {todo.text}
      </span>
      {todo.source === "agent" && (
        <span
          title="Written by the agent"
          className="mt-0.5 inline-flex items-center gap-0.5 font-mono text-[9px] uppercase tracking-[0.08em] text-violet-700 dark:text-violet-300 shrink-0"
        >
          <Bot className="h-2.5 w-2.5" />
        </span>
      )}
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
        {!isCancelled && !isDone && (
          <button
            type="button"
            onClick={() => onSetStatus("cancelled")}
            title="Cancel"
            className="rounded p-0.5 text-ink-400 hover:bg-ink-900/[0.06] hover:text-amber-700 dark:hover:bg-ink-50/[0.06] dark:hover:text-amber-300"
          >
            <X className="h-3 w-3" />
          </button>
        )}
        <button
          type="button"
          onClick={onDelete}
          title="Delete"
          className="rounded p-0.5 text-ink-400 hover:bg-ink-900/[0.06] hover:text-red-700 dark:hover:bg-ink-50/[0.06] dark:hover:text-red-300"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

/**
 * Three-state checkbox-ish button. Click cycles done<->open. The
 * "long press" handler bumps to/from in-progress so the operator can
 * mark something active without leaving the keyboard. We treat alt-click
 * and right-click as the long-press action.
 */
function StatusButton({
  status,
  onClick,
  onLong,
}: {
  status: TodoStatus;
  onClick: () => void;
  onLong: () => void;
}) {
  const isDone = status === "done";
  const isCancelled = status === "cancelled";
  const isInProgress = status === "in_progress";
  return (
    <button
      type="button"
      onClick={(e) => {
        if (e.altKey) {
          e.preventDefault();
          onLong();
          return;
        }
        onClick();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onLong();
      }}
      title={isDone ? "Click to reopen · alt-click to mark active" : "Click to mark done · alt-click to mark active"}
      className={cn(
        "mt-0.5 grid place-items-center size-4 shrink-0 rounded-full border transition-colors",
        isDone &&
          "border-emerald-500/60 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
        isInProgress && "border-ember-500/60 bg-ember-500/20",
        isCancelled && "border-ink-900/15 bg-ink-900/[0.05] dark:border-ink-50/15 dark:bg-ink-50/[0.05]",
        !isDone && !isInProgress && !isCancelled && "border-ink-900/25 hover:border-ink-900/45 dark:border-ink-50/25 dark:hover:border-ink-50/45",
      )}
    >
      {isDone && <Check className="h-2.5 w-2.5" />}
      {isInProgress && (
        <span className="size-1.5 rounded-full bg-ember-500 animate-blink" />
      )}
      {isCancelled && <X className="h-2.5 w-2.5 text-ink-400" />}
      {!isDone && !isInProgress && !isCancelled && (
        <Circle className="h-1.5 w-1.5 opacity-0" />
      )}
    </button>
  );
}
