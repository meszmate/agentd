import { eq, desc } from "drizzle-orm";
import type {
  Message,
  MirrorTarget,
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
  autoCommit?: boolean;
  autoPush?: boolean;
  skills?: string[];
  permissionMode?: PermissionMode;
  workspaceMode?: WorkspaceMode;
  thinkingLevel?: ThinkingLevel;
  model?: string;
  mirrorTo?: MirrorTarget | null;
  councilId?: string | null;
}

function parseMirrorTo(raw: string | null): MirrorTarget | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as Partial<MirrorTarget>;
    if (
      (obj.platform === "telegram" || obj.platform === "discord") &&
      typeof obj.chatId === "string" &&
      obj.chatId.length > 0
    ) {
      return { platform: obj.platform, chatId: obj.chatId };
    }
  } catch {
    // legacy / corrupt — drop it
  }
  return null;
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
    autoCommit: row.autoCommit !== 0,
    autoPush: row.autoPush === 1,
    prUrl: row.prUrl ?? null,
    codexThreadId: row.codexThreadId ?? null,
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
    model: row.model ?? "",
    mirrorTo: parseMirrorTo(row.mirrorTo),
    councilId: row.councilId ?? null,
    closedAt: row.closedAt ?? null,
    closedReason: row.closedReason ?? null,
    sortOrder: row.sortOrder ?? undefined,
    lastCompactedAt: row.lastCompactedAt ?? null,
    discordThreadId: row.discordThreadId ?? null,
  };
}

/** Persist the Discord thread spawned for this task. Cleared on archive. */
export function setTaskDiscordThread(
  db: Db,
  id: string,
  threadId: string | null,
): Task | null {
  db.update(tasks)
    .set({ discordThreadId: threadId, updatedAt: Date.now() })
    .where(eq(tasks.id, id))
    .run();
  return getTask(db, id);
}

