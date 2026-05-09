import { eq, desc } from "drizzle-orm";
import {
  type Trigger,
  type TriggerPredicateConfig,
  type TriggerPredicateKind,
  TriggerPredicateConfig as TriggerPredicateConfigSchema,
} from "@agentd/contracts";
import { triggers, type Db } from "./db.ts";
import { newId } from "./auth.ts";

/**
 * Once a trigger errors this many times in a row, the evaluator
 * auto-disables it. Prevents a misconfigured GitHub trigger from
 * burning gh API budget forever.
 */
export const TRIGGER_ERROR_AUTO_DISABLE_THRESHOLD = 5;

export interface CreateTriggerInput {
  name: string;
  predicateKind: TriggerPredicateKind;
  predicateConfig: TriggerPredicateConfig;
  templateId: string;
  templateArgs: Record<string, string>;
  enabled: boolean;
  repeat: boolean;
}

function rowToTrigger(row: typeof triggers.$inferSelect): Trigger {
  let args: Record<string, string> = {};
  try {
    const parsed = JSON.parse(row.templateArgsJson);
    if (parsed && typeof parsed === "object") {
      args = parsed as Record<string, string>;
    }
  } catch {
    // ignore corrupt args
  }
  let cfg: TriggerPredicateConfig;
  try {
    const parsed = JSON.parse(row.predicateConfigJson);
    cfg = TriggerPredicateConfigSchema.parse(parsed);
  } catch {
    // Treat unparseable config as a webhook with an empty secret so
    // the row stays visible in the UI for the operator to repair,
    // rather than poisoning the whole list.
    cfg = { kind: "webhook", secret: "" } as TriggerPredicateConfig;
  }
  return {
    id: row.id,
    name: row.name,
    predicateKind: row.predicateKind as TriggerPredicateKind,
    predicateConfig: cfg,
    templateId: row.templateId,
    templateArgs: args,
    enabled: row.enabled === 1,
    repeat: row.repeat === 1,
    lastFiredAt: row.lastFiredAt,
    lastFiredTaskId: row.lastFiredTaskId,
    lastError: row.lastError,
    errorCount: row.errorCount,
    createdAt: row.createdAt,
  };
}

export function createTrigger(db: Db, input: CreateTriggerInput): Trigger {
  // Validate the predicate config matches the kind upfront so we fail
  // loudly at create time, not when the evaluator runs.
  const validated = TriggerPredicateConfigSchema.parse(input.predicateConfig);
  if (validated.kind !== input.predicateKind) {
    throw new Error(
      `predicateKind '${input.predicateKind}' does not match predicateConfig.kind '${validated.kind}'`,
    );
  }
  const id = newId("trg");
  const now = Date.now();
  db.insert(triggers)
    .values({
      id,
      name: input.name,
      predicateKind: input.predicateKind,
      predicateConfigJson: JSON.stringify(validated),
      templateId: input.templateId,
      templateArgsJson: JSON.stringify(input.templateArgs ?? {}),
      enabled: input.enabled ? 1 : 0,
      repeat: input.repeat ? 1 : 0,
      lastFiredAt: null,
      lastFiredTaskId: null,
      lastError: null,
      errorCount: 0,
      createdAt: now,
    })
    .run();
  return getTrigger(db, id)!;
}

export function getTrigger(db: Db, id: string): Trigger | null {
  const row = db.select().from(triggers).where(eq(triggers.id, id)).get();
  return row ? rowToTrigger(row) : null;
}

export function getTriggerByName(db: Db, name: string): Trigger | null {
  const row = db.select().from(triggers).where(eq(triggers.name, name)).get();
  return row ? rowToTrigger(row) : null;
}

export function listTriggers(db: Db): Trigger[] {
  return db
    .select()
    .from(triggers)
    .orderBy(desc(triggers.createdAt))
    .all()
    .map(rowToTrigger);
}

export function deleteTrigger(db: Db, id: string): void {
  db.delete(triggers).where(eq(triggers.id, id)).run();
}

