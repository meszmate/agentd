import { eq, desc } from "drizzle-orm";
import type {
  Message,
  PermissionMode,
  Task,
  TaskStatus,
  ThinkingLevel,
  WorkspaceMode,
} from "@agentd/contracts";
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
  templateId?: string | null;
  scheduleId?: string | null;
  projectId?: string | null;
  autoPush?: boolean;
  autoPr?: boolean;
  skills?: string[];
  permissionMode?: PermissionMode;
  workspaceMode?: WorkspaceMode;
  thinkingLevel?: ThinkingLevel;
}

function rowToTask(row: typeof tasks.$inferSelect): Task {
  let parsedSkills: string[] = [];
  if (row.skillsJson) {
    try {
      const arr = JSON.parse(row.skillsJson);
      if (Array.isArray(arr)) {
        parsedSkills = arr.filter((s): s is string => typeof s === "string");
      }
    } catch {
      // ignore
    }
  }
  return {
    id: row.id,
    title: row.title,
    agent: row.agent as Task["agent"],
    repoPath: row.repoPath,
    worktreePath: row.worktreePath,
    branch: row.branch,
    baseBranch: row.baseBranch,
    status: row.status as TaskStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    templateId: row.templateId ?? null,
    scheduleId: row.scheduleId ?? null,
    projectId: row.projectId ?? null,
    autoPush: row.autoPush === 1,
    autoPr: row.autoPr === 1,
    prUrl: row.prUrl ?? null,
    totalInputTokens: row.totalInputTokens ?? 0,
    totalOutputTokens: row.totalOutputTokens ?? 0,
    totalCacheReadTokens: row.totalCacheReadTokens ?? 0,
    totalCacheWriteTokens: row.totalCacheWriteTokens ?? 0,
    totalCostUsd: row.totalCostUsd != null ? Number(row.totalCostUsd) : null,
    skills: parsedSkills,
    permissionMode:
      (row.permissionMode as PermissionMode | undefined) ?? "bypassPermissions",
    workspaceMode:
      (row.workspaceMode as WorkspaceMode | undefined) ?? "worktree",
    thinkingLevel:
      (row.thinkingLevel as ThinkingLevel | undefined) ?? "high",
    closedAt: row.closedAt ?? null,
    closedReason: row.closedReason ?? null,
  };
}

/** Mark a task as closed with an optional reason ("merged" / "abandoned" / etc.). */
export function closeTask(
  db: Db,
  id: string,
  reason?: string,
): Task | null {
  db.update(tasks)
    .set({
      closedAt: Date.now(),
      closedReason: reason ?? null,
      updatedAt: Date.now(),
    })
    .where(eq(tasks.id, id))
    .run();
  return getTask(db, id);
}

/** Undo close — back into the active list. */
export function reopenTask(db: Db, id: string): Task | null {
  db.update(tasks)
    .set({ closedAt: null, closedReason: null, updatedAt: Date.now() })
    .where(eq(tasks.id, id))
    .run();
  return getTask(db, id);
}

export function createTask(db: Db, input: CreateTaskInput): Task {
  const now = Date.now();
  const id = input.id ?? newId("task");
  db.insert(tasks)
    .values({
      id,
      title: input.title,
      agent: input.agent,
      repoPath: input.repoPath,
      worktreePath: input.worktreePath,
      branch: input.branch,
      baseBranch: input.baseBranch,
      status: "pending",
      createdAt: now,
      updatedAt: now,
      templateId: input.templateId ?? null,
      scheduleId: input.scheduleId ?? null,
      projectId: input.projectId ?? null,
      autoPush: input.autoPush ? 1 : 0,
      autoPr: input.autoPr ? 1 : 0,
      prUrl: null,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      totalCostUsd: null,
      skillsJson: JSON.stringify(input.skills ?? []),
      permissionMode: input.permissionMode ?? "bypassPermissions",
      workspaceMode: input.workspaceMode ?? "worktree",
      thinkingLevel: input.thinkingLevel ?? "high",
    })
    .run();
  return getTask(db, id)!;
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

export function setTaskPrUrl(db: Db, id: string, prUrl: string): void {
  db.update(tasks)
    .set({ prUrl, updatedAt: Date.now() })
    .where(eq(tasks.id, id))
    .run();
}

export interface UsageDelta {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}

export function addTaskUsage(db: Db, id: string, delta: UsageDelta): void {
  const cur = getTask(db, id);
  if (!cur) return;
  const inT = (cur.totalInputTokens ?? 0) + (delta.inputTokens ?? 0);
  const outT = (cur.totalOutputTokens ?? 0) + (delta.outputTokens ?? 0);
  const cacheR = (cur.totalCacheReadTokens ?? 0) + (delta.cacheReadTokens ?? 0);
  const cacheW = (cur.totalCacheWriteTokens ?? 0) + (delta.cacheWriteTokens ?? 0);
  const costPrev = cur.totalCostUsd ?? 0;
  const costNext = delta.costUsd != null ? costPrev + delta.costUsd : costPrev;
  db.update(tasks)
    .set({
      totalInputTokens: inT,
      totalOutputTokens: outT,
      totalCacheReadTokens: cacheR,
      totalCacheWriteTokens: cacheW,
      totalCostUsd: delta.costUsd != null ? String(costNext) : cur.totalCostUsd != null ? String(cur.totalCostUsd) : null,
      updatedAt: Date.now(),
    })
    .where(eq(tasks.id, id))
    .run();
}

export function getTask(db: Db, id: string): Task | null {
  const row = db.select().from(tasks).where(eq(tasks.id, id)).get();
  return row ? rowToTask(row) : null;
}

export function listTasks(db: Db): Task[] {
  return db
    .select()
    .from(tasks)
    .orderBy(desc(tasks.createdAt))
    .all()
    .map(rowToTask);
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
