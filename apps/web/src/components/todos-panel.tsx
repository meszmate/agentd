import { useEffect, useMemo, useState } from "react";
import { useAutoAnimate } from "@formkit/auto-animate/react";
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
 * Status language matches the inline plan strip: emerald = done,
 * ember = active, ink = pending.
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

  // Tick once a minute so relative timestamps stay fresh.
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  // Auto-animate handles the position animation when an item changes
  // status (sliding from "now" → "done", etc). The CSS transitions on
  // text color + strikethrough handle the visual mark itself.

  const ordered = useMemo(() => {
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

  // Single flat list rendered in one <ol> so auto-animate can FLIP
  // rows that cross section boundaries (e.g. an "in progress" item
  // marked done glides up into the "done" group instead of teleporting).
  type Row =
    | { kind: "header"; id: string; label: string; tone: "ink" | "ember"; pulse: boolean }
    | { kind: "todo"; id: string; todo: Todo };
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    if (ordered.past.length > 0) {
      out.push({
        kind: "header",
        id: "h:done",
        label: `done · ${ordered.past.length}`,
        tone: "ink",
        pulse: false,
      });
      for (const t of ordered.past) out.push({ kind: "todo", id: t.id, todo: t });
    }
    if (ordered.now.length > 0) {
      out.push({
        kind: "header",
        id: "h:now",
        label: "now",
        tone: "ember",
        pulse: true,
      });
      for (const t of ordered.now) out.push({ kind: "todo", id: t.id, todo: t });
    }
    if (ordered.next.length > 0) {
      out.push({
        kind: "header",
        id: "h:next",
        label: `next · ${ordered.next.length}`,
        tone: "ink",
        pulse: false,
      });
      for (const t of ordered.next) out.push({ kind: "todo", id: t.id, todo: t });
    }
    return out;
  }, [ordered]);

  // FLIP animator on the <ol>. Slightly longer duration + a softer
  // out-quart easing so the slide feels deliberate and luxurious
  // rather than rushed.
  const [olRef] = useAutoAnimate<HTMLOListElement>({
    duration: 420,
    easing: "cubic-bezier(0.16, 1, 0.3, 1)",
  });

  const total = items.length;
  const doneCount = ordered.past.filter((t) => t.status === "done").length;
  const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0;

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
      <header className="flex items-center justify-between gap-2 border-b border-ink-900/[0.06] px-3 py-2.5 dark:border-ink-50/[0.06] shrink-0 bg-gradient-to-b from-paper-50 to-transparent dark:from-ink-800/40">
        <div className="flex items-center gap-2">
          <h3 className="font-mono text-[10px] uppercase tracking-[0.16em] font-semibold text-ink-700 dark:text-ink-200">
            {title}
          </h3>
          {total > 0 && (
            <>
              <span className="relative h-1 w-16 rounded-full bg-ink-900/[0.08] dark:bg-ink-50/[0.08] overflow-hidden">
                <span
                  className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-emerald-400 to-emerald-500 transition-all duration-500"
                  style={{ width: `${pct}%` }}
                />
              </span>
              <span className="font-mono text-[10px] tabular-nums text-ink-500 dark:text-ink-400">
                {doneCount}/{total}
              </span>
            </>
          )}
        </div>
        {ordered.now.length > 0 && (
          <span className="inline-flex items-center gap-1 font-mono text-[9px] uppercase tracking-[0.12em] text-ember-700 dark:text-ember-300">
            <span className="size-1 rounded-full bg-ember-500 animate-blink" />
            active
          </span>
        )}
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {total === 0 ? (
          <div className="px-4 py-12 text-center">
            <div className="mx-auto mb-3 grid place-items-center size-10 rounded-full bg-ink-900/[0.04] dark:bg-ink-50/[0.04]">
              <Plus className="h-4 w-4 text-ink-400 dark:text-ink-500" />
            </div>
            <p className="text-[11.5px] text-ink-500 dark:text-ink-400">
              {emptyHint ?? "no todos yet"}
            </p>
            <p className="mt-1 text-[10px] text-ink-400 dark:text-ink-500">
              type below or wait for the agent's plan
            </p>
          </div>
        ) : (
          <ol
            ref={olRef}
            className="relative px-4 py-3 before:absolute before:left-[1.4rem] before:top-3 before:bottom-3 before:w-px before:bg-gradient-to-b before:from-ink-900/15 before:via-ink-900/10 before:to-ink-900/5 dark:before:from-ink-50/15 dark:before:via-ink-50/10 dark:before:to-ink-50/5"
          >
            {rows.map((row) =>
              row.kind === "header" ? (
                <SectionHeader
                  key={row.id}
                  label={row.label}
                  tone={row.tone}
                  pulse={row.pulse}
                />
              ) : (
                <TimelineItem
                  key={row.id}
                  todo={row.todo}
                  onSetStatus={(s) => setStatus(row.todo, s)}
                  onDelete={() => void del.mutateAsync(row.id)}
                />
              ),
            )}
          </ol>
        )}
      </div>

      <form
        className="flex items-center gap-1 border-t border-ink-900/[0.06] px-2 py-2 dark:border-ink-50/[0.06] shrink-0 bg-gradient-to-t from-paper-50/50 dark:from-ink-800/30"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="add todo…"
          className="flex-1 h-7 px-1 bg-transparent border-0 outline-none focus:ring-0 text-[12px] text-ink-900 dark:text-ink-50 placeholder:text-ink-400"
          spellCheck={false}
        />
        <button
          type="submit"
          disabled={!draft.trim() || create.isPending}
          className="grid place-items-center h-7 w-7 rounded-md bg-gradient-to-b from-ember-500 to-ember-600 text-white shadow-sm hover:from-ember-400 hover:to-ember-500 active:scale-[0.96] disabled:opacity-30 disabled:cursor-not-allowed transition-all"
          title="Add todo"
        >
          {create.isPending ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Plus className="h-3.5 w-3.5" />
          )}
        </button>
      </form>
    </section>
  );
}

