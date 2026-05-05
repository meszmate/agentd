import { and, desc, eq, lt } from "drizzle-orm";
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
  autoPr?: boolean;
  skills?: string[];
  permissionMode?: PermissionMode;
  workspaceMode?: WorkspaceMode;
  thinkingLevel?: ThinkingLevel;
  model?: string;
  mirrorTo?: MirrorTarget | null;
  councilId?: string | null;
  /**
   * When set, the task is created in `pending` status and won't
   * spawn until the named parent reaches `done`. Powers plan-slice
   * chains.
   */
  dependsOnTaskId?: string | null;
  /** Group key shared by every sibling slice in one plan. */
  planGroupId?: string | null;
  /** Issue / PR number this task was spawned from, when applicable. */
  githubIssue?: number | null;
  githubPr?: number | null;
  /** Live PR state captured at spawn from `gh pr view`. */
  githubPrState?: string | null;
  githubPrIsDraft?: boolean | null;
  /** Live issue state captured at spawn from `gh issue view`. */
  githubIssueState?: string | null;
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
    latestTurnInputTokens: row.latestTurnInputTokens ?? null,
    latestTurnOutputTokens: row.latestTurnOutputTokens ?? null,
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
    dependsOnTaskId: row.dependsOnTaskId ?? null,
    planGroupId: row.planGroupId ?? null,
    githubIssue: row.githubIssue ?? null,
    githubPr: row.githubPr ?? null,
    githubPrState: row.githubPrState ?? null,
    githubPrIsDraft:
      row.githubPrIsDraft == null ? undefined : row.githubPrIsDraft === 1,
    githubIssueState: row.githubIssueState ?? null,
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

/**
 * Set the `lastCompactedAt` watermark and zero out the latest-turn
 * token gauge. The next agent turn will repopulate it with the
 * post-compact summary's footprint, but in the meantime the timeline's
 * compact-banner needs to clear immediately — otherwise the operator
 * keeps seeing "context nearly full" right after they pressed compact.
 */
export function markTaskCompacted(db: Db, id: string): Task | null {
  db.update(tasks)
    .set({
      lastCompactedAt: Date.now(),
      latestTurnInputTokens: 0,
      latestTurnOutputTokens: 0,
      updatedAt: Date.now(),
    })
    .where(eq(tasks.id, id))
    .run();
  return getTask(db, id);
}

export function pruneTaskMessagesBefore(
  db: Db,
  taskId: string,
  ts: number,
): void {
  db.delete(messages)
    .where(and(eq(messages.taskId, taskId), lt(messages.ts, ts)))
    .run();
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
      model: input.model ?? "",
      mirrorTo: input.mirrorTo ? JSON.stringify(input.mirrorTo) : null,
      councilId: input.councilId ?? null,
      dependsOnTaskId: input.dependsOnTaskId ?? null,
      planGroupId: input.planGroupId ?? null,
      githubIssue: input.githubIssue ?? null,
      githubPr: input.githubPr ?? null,
      githubPrState: input.githubPrState ?? null,
      githubPrIsDraft:
        input.githubPrIsDraft == null ? null : input.githubPrIsDraft ? 1 : 0,
      githubIssueState: input.githubIssueState ?? null,
    })
    .run();
  return getTask(db, id)!;
}

/**
 * Patch the live GitHub lifecycle state for a task — written after a PR
 * action, after a github tab refresh, or whenever else the daemon
 * re-pulls `gh pr view` / `gh issue view`. Skips updatedAt because the
 * sidebar uses updatedAt for sort ordering and we don't want a passive
 * background refresh to jostle the list.
 */