/** Set or clear the `lastCompactedAt` watermark. */
export function markTaskCompacted(db: Db, id: string): Task | null {
  db.update(tasks)
    .set({ lastCompactedAt: Date.now(), updatedAt: Date.now() })
    .where(eq(tasks.id, id))
    .run();
  return getTask(db, id);
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

/**
 * Bulk-update task sort order — used by the sidebar drag-drop. The
 * caller passes an ordered array of task ids; each task receives an
 * incrementing sortOrder starting from 0. Tasks not in the array
 * keep their existing value.
 */
export function reorderTasks(db: Db, orderedIds: string[]): void {
  for (let i = 0; i < orderedIds.length; i++) {
    const id = orderedIds[i]!;
    db.update(tasks)
      .set({ sortOrder: i })
      .where(eq(tasks.id, id))
      .run();
  }
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
      autoCommit: input.autoCommit === false ? 0 : 1,
      autoPush: input.autoPush ? 1 : 0,
      autoPr: 0,
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
      model: input.model ?? "",
      mirrorTo: input.mirrorTo ? JSON.stringify(input.mirrorTo) : null,
      councilId: input.councilId ?? null,
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

/** Update the task's reasoning effort. The next runner spawn picks it up. */
export function setTaskThinkingLevel(
  db: Db,
  id: string,
  level: ThinkingLevel,
): Task | null {
  db.update(tasks)
    .set({ thinkingLevel: level, updatedAt: Date.now() })
    .where(eq(tasks.id, id))
    .run();
  return getTask(db, id);
}

/**
 * Toggle the task's auto-commit / auto-push / auto-PR flags
 * mid-flight. The post-turn hook reads these on every agent exit,
 * so flipping them changes the behavior of the NEXT completed turn.
 * Operator-driven only — there's no agent-facing knob.
 */
export function setTaskAutoFlags(
  db: Db,
  id: string,
  patch: { autoCommit?: boolean; autoPush?: boolean },
): Task | null {
  const next: Record<string, unknown> = { updatedAt: Date.now() };
  if (patch.autoCommit !== undefined)
    next.autoCommit = patch.autoCommit ? 1 : 0;
  if (patch.autoPush !== undefined) next.autoPush = patch.autoPush ? 1 : 0;
  if (Object.keys(next).length === 1) return getTask(db, id);
  db.update(tasks).set(next).where(eq(tasks.id, id)).run();
  return getTask(db, id);
}

/**
 * Update the task's per-task model override. Empty string clears it (the
 * task then inherits the configured default for its agent kind). Applied
 * on the next runner spawn — current turn keeps its model.
 */
export function setTaskModel(db: Db, id: string, model: string): Task | null {
  db.update(tasks)
    .set({ model, updatedAt: Date.now() })
    .where(eq(tasks.id, id))
    .run();
  return getTask(db, id);
}

/**
 * Set or clear the chat mirror target for a task. The plugin (Telegram /
 * Discord) starts forwarding bus events to that chat on the next event;
 * the change is applied immediately, no runner spawn required.
 */
export function setTaskMirrorTo(
  db: Db,
  id: string,
  mirrorTo: MirrorTarget | null,
): Task | null {
  db.update(tasks)
    .set({
      mirrorTo: mirrorTo ? JSON.stringify(mirrorTo) : null,
      updatedAt: Date.now(),
    })
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

/**
 * Persist the codex thread/session id captured from the runner's
 * `thread.started` stream event. Subsequent codex turns read this
 * back and call `codex exec resume <id>` instead of starting a
 * fresh conversation, keeping AGENTS.md / MCP / context loaded.
 * Idempotent — same id can be written repeatedly without harm.
 */
export function setTaskCodexThreadId(
  db: Db,
  id: string,
  threadId: string,
): void {
  db.update(tasks)
    .set({ codexThreadId: threadId, updatedAt: Date.now() })
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

/**
 * Aggregate tool-call activity across every task. Reads role='tool'
 * messages and parses their `[call <toolName>] {args}` prefix (the format
 * TaskManager writes when the runner emits a tool_call event).
 *
 * Returns counts per tool plus the latest `recentLimit` calls with task
 * title and a short args preview. Cheap enough for a few thousand
 * messages — well within agentd's expected scale.
 */
export interface ToolUsageEntry {
  id: string;
  taskId: string;
  taskTitle: string | null;
  taskAgent: string | null;
  tool: string;
  preview: string;
  ts: number;
}

export interface ToolUsageStats {
  /** Total number of tool_call messages on record. */
  total: number;
  /** Count by tool name, sorted desc in caller. */
  counts: Record<string, number>;
  /** Latest N tool calls (newest first) for the activity feed. */
  recent: ToolUsageEntry[];
  /** Earliest tool-call timestamp seen, useful for "tracked since". */
  earliest: number | null;
}

const TOOL_CALL_RE = /^\[call ([^\]]+)\](.*)$/s;

export function aggregateToolStats(
  db: Db,
  opts: { recentLimit?: number } = {},
): ToolUsageStats {
  const limit = Math.max(1, Math.min(500, opts.recentLimit ?? 50));
  const rows = db
    .select({
      id: messages.id,
      taskId: messages.taskId,
      content: messages.content,
      ts: messages.ts,
      taskTitle: tasks.title,
      taskAgent: tasks.agent,
    })
    .from(messages)
    .leftJoin(tasks, eq(tasks.id, messages.taskId))
    .where(eq(messages.role, "tool"))
    .orderBy(desc(messages.ts))
    .all();
  const counts: Record<string, number> = {};
  let total = 0;
  let earliest: number | null = null;
  const recent: ToolUsageEntry[] = [];
  for (const r of rows) {
    const m = TOOL_CALL_RE.exec(r.content ?? "");
    if (!m) continue;
    const tool = m[1]!.trim();
    counts[tool] = (counts[tool] ?? 0) + 1;
    total += 1;
    if (earliest == null || (r.ts && r.ts < earliest)) earliest = r.ts;
    if (recent.length < limit) {
      recent.push({
        id: r.id,
        taskId: r.taskId,
        taskTitle: r.taskTitle ?? null,
        taskAgent: r.taskAgent ?? null,
        tool,
        preview: (m[2] ?? "").trim().slice(0, 200),
        ts: r.ts,
      });
    }
  }
  return { total, counts, recent, earliest };
}

export function listMessages(db: Db, taskId: string, limit?: number): Message[] {
  // Return all messages for this task in chronological order. The
  // implicit limit is the agent's own context window (~200k tokens)
  // since rows produced past that get compacted away. Callers that
  // genuinely want a tail can pass an explicit limit.
  if (limit == null) {
    return db
      .select()
      .from(messages)
      .where(eq(messages.taskId, taskId))
      .orderBy(messages.ts)
      .all() as Message[];
  }
  // Bounded tail: pull the latest N then reverse for chronological
  // display. Used by spots that don't need the full history.
  const rows = db
    .select()
    .from(messages)
    .where(eq(messages.taskId, taskId))
    .orderBy(desc(messages.ts))
    .limit(limit)
    .all() as Message[];
  return rows.slice().reverse();
}