function SectionHeader({
  label,
  tone = "ink",
  pulse = false,
}: {
  label: string;
  tone?: "ink" | "ember";
  pulse?: boolean;
}) {
  return (
    <li className="relative mt-3 mb-1.5 first:mt-0 list-none animate-fade-in">
      <span
        className={cn(
          "ml-8 inline-flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.16em] font-semibold",
          tone === "ember"
            ? "text-ember-700 dark:text-ember-300"
            : "text-ink-400 dark:text-ink-500",
        )}
      >
        {pulse && (
          <span className="size-1 rounded-full bg-ember-500 animate-blink" />
        )}
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

  const stampMs =
    (isDone || isCancelled
      ? todo.completedAt ?? todo.updatedAt
      : isInProgress
        ? todo.updatedAt
        : todo.createdAt) ?? todo.createdAt;

  return (
    <li
      className={cn(
        "group relative pl-8 py-1.5 list-none rounded-md",
      )}
    >
      <span
        className="absolute left-[0.85rem] top-2 z-10"
        title={statusLabel(todo.status)}
      >
        {isInProgress && (
          <span className="absolute inset-0 -m-1 rounded-full bg-ember-500/30 animate-pulse-ring" />
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
            isInProgress &&
              "rounded-md border border-ember-500/40 bg-gradient-to-r from-ember-500/[0.10] via-ember-500/[0.05] to-transparent px-2 py-1 -ml-2 -my-1 shadow-[0_0_0_1px_rgba(247,127,0,0.06)] animate-active-glow",
          )}
        >
          <div className="flex items-baseline gap-2">
            <span
              className={cn(
                "relative flex-1 min-w-0 text-[12.5px] leading-snug break-words transition-colors duration-300",
                isDone &&
                  "line-through decoration-emerald-500/70 decoration-[1.5px] text-emerald-700/90 dark:text-emerald-300/90",
                isCancelled &&
                  "line-through text-ink-400 dark:text-ink-500",
                isInProgress && "text-ink-900 dark:text-ink-50 font-medium",
                !isDone && !isCancelled && !isInProgress &&
                  "text-ink-700 dark:text-ink-200",
              )}
            >
              {todo.text}
            </span>
            <span
              title={formatTsAbsolute(stampMs)}
              className={cn(
                "font-mono text-[10px] tabular-nums shrink-0 transition-colors duration-300",
                isInProgress
                  ? "text-ember-700 dark:text-ember-300 font-semibold"
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
        "relative grid place-items-center size-4 shrink-0 rounded-full border-[1.5px] transition-all duration-200",
        isDone &&
          "border-emerald-500/80 bg-gradient-to-br from-emerald-400 to-emerald-500 text-white shadow-[0_0_0_1px_rgba(16,185,129,0.18)]",
        isInProgress &&
          "border-ember-500/80 bg-gradient-to-br from-ember-400/40 to-ember-500/30",
        isCancelled &&
          "border-ink-900/15 bg-paper-50 dark:border-ink-50/15 dark:bg-ink-900",
        !isDone && !isInProgress && !isCancelled &&
          "border-ink-900/25 bg-paper-50 hover:border-ember-500/60 hover:scale-110 dark:border-ink-50/25 dark:bg-ink-900",
      )}
    >
      {isDone && <Check className="h-2.5 w-2.5 stroke-[3] animate-check-pop" />}
      {isInProgress && (
        <span className="size-1.5 rounded-full bg-ember-500 animate-blink" />
      )}
      {isCancelled && <X className="h-2.5 w-2.5 text-ink-400" />}
    </button>
  );
}
