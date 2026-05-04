import { eq, sql } from "drizzle-orm";
import type { BrainstormAuto, Project } from "@agentd/contracts";
import { newId } from "./auth.ts";
import { projects, tasks, type Db } from "./db.ts";

function parseBrainstormAuto(
  raw: string | null | undefined,
): BrainstormAuto | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as BrainstormAuto;
  } catch {
    return null;
  }
}

function basenameOf(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed || "project";
}

function slugifyProjectName(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9-_]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/-{2,}/g, "-")
      .slice(0, 60) || "project"
  );
}

function rowToProject(row: typeof projects.$inferSelect): Project {
  const brainstormAuto = parseBrainstormAuto(row.brainstormAutoJson);
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    path: row.path,
    color: row.color ?? null,
    createdAt: row.createdAt,
    lastActiveAt: row.lastActiveAt,
    instructions: row.instructions ?? null,
    instructionsEnabled: row.instructionsEnabled !== 0,
    notifySuggestions: row.notifySuggestions === 1,
    telegramBotToken: row.telegramBotToken ?? null,
    telegramChatId: row.telegramChatId ?? null,
    discordChannelId: row.discordChannelId ?? null,
    autoTaskThread: !!row.autoTaskThread,
    brainstormAuto,
    githubRepo: row.githubRepo ?? null,
  };
}

export function getProjectByPath(db: Db, path: string): Project | null {
  const row = db.select().from(projects).where(eq(projects.path, path)).get();
  return row ? rowToProject(row) : null;
}

export function getProjectById(db: Db, id: string): Project | null {
  const row = db.select().from(projects).where(eq(projects.id, id)).get();
  return row ? rowToProject(row) : null;
}

export function getProjectBySlug(db: Db, slug: string): Project | null {
  const row = db.select().from(projects).where(eq(projects.slug, slug)).get();
  return row ? rowToProject(row) : null;
}

export interface CreateProjectInput {
  name?: string;
  path: string;
  color?: string;
}

function uniqueSlug(db: Db, base: string): string {
  let candidate = base;
  for (let i = 2; i < 1000; i++) {
    if (!getProjectBySlug(db, candidate)) return candidate;
    candidate = `${base}-${i}`;
  }
  return `${base}-${Date.now()}`;
}

export function createProject(db: Db, input: CreateProjectInput): Project {
  const now = Date.now();
  const id = newId("project");
  const baseName = input.name?.trim() || basenameOf(input.path);
  const slug = uniqueSlug(db, slugifyProjectName(baseName));
  db.insert(projects)
    .values({
      id,
      slug,
      name: baseName,
      path: input.path,
      color: input.color ?? null,
      createdAt: now,
      lastActiveAt: now,
    })
    .run();
  return getProjectById(db, id)!;
}

export function ensureProjectForPath(db: Db, path: string): Project {
  const existing = getProjectByPath(db, path);
  if (existing) {
    touchProject(db, existing.id);
    return existing;
  }
  return createProject(db, { path });
}

export function touchProject(db: Db, id: string): void {
  db.update(projects)
    .set({ lastActiveAt: Date.now() })
    .where(eq(projects.id, id))
    .run();
}

export interface UpdateProjectInput {
  name?: string;
  color?: string;
  instructions?: string | null;
  instructionsEnabled?: boolean;
  notifySuggestions?: boolean;
  telegramBotToken?: string | null;
  telegramChatId?: string | null;
  discordChannelId?: string | null;
  autoTaskThread?: boolean;
  brainstormAuto?: BrainstormAuto | null;
  githubRepo?: string | null;
}

export function updateProject(
  db: Db,
  id: string,
  patch: UpdateProjectInput,
): Project | null {
  const cur = getProjectById(db, id);
  if (!cur) return null;
  const next: Record<string, unknown> = {};
  if (patch.name != null) next.name = patch.name;
  if (patch.color != null) next.color = patch.color;
  if (patch.instructions !== undefined) next.instructions = patch.instructions;
  if (patch.instructionsEnabled !== undefined)
    next.instructionsEnabled = patch.instructionsEnabled ? 1 : 0;
  if (patch.notifySuggestions !== undefined)
    next.notifySuggestions = patch.notifySuggestions ? 1 : 0;
  if (patch.telegramBotToken !== undefined)
    next.telegramBotToken = patch.telegramBotToken;
  if (patch.telegramChatId !== undefined)
    next.telegramChatId = patch.telegramChatId;
  if (patch.discordChannelId !== undefined)
    next.discordChannelId = patch.discordChannelId;
  if (patch.autoTaskThread !== undefined)
    next.autoTaskThread = patch.autoTaskThread ? 1 : 0;
  if (patch.brainstormAuto !== undefined)
    next.brainstormAutoJson = patch.brainstormAuto
      ? JSON.stringify(patch.brainstormAuto)
      : null;
  if (patch.githubRepo !== undefined) next.githubRepo = patch.githubRepo;
  // Drizzle's .set() throws "No values to set" on an empty object —
  // skip the UPDATE entirely when the patch had nothing meaningful.
  if (Object.keys(next).length === 0) return cur;
  db.update(projects).set(next).where(eq(projects.id, id)).run();
  return getProjectById(db, id);
}

export function deleteProject(db: Db, id: string): void {
  db.delete(projects).where(eq(projects.id, id)).run();
}

export interface ProjectListEntry extends Project {
  taskCount: number;
  activeCount: number;
}

const ACTIVE_STATUSES = new Set([
  "running",
  "waiting_input",
  "waiting_perm",
  "pending",
]);

export function listProjects(db: Db): ProjectListEntry[] {
  // Fetch projects + per-project counts in two cheap passes.
  const rows = db.select().from(projects).all();
  const counts = db
    .select({
      projectId: tasks.projectId,
      status: tasks.status,
      n: sql<number>`count(*)`,
    })
    .from(tasks)
    .groupBy(tasks.projectId, tasks.status)
    .all();
  const totals = new Map<string, { total: number; active: number }>();
  for (const c of counts) {
    if (!c.projectId) continue;
    const prev = totals.get(c.projectId) ?? { total: 0, active: 0 };
    prev.total += c.n;
    if (ACTIVE_STATUSES.has(c.status)) prev.active += c.n;
    totals.set(c.projectId, prev);
  }
  return rows
    .map((r) => {
      const t = totals.get(r.id) ?? { total: 0, active: 0 };
      return {
        ...rowToProject(r),
        taskCount: t.total,
        activeCount: t.active,
      };
    })
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
}

/**
 * One-shot migration: any task with no projectId gets an auto-created
 * project keyed off its repoPath. Idempotent (skipped on subsequent boots).
 */
export function backfillProjectsFromTasks(db: Db): number {
  const orphan = db
    .select({ id: tasks.id, repoPath: tasks.repoPath })
    .from(tasks)
    .where(sql`${tasks.projectId} IS NULL`)
    .all();
  let updated = 0;
  for (const t of orphan) {
    const project = ensureProjectForPath(db, t.repoPath);
    db.update(tasks)
      .set({ projectId: project.id })
      .where(eq(tasks.id, t.id))
      .run();
    updated += 1;
  }
  return updated;
}
