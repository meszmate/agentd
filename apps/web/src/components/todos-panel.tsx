import { useEffect, useMemo, useState } from "react";
import {
  Bot,
  Check,
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
import { cn, formatTs, formatTsAbsolute } from "@/lib/utils";

/**
 * Todos rendered as a vertical timeline of work — completed entries
 * at the top with their completion time, the current in-progress
 * item highlighted in the middle, and pending items at the bottom in
 * plan order. A continuous spine connects them so the eye reads the
 * panel as a story: "this happened, this is happening, this is next."
 *
 * Agent-source rows (mirrored from the runner's TodoWrite plan via
 * `syncAgentPlan`) wear a small bot glyph so the operator can tell
 * theirs apart from manual additions at a glance.
 */
export function TodosPanel({
  projectId,
  taskId,
  title = "Timeline",
  emptyHint,
}: {
  projectId?: string;
  taskId?: string;
  title?: string;
  emptyHint?: string;
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

  // Tick once a minute so relative timestamps stay fresh while the
  // panel is open. Cheap — `formatTs` is pure, this just rerenders
  // the rows so "5m ago" becomes "6m ago" without a refresh.
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  const ordered = useMemo(() => {
    // Top: completed/cancelled, most-recent-first (when did this happen).
    // Middle: in-progress, in plan order.
    // Bottom: pending, in plan order (what's coming next).
    const past = items
      .filter((t) => t.status === "done" || t.status === "cancelled")
      .sort(
        (a, b) =>
          (b.completedAt ?? b.updatedAt) - (a.completedAt ?? a.updatedAt),
      );
    const now = items
      .filter((t) => t.status === "in_progress")
      .sort((a, b) => a.sortOrder - b.sortOrder);
    const next = items
      .filter((t) => t.status === "pending")
      .sort((a, b) => a.sortOrder - b.sortOrder);
    return { past, now, next };
  }, [items]);

  const total = items.length;
  const doneCount = ordered.past.filter((t) => t.status === "done").length;

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

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="flex items-baseline justify-between border-b border-ink-900/[0.06] px-3 py-2 dark:border-ink-50/[0.06] shrink-0">
        <h3 className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-500 dark:text-ink-400">
          {title}
        </h3>
        <span className="font-mono text-[10px] tabular-nums text-ink-400 dark:text-ink-500">
          {doneCount}/{total} done
        </span>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {total === 0 ? (
          <div className="px-3 py-8 text-center text-[11px] text-ink-500 dark:text-ink-400 italic">
            {emptyHint ?? "no todos yet — add one below or wait for the agent to write a plan"}
          </div>
        ) : (
          <ol className="relative px-4 py-3 before:absolute before:left-[1.4rem] before:top-3 before:bottom-3 before:w-px before:bg-ink-900/10 dark:before:bg-ink-50/10">
            {ordered.past.length > 0 && (
              <SectionHeader label={`done · ${ordered.past.length}`} />
            )}
            {ordered.past.map((t) => (
              <TimelineItem
                key={t.id}
                todo={t}
                onSetStatus={(s) => setStatus(t, s)}
                onDelete={() => void del.mutateAsync(t.id)}
              />
            ))}
            {ordered.now.length > 0 && (
              <SectionHeader label="now" tone="ember" />
            )}
            {ordered.now.map((t) => (
              <TimelineItem
                key={t.id}
                todo={t}
                onSetStatus={(s) => setStatus(t, s)}
                onDelete={() => void del.mutateAsync(t.id)}
              />
            ))}
            {ordered.next.length > 0 && (
              <SectionHeader label={`next · ${ordered.next.length}`} />
            )}
            {ordered.next.map((t) => (
              <TimelineItem
                key={t.id}
                todo={t}
                onSetStatus={(s) => setStatus(t, s)}
                onDelete={() => void del.mutateAsync(t.id)}
              />
            ))}
          </ol>
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

function SectionHeader({
  label,
  tone = "ink",
}: {
  label: string;
  tone?: "ink" | "ember";
}) {
  return (
    <li className="relative -ml-[1px] mt-3 mb-1.5 first:mt-0 list-none">
      <span
        className={cn(
          "ml-8 font-mono text-[9px] uppercase tracking-[0.16em]",
          tone === "ember"
            ? "text-ember-700 dark:text-ember-300"
            : "text-ink-400 dark:text-ink-500",
        )}
      >
        {label}
      </span>
    </li>
  );
}

function TimelineItem({
  todo,
  onSetStatus,
  onDelete,
}: {
  todo: Todo;
  onSetStatus: (s: TodoStatus) => void;
  onDelete: () => void;
}) {
  const isDone = todo.status === "done";
  const isCancelled = todo.status === "cancelled";
  const isInProgress = todo.status === "in_progress";
  const dim = isDone || isCancelled;

  // Pick the timestamp that "describes" this row best:
  //   completed/cancelled → completedAt (when it landed)
  //   in_progress         → updatedAt   (when it became active)
  //   pending             → createdAt   (when it was added)
  const stampMs =
    (isDone || isCancelled
      ? todo.completedAt ?? todo.updatedAt
      : isInProgress
        ? todo.updatedAt
        : todo.createdAt) ?? todo.createdAt;

  return (
    <li
      className={cn(
        // animate-fade-in is defined in tailwind.config — fades the
        // row in when it first mounts so adds + status changes feel
        // alive instead of pop-in.
        "group relative pl-8 py-1.5 list-none animate-fade-in",
      )}
    >
      {/* Glyph sits on the spine. Pulse-ring around the in-progress
          dot draws the eye to "what we're working on right now". */}
      <span
        className="absolute left-[0.85rem] top-2 z-10"
        title={statusLabel(todo.status)}
      >
        {isInProgress && (
          <span className="absolute inset-0 -m-1 rounded-full bg-ember-500/30 animate-ping" />
        )}
        <StatusButton
          status={todo.status}
          onClick={() => onSetStatus(isDone ? "pending" : "done")}
          onLong={() => onSetStatus(isInProgress ? "pending" : "in_progress")}
        />
      </span>

      <div className="flex items-start gap-2">
        <div
          className={cn(
            "flex-1 min-w-0 transition-all duration-300",
            isInProgress && "rounded-md border border-ember-500/40 bg-ember-500/[0.08] px-2 py-1 -ml-2 -my-1 shadow-[0_0_0_1px_rgba(247,127,0,0.06)]",
          )}
        >
          <div className="flex items-baseline gap-2">
            <span
              className={cn(
                "flex-1 min-w-0 text-[12.5px] leading-snug break-words transition-all duration-300",
                isDone && "line-through text-emerald-700/80 dark:text-emerald-300/80",
                isCancelled && "line-through text-ink-400 dark:text-ink-500",
                isInProgress && "text-ink-900 dark:text-ink-50 font-medium",
                !dim && !isInProgress && "text-ink-700 dark:text-ink-200",
              )}
            >
              {todo.text}
            </span>
            <span
              title={formatTsAbsolute(stampMs)}
              className={cn(
                "font-mono text-[10px] tabular-nums shrink-0 transition-colors duration-300",
                isInProgress
                  ? "text-ember-700 dark:text-ember-300"
                  : isDone
                    ? "text-emerald-700/70 dark:text-emerald-300/70"
                    : "text-ink-400 dark:text-ink-500",
              )}
            >
              {isInProgress ? (
                <span className="inline-flex items-center gap-1">
                  <span className="size-1 rounded-full bg-ember-500 animate-blink" />
                  now
                </span>
              ) : (
                formatTs(stampMs)
              )}
            </span>
          </div>
          {/* Source/meta line — only when there's something extra worth
              showing. Keep it sparse so the row stays one-line by default. */}
          {(todo.source === "agent" || isCancelled) && (
            <div className="mt-0.5 flex items-center gap-2 font-mono text-[9.5px] uppercase tracking-[0.08em] text-ink-400 dark:text-ink-500">
              {todo.source === "agent" && (
                <span className="inline-flex items-center gap-0.5 text-violet-700 dark:text-violet-300">
                  <Bot className="h-2.5 w-2.5" /> agent
                </span>
              )}
              {isCancelled && <span>cancelled</span>}
            </div>
          )}
        </div>
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
          {!isCancelled && !isDone && (
            <button
              type="button"
              onClick={() => onSetStatus("cancelled")}
              title="Cancel"
              className="rounded p-0.5 text-ink-400 hover:bg-ink-900/[0.06] hover:text-amber-700 dark:hover:bg-ink-50/[0.06] dark:hover:text-amber-300 transition-colors"
            >
              <X className="h-3 w-3" />
            </button>
          )}
          <button
            type="button"
            onClick={onDelete}
            title="Delete"
            className="rounded p-0.5 text-ink-400 hover:bg-ink-900/[0.06] hover:text-red-700 dark:hover:bg-ink-50/[0.06] dark:hover:text-red-300 transition-colors"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      </div>
    </li>
  );
}

function statusLabel(s: TodoStatus): string {
  if (s === "done") return "Done — click to reopen, alt-click to mark active";
  if (s === "in_progress") return "In progress — click to mark done";
  if (s === "cancelled") return "Cancelled — click to reopen";
  return "Pending — click to mark done, alt-click to mark active";
}

/**
 * Three-state status indicator. Click cycles done<->open. Alt-click
 * (or right-click) bumps to/from in-progress so the operator can
 * mark something active without opening a menu.
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
      className={cn(
        "relative grid place-items-center size-4 shrink-0 rounded-full border bg-paper-50 dark:bg-ink-900 transition-all duration-200",
        isDone &&
          "border-emerald-500/70 bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 scale-105",
        isInProgress && "border-ember-500/80 bg-ember-500/30",
        isCancelled && "border-ink-900/15 dark:border-ink-50/15",
        !isDone && !isInProgress && !isCancelled && "border-ink-900/25 hover:border-ember-500/60 hover:scale-110 dark:border-ink-50/25",
      )}
    >
      {isDone && <Check className="h-2.5 w-2.5 stroke-[3]" />}
      {isInProgress && (
        <span className="size-1.5 rounded-full bg-ember-500 animate-blink" />
      )}
      {isCancelled && <X className="h-2.5 w-2.5 text-ink-400" />}
    </button>
  );
}
