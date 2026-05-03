import {
  getTemplate,
  listSchedules,
  parseCron,
  recordScheduleRun,
  renderTemplate,
  shouldFireAt,
  type Db,
} from "@agentd/core";
import type { TaskManager } from "./taskManager.ts";

const TICK_INTERVAL_MS = 60_000;

/**
 * Wakes once per minute, finds enabled schedules whose cron matches the
 * current minute, and fires the linked template as a new task. We dedupe by
 * comparing the schedule's `lastRunAt` minute floor — so at most one task per
 * schedule per minute, even if the timer fires twice or the daemon was just
 * restarted into the same minute.
 */
export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly db: Db,
    private readonly tasks: TaskManager,
  ) {}

  start(): void {
    if (this.timer) return;
    // Tick once immediately, then on a cadence. Aligning to the wall clock
    // would be more elegant but a 60s tick is fine for minute-resolution
    // crons — the worst case is firing up to 59s late on the very first
    // tick after daemon start.
    this.timer = setInterval(() => void this.tick(), TICK_INTERVAL_MS);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private floorMinute(ts: number): number {
    const d = new Date(ts);
    d.setSeconds(0, 0);
    return d.getTime();
  }

  private async tick(): Promise<void> {
    const now = new Date();
    const nowMinute = this.floorMinute(now.getTime());
    const all = listSchedules(this.db);
    for (const sch of all) {
      if (!sch.enabled) continue;
      let expr;
      try {
        expr = parseCron(sch.cron);
      } catch (e) {
        console.error(`[scheduler] schedule ${sch.name}: bad cron "${sch.cron}": ${(e as Error).message}`);
        continue;
      }
      if (!shouldFireAt(expr, now)) continue;
      // Dedupe within the same minute.
      if (sch.lastRunAt && this.floorMinute(sch.lastRunAt) === nowMinute) continue;

      const tpl = getTemplate(this.db, sch.templateId);
      if (!tpl) {
        console.error(`[scheduler] schedule ${sch.name}: template ${sch.templateId} missing`);
        continue;
      }
      try {
        const prompt = renderTemplate(tpl.promptTemplate, sch.templateArgs);
        if (tpl.kind === "ideation") {
          // Ideation templates don't spawn a task. They run a small AI
          // helper that proposes options for the operator to pick from.
          // Picking happens in the chat / web inbox and creates the
          // real task at that point.
          const sug = await this.tasks.fireIdeation(tpl, prompt, sch.id);
          recordScheduleRun(this.db, sch.id, nowMinute, sug?.id ?? null);
          console.log(
            `[scheduler] fired ${sch.name} → suggestion ${sug?.id ?? "(skipped)"}`,
          );
        } else {
          const task = await this.tasks.create({
            agent: tpl.agent,
            repoPath: tpl.repoPath,
            baseBranch: tpl.baseBranch,
            prompt,
            title: `${sch.name}: ${tpl.name}`,
            autoPush: tpl.autoPush,
            templateId: tpl.id,
            scheduleId: sch.id,
          });
          recordScheduleRun(this.db, sch.id, nowMinute, task.id);
          console.log(`[scheduler] fired ${sch.name} → ${task.id}`);
        }
      } catch (e) {
        console.error(`[scheduler] schedule ${sch.name} failed to fire: ${(e as Error).message}`);
      }
    }
  }
}