export function setTaskGithubMeta(
  db: Db,
  id: string,
  patch: {
    githubPrState?: string | null;
    githubPrIsDraft?: boolean | null;
    githubIssueState?: string | null;
  },
): Task | null {
  const next: Record<string, unknown> = {};
  if (patch.githubPrState !== undefined)
    next.githubPrState = patch.githubPrState;
  if (patch.githubPrIsDraft !== undefined)
    next.githubPrIsDraft =
      patch.githubPrIsDraft == null ? null : patch.githubPrIsDraft ? 1 : 0;
  if (patch.githubIssueState !== undefined)
    next.githubIssueState = patch.githubIssueState;
  if (Object.keys(next).length === 0) return getTask(db, id);
  db.update(tasks).set(next).where(eq(tasks.id, id)).run();
  return getTask(db, id);
}

/**
 * Tasks waiting on `parentTaskId` to finish before they spawn. The
 * lifecycle hook in TaskManager fans this out on each `done` event
 * so the next slice picks up the parent's commits on the shared
 * branch.
 */
export function getTasksDependingOn(db: Db, parentTaskId: string): Task[] {
  return db
    .select()
    .from(tasks)
    .where(eq(tasks.dependsOnTaskId, parentTaskId))
    .all()
    .map(rowToTask);
}

/**
 * Sibling tasks that share the given `planGroupId`, ordered by creation
 * so the UI can render "slice 2 of N" chips deterministically.
 */
export function listTasksByPlanGroup(db: Db, planGroupId: string): Task[] {
  return db
    .select()
    .from(tasks)
    .where(eq(tasks.planGroupId, planGroupId))
    .orderBy(tasks.createdAt)
    .all()
    .map(rowToTask);
}

/**
 * Promote a solo task into a plan group (or move it between groups).
 * Used by `addSiblingTask` so the new sibling can join an existing
 * group rather than orphaning the parent.
 */
export function setTaskPlanGroupId(
  db: Db,
  id: string,
  planGroupId: string | null,
): Task | null {
  db.update(tasks)
    .set({ planGroupId, updatedAt: Date.now() })
    .where(eq(tasks.id, id))
    .run();
  return getTask(db, id);
}

/**
 * Set status without bumping updatedAt (used by the chain hook
 * when a parent fails — children should record the cancel reason
 * but not jostle list ordering).
 */
export function setTaskStatusOnly(
  db: Db,
  id: string,
  status: TaskStatus,
): Task | null {
  db.update(tasks).set({ status }).where(eq(tasks.id, id)).run();
  return getTask(db, id);
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
  threadId: string | null,
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
  // Latest-turn fields REPLACE rather than sum — each runner usage event
  // already reports the full input/output for that turn (the API charges
  // for the entire conversation context as input on each call), so we
  // want this to reflect the most recent turn's footprint, not a
  // running total. Read by the timeline's compact-banner so it tracks
  // the actual context size and decays after /compact.
  const patch: Record<string, unknown> = {
    totalInputTokens: inT,
    totalOutputTokens: outT,
    totalCacheReadTokens: cacheR,
    totalCacheWriteTokens: cacheW,
    totalCostUsd:
      delta.costUsd != null
        ? String(costNext)
        : cur.totalCostUsd != null
          ? String(cur.totalCostUsd)
          : null,
    updatedAt: Date.now(),
  };
  // For "live context size" we want the TOTAL the model loaded this
  // turn, including cache reads. Claude bills `input_tokens` as
  // *uncached* only and reports the cached portion separately as
  // `cache_read_input_tokens`. Without summing them, an early-turn
  // task shows "live context = 44" because the only uncached chunk
  // is the new user prompt — the rest came from the prompt cache.
  // Codex reports the same shape (`cached_input_tokens`).
  if (
    delta.inputTokens != null ||
    delta.cacheReadTokens != null ||
    delta.cacheWriteTokens != null
  ) {
    patch.latestTurnInputTokens =
      (delta.inputTokens ?? 0) +
      (delta.cacheReadTokens ?? 0) +
      (delta.cacheWriteTokens ?? 0);
  }
  if (delta.outputTokens != null) {
    patch.latestTurnOutputTokens = delta.outputTokens;
  }
  db.update(tasks).set(patch).where(eq(tasks.id, id)).run();
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
