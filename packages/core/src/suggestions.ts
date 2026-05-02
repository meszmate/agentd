import { and, eq, desc, type SQL } from "drizzle-orm";
import type { Suggestion, SuggestionStatus } from "@agentd/contracts";
import { suggestions, type Db } from "./db.ts";
import { newId } from "./auth.ts";

export interface CreateSuggestionInput {
  templateId?: string | null;
  projectId?: string | null;
  title: string;
  prompt: string;
  options: string[];
}

function rowToSuggestion(
  row: typeof suggestions.$inferSelect,
): Suggestion {
  let options: string[] = [];
  try {
    const arr = JSON.parse(row.optionsJson);
    if (Array.isArray(arr)) {
      options = arr.filter((s): s is string => typeof s === "string");
    }
  } catch {
    // legacy / corrupt — drop it
  }
  return {
    id: row.id,
    templateId: row.templateId ?? null,
    projectId: row.projectId ?? null,
    title: row.title,
    prompt: row.prompt,
    options,
    status: (row.status as SuggestionStatus) ?? "pending",
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt ?? null,
    chosenIndex: row.chosenIndex ?? null,
    chosenText: row.chosenText ?? null,
    spawnedTaskId: row.spawnedTaskId ?? null,
  };
}

export function createSuggestion(
  db: Db,
  input: CreateSuggestionInput,
): Suggestion {
  const now = Date.now();
  const id = newId("sug");
  db.insert(suggestions)
    .values({
      id,
      templateId: input.templateId ?? null,
      projectId: input.projectId ?? null,
      title: input.title,
      prompt: input.prompt,
      optionsJson: JSON.stringify(input.options),
      status: "pending",
      createdAt: now,
      resolvedAt: null,
      chosenIndex: null,
      chosenText: null,
      spawnedTaskId: null,
    })
    .run();
  return getSuggestion(db, id)!;
}

export function getSuggestion(db: Db, id: string): Suggestion | null {
  const row = db
    .select()
    .from(suggestions)
    .where(eq(suggestions.id, id))
    .get();
  return row ? rowToSuggestion(row) : null;
}

export function listSuggestions(
  db: Db,
  opts: {
    status?: SuggestionStatus;
    projectId?: string | null;
    limit?: number;
  } = {},
): Suggestion[] {
  const filters: SQL[] = [];
  if (opts.status) filters.push(eq(suggestions.status, opts.status));
  if (opts.projectId) filters.push(eq(suggestions.projectId, opts.projectId));
  let query = db
    .select()
    .from(suggestions)
    .orderBy(desc(suggestions.createdAt));
  if (filters.length === 1) {
    query = query.where(filters[0]!) as typeof query;
  } else if (filters.length > 1) {
    query = query.where(and(...filters)!) as typeof query;
  }
  const rows = opts.limit ? query.limit(opts.limit).all() : query.all();
  return rows.map(rowToSuggestion);
}

export function resolveSuggestion(
  db: Db,
  id: string,
  chosenIndex: number | null,
  chosenText: string,
  spawnedTaskId: string | null,
): Suggestion | null {
  db.update(suggestions)
    .set({
      status: "resolved",
      resolvedAt: Date.now(),
      chosenIndex,
      chosenText,
      spawnedTaskId,
    })
    .where(eq(suggestions.id, id))
    .run();
  return getSuggestion(db, id);
}

export function dismissSuggestion(db: Db, id: string): Suggestion | null {
  db.update(suggestions)
    .set({
      status: "dismissed",
      resolvedAt: Date.now(),
    })
    .where(eq(suggestions.id, id))
    .run();
  return getSuggestion(db, id);
}
