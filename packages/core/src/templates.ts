import { eq, desc } from "drizzle-orm";
import type { Template } from "@agentd/contracts";
import { templates, type Db } from "./db.ts";
import { newId } from "./auth.ts";

export interface CreateTemplateInput {
  name: string;
  agent: Template["agent"];
  repoPath: string;
  baseBranch: string;
  promptTemplate: string;
  autoPush: boolean;
  autoPr: boolean;
}

function rowToTemplate(row: typeof templates.$inferSelect): Template {
  return {
    id: row.id,
    name: row.name,
    agent: row.agent as Template["agent"],
    repoPath: row.repoPath,
    baseBranch: row.baseBranch,
    promptTemplate: row.promptTemplate,
    autoPush: row.autoPush === 1,
    autoPr: row.autoPr === 1,
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
      repoPath: input.repoPath,
      baseBranch: input.baseBranch,
      promptTemplate: input.promptTemplate,
      autoPush: input.autoPush ? 1 : 0,
      autoPr: input.autoPr ? 1 : 0,
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