export interface UpdateTriggerInput {
  name?: string;
  predicateConfig?: TriggerPredicateConfig;
  templateArgs?: Record<string, string>;
  enabled?: boolean;
  repeat?: boolean;
}

export function updateTrigger(
  db: Db,
  id: string,
  patch: UpdateTriggerInput,
): Trigger | null {
  const existing = getTrigger(db, id);
  if (!existing) return null;
  const set: Partial<typeof triggers.$inferInsert> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.predicateConfig !== undefined) {
    const validated = TriggerPredicateConfigSchema.parse(patch.predicateConfig);
    if (validated.kind !== existing.predicateKind) {
      throw new Error(
        `cannot change predicateKind via update (was ${existing.predicateKind}, got ${validated.kind})`,
      );
    }
    set.predicateConfigJson = JSON.stringify(validated);
  }
  if (patch.templateArgs !== undefined) {
    set.templateArgsJson = JSON.stringify(patch.templateArgs);
  }
  if (patch.enabled !== undefined) set.enabled = patch.enabled ? 1 : 0;
  if (patch.repeat !== undefined) set.repeat = patch.repeat ? 1 : 0;
  if (Object.keys(set).length === 0) return existing;
  db.update(triggers).set(set).where(eq(triggers.id, id)).run();
  return getTrigger(db, id);
}

export function setTriggerEnabled(
  db: Db,
  id: string,
  enabled: boolean,
): Trigger | null {
  db.update(triggers)
    .set({ enabled: enabled ? 1 : 0 })
    .where(eq(triggers.id, id))
    .run();
  return getTrigger(db, id);
}

export function markTriggerFired(
  db: Db,
  id: string,
  taskId: string | null,
  firedAt: number = Date.now(),
): Trigger | null {
  const existing = getTrigger(db, id);
  if (!existing) return null;
  // Webhook readyAt is consumed on fire so a future POST can flip it
  // again (necessary for `repeat: true` triggers — otherwise the
  // evaluator would immediately re-fire on the next tick).
  let predicateConfigJson: string | undefined;
  if (existing.predicateConfig.kind === "webhook") {
    const cleared = { ...existing.predicateConfig, readyAt: null };
    predicateConfigJson = JSON.stringify(cleared);
  }
  const set: Partial<typeof triggers.$inferInsert> = {
    lastFiredAt: firedAt,
    lastFiredTaskId: taskId,
    lastError: null,
    errorCount: 0,
  };
  if (predicateConfigJson !== undefined) {
    set.predicateConfigJson = predicateConfigJson;
  }
  if (!existing.repeat) set.enabled = 0;
  db.update(triggers).set(set).where(eq(triggers.id, id)).run();
  return getTrigger(db, id);
}

export function setTriggerError(
  db: Db,
  id: string,
  message: string,
): Trigger | null {
  const existing = getTrigger(db, id);
  if (!existing) return null;
  const nextCount = existing.errorCount + 1;
  const set: Partial<typeof triggers.$inferInsert> = {
    lastError: message,
    errorCount: nextCount,
  };
  if (nextCount >= TRIGGER_ERROR_AUTO_DISABLE_THRESHOLD) {
    set.enabled = 0;
  }
  db.update(triggers).set(set).where(eq(triggers.id, id)).run();
  return getTrigger(db, id);
}

export function clearTriggerError(db: Db, id: string): Trigger | null {
  db.update(triggers)
    .set({ lastError: null, errorCount: 0 })
    .where(eq(triggers.id, id))
    .run();
  return getTrigger(db, id);
}

export function setWebhookReady(
  db: Db,
  id: string,
  readyAt: number = Date.now(),
): Trigger | null {
  const existing = getTrigger(db, id);
  if (!existing) return null;
  if (existing.predicateConfig.kind !== "webhook") {
    throw new Error(`trigger ${id} is not a webhook trigger`);
  }
  const next = { ...existing.predicateConfig, readyAt };
  db.update(triggers)
    .set({ predicateConfigJson: JSON.stringify(next) })
    .where(eq(triggers.id, id))
    .run();
  return getTrigger(db, id);
}
