import { eq, desc, asc } from "drizzle-orm";
import type { Council, CouncilStatus } from "@agentd/contracts";
import type { Db } from "./db.ts";
import { councils, tasks } from "./db.ts";
import { newId } from "./auth.ts";

export interface CreateCouncilInput {
  id?: string;
  projectId?: string | null;
  repoPath: string;
  baseBranch: string;
  prompt: string;
}

function rowToCouncil(
  row: typeof councils.$inferSelect,
  taskIds: string[],
): Council {
  return {
    id: row.id,
    projectId: row.projectId ?? null,
    repoPath: row.repoPath,
    baseBranch: row.baseBranch,
    prompt: row.prompt,
    status: (row.status as CouncilStatus) ?? "running",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    taskIds,
    winnerTaskId: row.winnerTaskId ?? null,
    judgeExplanation: row.judgeExplanation ?? null,
  };
}

export function createCouncil(db: Db, input: CreateCouncilInput): Council {
  const now = Date.now();
  const id = input.id ?? newId("cnl");
  db.insert(councils)
    .values({
      id,
      projectId: input.projectId ?? null,
      repoPath: input.repoPath,
      baseBranch: input.baseBranch,
      prompt: input.prompt,
      status: "running",
      createdAt: now,
      updatedAt: now,
      winnerTaskId: null,
      judgeExplanation: null,
    })
    .run();
  return getCouncil(db, id)!;
}

export function getCouncil(db: Db, id: string): Council | null {
  const row = db.select().from(councils).where(eq(councils.id, id)).get();
  if (!row) return null;
  const memberRows = db
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.councilId, id))
    .orderBy(asc(tasks.createdAt))
    .all();
  return rowToCouncil(row, memberRows.map((r) => r.id));
}

export function listCouncils(db: Db): Council[] {
  const rows = db
    .select()
    .from(councils)
    .orderBy(desc(councils.createdAt))
    .all();
  return rows.map((row) => {
    const memberRows = db
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.councilId, row.id))
      .orderBy(asc(tasks.createdAt))
      .all();
    return rowToCouncil(row, memberRows.map((r) => r.id));
  });
}

export function setCouncilStatus(
  db: Db,
  id: string,
  status: CouncilStatus,
): void {
  db.update(councils)
    .set({ status, updatedAt: Date.now() })
    .where(eq(councils.id, id))
    .run();
}

export function setCouncilWinner(
  db: Db,
  id: string,
  winnerTaskId: string,
  judgeExplanation: string,
): void {
  db.update(councils)
    .set({
      winnerTaskId,
      judgeExplanation,
      status: "done",
      updatedAt: Date.now(),
    })
    .where(eq(councils.id, id))
    .run();
}
