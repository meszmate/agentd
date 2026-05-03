import { and, eq, desc, type SQL } from "drizzle-orm";
import type {
  IdeaMessageEvent,
  Suggestion,
  SuggestionStatus,
  SuggestionValidation,
} from "@agentd/contracts";
import { suggestions, type Db } from "./db.ts";
import { newId } from "./auth.ts";

export interface CreateSuggestionInput {
  templateId?: string | null;
  projectId?: string | null;
  title: string;
  prompt: string;
  options: string[];
  /**
   * Tool-call activity captured during the brainstorm draft. Persisted
   * so the brainstorm thread can replay "what the agent did" after
   * reload, not just during the live stream. Filtered server-side to
   * only the persistable kinds (tool_use + tool_result).
   */
  events?: IdeaMessageEvent[];
}

function parseEvents(
  raw: string | null | undefined,
): IdeaMessageEvent[] | undefined {
  if (!raw) return undefined;
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return undefined;
    return arr as IdeaMessageEvent[];
  } catch {
    return undefined;
  }
}

function parseValidations(
  raw: string | null | undefined,
): SuggestionValidation[] | undefined {
  if (!raw) return undefined;
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return undefined;
    return arr as SuggestionValidation[];
  } catch {
    return undefined;
  }
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
  const events = parseEvents(row.eventsJson);
  const validations = parseValidations(row.validationsJson);
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
    ...(events && events.length > 0 ? { events } : {}),
    ...(validations && validations.length > 0 ? { validations } : {}),
  };
}

/**
 * Append (or replace) a validation entry on a suggestion. If a
 * validation already exists for the same agent + model pair we
 * overwrite it — re-running with the same rater always reflects the
 * latest scoring rather than stacking duplicates.
 */
export function addSuggestionValidation(
  db: Db,
  id: string,
  validation: SuggestionValidation,
): Suggestion | null {
  const sug = getSuggestion(db, id);
  if (!sug) return null;
  const existing = sug.validations ?? [];
  const filtered = existing.filter(
    (v) => !(v.agent === validation.agent && v.model === validation.model),
  );
  const next = [...filtered, validation];
  db.update(suggestions)
    .set({ validationsJson: JSON.stringify(next) })
    .where(eq(suggestions.id, id))
    .run();
  return getSuggestion(db, id);
}

export function createSuggestion(
  db: Db,
  input: CreateSuggestionInput,
): Suggestion {
  const now = Date.now();
  const id = newId("sug");
  // Drop any text deltas; only persist tool calls + their results so
  // the events column stays compact.
  const persistable = (input.events ?? []).filter(
    (e) => e.kind === "tool_use" || e.kind === "tool_result",
  );
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
      eventsJson:
        persistable.length > 0 ? JSON.stringify(persistable) : null,
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

/**
 * Wipe every suggestion (and its options) for a project. Used by the
 * brainstorm "reset conversation" action — operator wants a clean
 * thread, no historic clutter. Saved ideas survive: they're keyed
 * to the suggestion but the table is decoupled.
 */
export function deleteProjectSuggestions(db: Db, projectId: string): number {
  const r = db
    .delete(suggestions)
    .where(eq(suggestions.projectId, projectId))
    .run() as { changes?: number } | undefined;
  return Number(r?.changes ?? 0);
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
