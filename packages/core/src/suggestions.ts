import { and, eq, desc, lt, or, sql, type SQL } from "drizzle-orm";
import type {
  IdeaMessageEvent,
  IdeaQuestion,
  Suggestion,
  SuggestionStatus,
  SuggestionValidation,
} from "@agentd/contracts";
import { IdeaQuestion as IdeaQuestionSchema } from "@agentd/contracts";
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
  /** Wall-clock duration of the helper run, in ms. */
  durationMs?: number;
  /** Token totals reported by the helper (claude). */
  inputTokens?: number;
  outputTokens?: number;
  /**
   * Clarifying question the brainstorm helper raised instead of (or
   * before) generating options. Surfaces render this card with
   * option buttons; the operator's pick fires a fresh brainstorm
   * with the disambiguated brief.
   */
  question?: IdeaQuestion | null;
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

function parseQuestion(
  raw: string | null | undefined,
): IdeaQuestion | null {
  if (!raw) return null;
  try {
    const safe = IdeaQuestionSchema.safeParse(JSON.parse(raw));
    return safe.success ? safe.data : null;
  } catch {
    return null;
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
  const question = parseQuestion(row.questionJson);
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
    ...(row.durationMs != null ? { durationMs: row.durationMs } : {}),
    ...(row.inputTokens != null ? { inputTokens: row.inputTokens } : {}),
    ...(row.outputTokens != null ? { outputTokens: row.outputTokens } : {}),
    ...(question ? { question } : {}),
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
      durationMs: input.durationMs ?? null,
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null,
      questionJson: input.question ? JSON.stringify(input.question) : null,
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

/**
 * Auto-dismiss pending suggestions older than `maxAgeMs`. Used by the
 * daemon TTL sweep so a brainstorm window the operator never engaged
 * with stops cluttering the project's pending list. Returns the rows
 * that flipped so the caller can broadcast `suggestion_updated` events.
 *
 * `maxAgeMs <= 0` is a no-op (operator opted out of auto-dismiss).
 */
export function autoDismissStalePending(
  db: Db,
  maxAgeMs: number,
): Suggestion[] {
  if (maxAgeMs <= 0) return [];
  const cutoff = Date.now() - maxAgeMs;
  const stale = db
    .select()
    .from(suggestions)
    .where(
      and(
        eq(suggestions.status, "pending"),
        lt(suggestions.createdAt, cutoff),
      )!,
    )
    .all();
  if (stale.length === 0) return [];
  const now = Date.now();
  for (const row of stale) {
    db.update(suggestions)
      .set({ status: "dismissed", resolvedAt: now })
      .where(eq(suggestions.id, row.id))
      .run();
  }
  return stale.map((row) =>
    rowToSuggestion({ ...row, status: "dismissed", resolvedAt: now }),
  );
}

/**
 * Hard-delete `dismissed` / `resolved` suggestions older than `maxAgeMs`.
 * Returns `{id, projectId}` pairs so the daemon can publish
 * `suggestion_removed` events. `maxAgeMs <= 0` keeps history forever.
 */
export function purgeOldArchived(
  db: Db,
  maxAgeMs: number,
): Array<{ id: string; projectId: string | null }> {
  if (maxAgeMs <= 0) return [];
  const cutoff = Date.now() - maxAgeMs;
  // Compare on resolvedAt when present, fall back to createdAt for any
  // legacy row that somehow has status != pending without a resolvedAt.
  const candidates = db
    .select()
    .from(suggestions)
    .where(
      and(
        or(
          eq(suggestions.status, "dismissed"),
          eq(suggestions.status, "resolved"),
        )!,
        lt(sql`coalesce(${suggestions.resolvedAt}, ${suggestions.createdAt})`, cutoff),
      )!,
    )
    .all();
  if (candidates.length === 0) return [];
  for (const row of candidates) {
    db.delete(suggestions).where(eq(suggestions.id, row.id)).run();
  }
  return candidates.map((r) => ({ id: r.id, projectId: r.projectId ?? null }));
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
