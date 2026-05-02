import { eq, desc, and, sql } from "drizzle-orm";
import type { Idea, IdeaStatus } from "@agentd/contracts";
import { ideaMessages, savedIdeas, type Db } from "./db.ts";
import { newId } from "./auth.ts";

function rowToIdea(row: typeof savedIdeas.$inferSelect): Idea {
  const tags = row.tagsCsv
    ? row.tagsCsv
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  return {
    id: row.id,
    projectId: row.projectId,
    suggestionId: row.suggestionId ?? null,
    optionIndex: row.optionIndex ?? null,
    text: row.text,
    description: row.description ?? null,
    status: ((row.status as IdeaStatus) ?? "draft"),
    tags,
    planDraft: row.planDraft ?? null,
    savedAt: row.savedAt,
    updatedAt: row.updatedAt || row.savedAt,
    spawnedTaskId: row.spawnedTaskId ?? null,
    spawnedAt: row.spawnedAt ?? null,
  };
}

function tagsToCsv(tags?: string[] | null): string | null {
  if (!tags || tags.length === 0) return null;
  return tags
    .map((t) => t.trim())
    .filter(Boolean)
    .join(",");
}

export interface CreateIdeaInput {
  projectId: string;
  text: string;
  description?: string | null;
  status?: IdeaStatus;
  tags?: string[];
  suggestionId?: string | null;
  optionIndex?: number | null;
  planDraft?: string | null;
}

export function createSavedIdea(db: Db, input: CreateIdeaInput): Idea {
  // Don't double-save when the same brainstorm option gets starred twice.
  if (input.suggestionId != null && input.optionIndex != null) {
    const existing = db
      .select()
      .from(savedIdeas)
      .where(
        and(
          eq(savedIdeas.projectId, input.projectId),
          eq(savedIdeas.suggestionId, input.suggestionId),
          eq(savedIdeas.optionIndex, input.optionIndex),
        )!,
      )
      .get();
    if (existing) return rowToIdea(existing);
  }

  const id = newId("idea");
  const now = Date.now();
  db.insert(savedIdeas)
    .values({
      id,
      projectId: input.projectId,
      suggestionId: input.suggestionId ?? null,
      optionIndex: input.optionIndex ?? null,
      text: input.text,
      description: input.description ?? null,
      status: input.status ?? "draft",
      tagsCsv: tagsToCsv(input.tags),
      planDraft: input.planDraft ?? null,
      savedAt: now,
      updatedAt: now,
      spawnedTaskId: null,
      spawnedAt: null,
    })
    .run();
  return getSavedIdea(db, id)!;
}

export function getSavedIdea(db: Db, id: string): Idea | null {
  const row = db.select().from(savedIdeas).where(eq(savedIdeas.id, id)).get();
  return row ? rowToIdea(row) : null;
}

export function listSavedIdeas(
  db: Db,
  opts: {
    projectId?: string;
    includeSpawned?: boolean;
    statuses?: IdeaStatus[];
  } = {},
): Idea[] {
  const filters = [];
  if (opts.projectId) filters.push(eq(savedIdeas.projectId, opts.projectId));
  let q = db.select().from(savedIdeas).orderBy(desc(savedIdeas.updatedAt));
  if (filters.length === 1) q = q.where(filters[0]!) as typeof q;
  else if (filters.length > 1) q = q.where(and(...filters)!) as typeof q;
  let all = q.all().map(rowToIdea);
  if (opts.statuses && opts.statuses.length > 0) {
    const set = new Set(opts.statuses);
    all = all.filter((i) => set.has(i.status));
  }
  if (opts.includeSpawned === false) {
    all = all.filter((i) => !i.spawnedTaskId);
  }
  return decorateWithMessageStats(db, all);
}

/**
 * Adds `messageCount` and `lastMessageAt` to each idea in one
 * batched aggregate query so list views don't N+1.
 */
function decorateWithMessageStats(db: Db, ideas: Idea[]): Idea[] {
  if (ideas.length === 0) return ideas;
  const stats = db
    .select({
      ideaId: ideaMessages.ideaId,
      count: sql<number>`COUNT(*)`,
      last: sql<number>`MAX(${ideaMessages.createdAt})`,
    })
    .from(ideaMessages)
    .groupBy(ideaMessages.ideaId)
    .all() as Array<{ ideaId: string; count: number; last: number }>;
  const map = new Map(stats.map((s) => [s.ideaId, s]));
  return ideas.map((i) => {
    const s = map.get(i.id);
    return s
      ? { ...i, messageCount: s.count, lastMessageAt: s.last }
      : { ...i, messageCount: 0, lastMessageAt: null };
  });
}

export function deleteSavedIdea(db: Db, id: string): void {
  db.delete(ideaMessages).where(eq(ideaMessages.ideaId, id)).run();
  db.delete(savedIdeas).where(eq(savedIdeas.id, id)).run();
}

export interface UpdateIdeaInput {
  text?: string;
  description?: string | null;
  status?: IdeaStatus;
  tags?: string[];
  planDraft?: string | null;
}

export function updateSavedIdea(
  db: Db,
  id: string,
  patch: UpdateIdeaInput,
): Idea | null {
  const next: Record<string, unknown> = { updatedAt: Date.now() };
  if (patch.text != null) next.text = patch.text;
  if (patch.description !== undefined) next.description = patch.description;
  if (patch.status != null) next.status = patch.status;
  if (patch.tags !== undefined) next.tagsCsv = tagsToCsv(patch.tags);
  if (patch.planDraft !== undefined) next.planDraft = patch.planDraft;
  db.update(savedIdeas).set(next).where(eq(savedIdeas.id, id)).run();
  return getSavedIdea(db, id);
}

export function updateSavedIdeaPlan(
  db: Db,
  id: string,
  planDraft: string | null,
): Idea | null {
  return updateSavedIdea(db, id, { planDraft });
}

export function markSavedIdeaSpawned(
  db: Db,
  id: string,
  taskId: string,
): Idea | null {
  db.update(savedIdeas)
    .set({
      status: "spawned",
      spawnedTaskId: taskId,
      spawnedAt: Date.now(),
      updatedAt: Date.now(),
    })
    .where(eq(savedIdeas.id, id))
    .run();
  return getSavedIdea(db, id);
}

/* ── idea messages (the refinement conversation) ─────────────── */

export interface IdeaMessageRow {
  id: string;
  ideaId: string;
  role: "user" | "agent" | "system";
  content: string;
  createdAt: number;
}

export function listIdeaMessages(db: Db, ideaId: string): IdeaMessageRow[] {
  return db
    .select()
    .from(ideaMessages)
    .where(eq(ideaMessages.ideaId, ideaId))
    .orderBy(ideaMessages.createdAt)
    .all() as IdeaMessageRow[];
}

export function appendIdeaMessage(
  db: Db,
  input: { ideaId: string; role: "user" | "agent" | "system"; content: string },
): IdeaMessageRow {
  const id = newId("imsg");
  const now = Date.now();
  db.insert(ideaMessages)
    .values({
      id,
      ideaId: input.ideaId,
      role: input.role,
      content: input.content,
      createdAt: now,
    })
    .run();
  // Bump the parent's updatedAt so list ordering reflects fresh chatter.
  db.update(savedIdeas)
    .set({ updatedAt: now })
    .where(eq(savedIdeas.id, input.ideaId))
    .run();
  return { id, ideaId: input.ideaId, role: input.role, content: input.content, createdAt: now };
}
