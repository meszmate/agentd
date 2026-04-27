import { eq, desc } from "drizzle-orm";
import type { Task, TaskStatus, Message } from "@agentd/contracts";
import type { Db } from "./db.ts";
import { tasks, messages } from "./db.ts";
import { newId } from "./auth.ts";

export interface CreateTaskInput {
  id?: string;
  title: string;
  agent: Task["agent"];
  repoPath: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
}

export function createTask(db: Db, input: CreateTaskInput): Task {
  const now = Date.now();
  const task: Task = {
    id: input.id ?? newId("task"),
    title: input.title,
    agent: input.agent,
    repoPath: input.repoPath,
    worktreePath: input.worktreePath,
    branch: input.branch,
    baseBranch: input.baseBranch,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };
  db.insert(tasks).values(task).run();
  return task;
}

export function updateTaskStatus(
  db: Db,
  id: string,
  status: TaskStatus,
): Task | null {
  const now = Date.now();
  db.update(tasks)
    .set({ status, updatedAt: now })
    .where(eq(tasks.id, id))
    .run();
  return getTask(db, id);
}

export function getTask(db: Db, id: string): Task | null {
  const row = db.select().from(tasks).where(eq(tasks.id, id)).get();
  return (row as Task | undefined) ?? null;
}

export function listTasks(db: Db): Task[] {
  return db
    .select()
    .from(tasks)
    .orderBy(desc(tasks.createdAt))
    .all() as Task[];
}

export function deleteTask(db: Db, id: string): void {
  db.delete(messages).where(eq(messages.taskId, id)).run();
  db.delete(tasks).where(eq(tasks.id, id)).run();
}

export function appendMessage(
  db: Db,
  taskId: string,
  role: Message["role"],
  content: string,
): Message {
  const m: Message = {
    id: newId("msg"),
    taskId,
    role,
    content,
    ts: Date.now(),
  };
  db.insert(messages).values(m).run();
  return m;
}

export function listMessages(db: Db, taskId: string, limit = 200): Message[] {
  return db
    .select()
    .from(messages)
    .where(eq(messages.taskId, taskId))
    .orderBy(messages.ts)
    .limit(limit)
    .all() as Message[];
}
