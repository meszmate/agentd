import { eq, desc } from "drizzle-orm";
import type { Schedule } from "@agentd/contracts";
import { schedules, type Db } from "./db.ts";
import { newId } from "./auth.ts";
import { parseCron, nextRun } from "./cron.ts";

export interface CreateScheduleInput {
  name: string;
  cron: string;
  templateId: string;
  templateArgs: Record<string, string>;
  enabled: boolean;
}

function rowToSchedule(row: typeof schedules.$inferSelect): Schedule {
  let args: Record<string, string> = {};
  try {
    const parsed = JSON.parse(row.templateArgsJson);
    if (parsed && typeof parsed === "object") args = parsed as Record<string, string>;
  } catch {
    // ignore corrupt args; surface as empty
  }
  return {
    id: row.id,
    name: row.name,
    cron: row.cron,
    templateId: row.templateId,
    templateArgs: args,
    enabled: row.enabled === 1,
    lastRunAt: row.lastRunAt,
    lastTaskId: row.lastTaskId,
    nextRunAt: row.nextRunAt,
    createdAt: row.createdAt,
  };
}

export function createSchedule(db: Db, input: CreateScheduleInput): Schedule {
  // Validate cron upfront so we fail loudly at creation, not at fire time.
  const expr = parseCron(input.cron);
  const next = nextRun(expr);
  const id = newId("sch");
  const now = Date.now();
  db.insert(schedules)
    .values({
      id,
      name: input.name,
      cron: input.cron,
      templateId: input.templateId,
      templateArgsJson: JSON.stringify(input.templateArgs ?? {}),
      enabled: input.enabled ? 1 : 0,
      lastRunAt: null,
      lastTaskId: null,
      nextRunAt: next ? next.getTime() : null,
      createdAt: now,
    })
    .run();
  return getSchedule(db, id)!;
}

export function getSchedule(db: Db, id: string): Schedule | null {
  const row = db.select().from(schedules).where(eq(schedules.id, id)).get();
  return row ? rowToSchedule(row) : null;
}

export function getScheduleByName(db: Db, name: string): Schedule | null {
  const row = db.select().from(schedules).where(eq(schedules.name, name)).get();
  return row ? rowToSchedule(row) : null;
}

export function listSchedules(db: Db): Schedule[] {
  return db
    .select()
    .from(schedules)
    .orderBy(desc(schedules.createdAt))
    .all()
    .map(rowToSchedule);
}

export function deleteSchedule(db: Db, id: string): void {
  db.delete(schedules).where(eq(schedules.id, id)).run();
}

export function setScheduleEnabled(
  db: Db,
  id: string,
  enabled: boolean,
): Schedule | null {
  db.update(schedules)
    .set({ enabled: enabled ? 1 : 0 })
    .where(eq(schedules.id, id))
    .run();
  return getSchedule(db, id);
}

export function recordScheduleRun(
  db: Db,
  id: string,
  ranAt: number,
  taskId: string | null,
): void {
  const sched = getSchedule(db, id);
  if (!sched) return;
  const next = nextRun(parseCron(sched.cron), new Date(ranAt));
  db.update(schedules)
    .set({
      lastRunAt: ranAt,
      lastTaskId: taskId,
      nextRunAt: next ? next.getTime() : null,
    })
    .where(eq(schedules.id, id))
    .run();
}
