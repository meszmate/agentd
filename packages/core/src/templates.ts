import { eq, desc } from "drizzle-orm";
import type {
  BranchMode,
  PermissionMode,
  Template,
  TemplateKind,
  ThinkingLevel,
  WorkspaceMode,
} from "@agentd/contracts";
import { templates, type Db } from "./db.ts";
import { newId } from "./auth.ts";

export interface CreateTemplateInput {
  name: string;
  agent: Template["agent"];
  kind?: TemplateKind;
  projectId?: string | null;
  repoPath: string;
  /**
   * Optional. Empty string means "auto-detect at run time" — useful so
   * a template doesn't bake in `main` for a repo whose default is
   * `master`/`trunk`/etc.
   */
  baseBranch?: string;
  promptTemplate: string;
  autoPush: boolean;
  permissionMode?: PermissionMode;
  thinkingLevel?: ThinkingLevel;
  model?: string;
  workspaceMode?: WorkspaceMode;
  branchMode?: BranchMode;
  pullLatest?: boolean;
  skills?: string[];
}

function parseSkills(raw: string): string[] {
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      return arr.filter((s): s is string => typeof s === "string");
    }
  } catch {
    // legacy / corrupt — drop it
  }
  return [];
}

function rowToTemplate(row: typeof templates.$inferSelect): Template {
  return {
    id: row.id,
    name: row.name,
    agent: row.agent as Template["agent"],
    kind: (row.kind as TemplateKind) ?? "task",
    projectId: row.projectId ?? null,
    repoPath: row.repoPath,
    baseBranch: row.baseBranch,
    promptTemplate: row.promptTemplate,
    autoPush: row.autoPush === 1,
    permissionMode: (row.permissionMode as PermissionMode) ?? "bypassPermissions",
    thinkingLevel: (row.thinkingLevel as ThinkingLevel) ?? "high",
    model: row.model ?? "",
    workspaceMode: (row.workspaceMode as WorkspaceMode) ?? "worktree",
    branchMode: (row.branchMode as BranchMode) ?? "new",
    pullLatest: row.pullLatest === 1,
    skills: parseSkills(row.skillsJson ?? "[]"),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createTemplate(db: Db, input: CreateTemplateInput): Template {
  const now = Date.now();
  const id = newId("tpl");
  db.insert(templates)
    .values({
      id,
      name: input.name,
      agent: input.agent,
      kind: input.kind ?? "task",
      projectId: input.projectId ?? null,
      repoPath: input.repoPath,
      baseBranch: input.baseBranch ?? "",
      promptTemplate: input.promptTemplate,
      autoPush: input.autoPush ? 1 : 0,
      permissionMode: input.permissionMode ?? "bypassPermissions",
      thinkingLevel: input.thinkingLevel ?? "high",
      model: input.model ?? "",
      workspaceMode: input.workspaceMode ?? "worktree",
      branchMode: input.branchMode ?? "new",
      pullLatest: input.pullLatest ? 1 : 0,
      skillsJson: JSON.stringify(input.skills ?? []),
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return getTemplate(db, id)!;
}

export function getTemplate(db: Db, id: string): Template | null {
  const row = db.select().from(templates).where(eq(templates.id, id)).get();
  return row ? rowToTemplate(row) : null;
}

export function getTemplateByName(db: Db, name: string): Template | null {
  const row = db.select().from(templates).where(eq(templates.name, name)).get();
  return row ? rowToTemplate(row) : null;
}

export function listTemplates(db: Db): Template[] {
  return db
    .select()
    .from(templates)
    .orderBy(desc(templates.createdAt))
    .all()
    .map(rowToTemplate);
}

export function deleteTemplate(db: Db, id: string): void {
  db.delete(templates).where(eq(templates.id, id)).run();
}

/**
 * Render `Hello {name}, please {action}` style templates against a flat
 * arg map. Unknown placeholders are left as `{name}` so the agent sees
 * something obviously wrong rather than getting a silently-empty prompt.
 */
export function renderTemplate(
  template: string,
  args: Record<string, string>,
): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key: string) => {
    return key in args ? args[key]! : `{${key}}`;
  });
}
