import { useState } from "react";
import { Check, Loader2, Plus, Trash2, X } from "lucide-react";
import type { Todo } from "@agentd/contracts";
import {
  useCreateTodo,
  useDeleteTodo,
  useTodos,
  useUpdateTodo,
} from "@/queries";
import { cn } from "@/lib/utils";

/**
 * Reusable todos panel. Either project-scoped (`{ projectId }`) or
 * task-scoped (`{ taskId }`). The same component lives on both views;
 * agent-source rows render with a small bot glyph so the operator can
 * tell what they wrote vs what the agent's plan tool produced.
 */
export function TodosPanel({
  projectId,
  taskId,
  title = "Todos",
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

  const toggle = (todo: Todo) => {
    const next = todo.status === "done" ? "pending" : "done";
    void update.mutateAsync({ id: todo.id, patch: { status: next } });
  };
  const cancel = (todo: Todo) => {
    void update.mutateAsync({ id: todo.id, patch: { status: "cancelled" } });
  };

  return (
    <section className="rounded-md border border-ink-900/[0.08] bg-paper-50 dark:border-ink-50/[0.08] dark:bg-ink-800/40 overflow-hidden">
      <div className="flex items-baseline justify-between border-b border-ink-900/[0.06] px-3 py-2 dark:border-ink-50/[0.06]">
        <h3 className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-500 dark:text-ink-400">
          {title}
        </h3>
        <span className="font-mono text-[10px] tabular-nums text-ink-400 dark:text-ink-500">
          {items.filter((t) => t.status === "pending" || t.status === "in_progress").length}{" "}
          open
        </span>
      </div>

      {items.length === 0 ? (
        <div className="px-3 py-4 text-[11px] text-ink-500 dark:text-ink-400 italic">
          {emptyHint ?? "no todos yet — type below to add one"}
        </div>
      ) : (
        <ul className="divide-y divide-ink-900/[0.04] dark:divide-ink-50/[0.04]">
          {items.map((t) => (
            <TodoRow
              key={t.id}
              todo={t}
              onToggle={() => toggle(t)}
              onCancel={() => cancel(t)}
              onDelete={() => void del.mutateAsync(t.id)}
            />
          ))}
        </ul>
      )}

      <form
        className="flex items-center gap-1 border-t border-ink-900/[0.06] px-2 py-2 dark:border-ink-50/[0.06]"
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

function TodoRow({
  todo,
  onToggle,
  onCancel,
  onDelete,
}: {
  todo: Todo;
  onToggle: () => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const isDone = todo.status === "done";
  const isCancelled = todo.status === "cancelled";
  const isInProgress = todo.status === "in_progress";
  return (
    <li
      className={cn(
        "group flex items-start gap-2 px-3 py-1.5 hover:bg-paper-100/40 dark:hover:bg-ink-700/30",
        (isDone || isCancelled) && "opacity-60",
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        title={isDone ? "Reopen" : "Mark done"}
        className={cn(
          "mt-0.5 grid place-items-center size-4 shrink-0 rounded border transition-colors",
          isDone
            ? "border-emerald-500/50 bg-emerald-500/20 text-emerald-700 dark:text-emerald-300"
            : isInProgress
              ? "border-ember-500/50 bg-ember-500/15"
              : "border-ink-900/20 dark:border-ink-50/20",
        )}
      >
        {isDone && <Check className="h-3 w-3" />}
        {isInProgress && (
          <span className="size-1.5 rounded-full bg-ember-500 animate-blink" />
        )}
      </button>
      <span
        className={cn(
          "flex-1 min-w-0 text-[12px] leading-snug break-words",
          isDone && "line-through text-ink-500 dark:text-ink-400",
          isCancelled && "line-through text-ink-400 dark:text-ink-500",
        )}
      >
        {todo.text}
      </span>
      {todo.source === "agent" && (
        <span
          title="Written by the agent"
          className="font-mono text-[9px] uppercase tracking-[0.08em] text-violet-700 dark:text-violet-300 shrink-0"
        >
          agent
        </span>
      )}
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
        {!isCancelled && (
          <button
            type="button"
            onClick={onCancel}
            title="Cancel"
            className="rounded p-0.5 text-ink-400 hover:bg-ink-900/[0.05] hover:text-amber-700 dark:hover:bg-ink-50/[0.06] dark:hover:text-amber-300"
          >
            <X className="h-3 w-3" />
          </button>
        )}
        <button
          type="button"
          onClick={onDelete}
          title="Delete"
          className="rounded p-0.5 text-ink-400 hover:bg-ink-900/[0.05] hover:text-red-700 dark:hover:bg-ink-50/[0.06] dark:hover:text-red-300"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
    </li>
  );
}
