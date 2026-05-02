import { eq, and, asc } from "drizzle-orm";
import type { Todo, TodoSource, TodoStatus } from "@agentd/contracts";
import { todos, type Db } from "./db.ts";
import { newId } from "./auth.ts";

export interface CreateTodoInput {
  projectId?: string | null;
  taskId?: string | null;
  text: string;
  status?: TodoStatus;
  source?: TodoSource;
  sortOrder?: number;
}

export interface UpdateTodoInput {
  text?: string;
  status?: TodoStatus;
  sortOrder?: number;
}

function rowToTodo(row: typeof todos.$inferSelect): Todo {
  return {
    id: row.id,
    projectId: row.projectId ?? null,
    taskId: row.taskId ?? null,
    text: row.text,
    status: (row.status as TodoStatus) ?? "pending",
    source: (row.source as TodoSource) ?? "user",
    sortOrder: row.sortOrder ?? 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt ?? null,
  };
}

/** Largest sortOrder in the given scope, defaulting to 0 if none. */
function nextSortOrder(
  db: Db,
  projectId: string | null,
  taskId: string | null,
): number {
  const rows = listTodos(db, { projectId, taskId });
  if (rows.length === 0) return 1;
  return Math.max(...rows.map((r) => r.sortOrder)) + 1;
}

export function createTodo(db: Db, input: CreateTodoInput): Todo {
  const now = Date.now();
  const id = newId("td");
  const projectId = input.projectId ?? null;
  const taskId = input.taskId ?? null;
  db.insert(todos)
    .values({
      id,
      projectId,
      taskId,
      text: input.text,
      status: input.status ?? "pending",
      source: input.source ?? "user",
      sortOrder: input.sortOrder ?? nextSortOrder(db, projectId, taskId),
      createdAt: now,
      updatedAt: now,
      completedAt:
        input.status === "done" || input.status === "cancelled" ? now : null,
    })
    .run();
  return getTodo(db, id)!;
}

export function getTodo(db: Db, id: string): Todo | null {
  const row = db.select().from(todos).where(eq(todos.id, id)).get();
  return row ? rowToTodo(row) : null;
}

export function updateTodo(
  db: Db,
  id: string,
  input: UpdateTodoInput,
): Todo | null {
  const cur = getTodo(db, id);
  if (!cur) return null;
  const now = Date.now();
  const next = {
    text: input.text ?? cur.text,
    status: (input.status ?? cur.status) as TodoStatus,
    sortOrder: input.sortOrder ?? cur.sortOrder,
    updatedAt: now,
    completedAt:
      (input.status === "done" || input.status === "cancelled") &&
      cur.status !== "done" &&
      cur.status !== "cancelled"
        ? now
        : input.status && input.status !== "done" && input.status !== "cancelled"
          ? null
          : cur.completedAt,
  };
  db.update(todos).set(next).where(eq(todos.id, id)).run();
  return getTodo(db, id);
}

export function deleteTodo(db: Db, id: string): void {
  db.delete(todos).where(eq(todos.id, id)).run();
}

/**
 * List todos in a scope. Pass either `projectId` or `taskId` (or both).
 * Returns sorted by sortOrder asc.
 *
 *   listTodos(db, { taskId })            — todos for the task only
 *   listTodos(db, { projectId })         — todos directly on the project
 *   listTodos(db, { projectId, allTasks: true })
 *                                        — all todos in the project,
 *                                          including those scoped to its
 *                                          tasks. Useful for an inbox view.
 */
export function listTodos(
  db: Db,
  opts: {
    projectId?: string | null;
    taskId?: string | null;
  },
): Todo[] {
  let conditions = undefined as ReturnType<typeof eq> | undefined;
  if (opts.taskId !== undefined) {
    conditions =
      opts.taskId === null
        ? eq(todos.taskId, "")
        : eq(todos.taskId, opts.taskId);
  }
  if (opts.projectId !== undefined) {
    const proj =
      opts.projectId === null
        ? eq(todos.projectId, "")
        : eq(todos.projectId, opts.projectId);
    conditions = conditions ? and(conditions, proj) : proj;
  }
  let q = db.select().from(todos).orderBy(asc(todos.sortOrder));
  if (conditions) q = q.where(conditions) as typeof q;
  return q.all().map(rowToTodo);
}

/**
 * Sync the agent's plan into our todos table. Called whenever a runner
 * emits a TodoWrite / update_plan tool call. Replaces all agent-source
 * todos for the given task — the agent's plan is its current view, so
 * any item it removed should disappear too. User-source todos are
 * untouched.
 *
 * `items` is the parsed plan entries — `{ text, status }` per row.
 */
export function syncAgentPlan(
  db: Db,
  taskId: string,
  projectId: string | null,
  items: Array<{ text: string; status: TodoStatus }>,
): Todo[] {
  // Wipe agent rows for this task so the new sync is the source of
  // truth. We don't touch user rows.
  db.delete(todos)
    .where(and(eq(todos.taskId, taskId), eq(todos.source, "agent")))
    .run();
  const out: Todo[] = [];
  let order = 1000; // start agent items after typical user rows
  for (const it of items) {
    const text = it.text.trim();
    if (!text) continue;
    out.push(
      createTodo(db, {
        projectId,
        taskId,
        text,
        status: it.status,
        source: "agent",
        sortOrder: order++,
      }),
    );
  }
  return out;
}
