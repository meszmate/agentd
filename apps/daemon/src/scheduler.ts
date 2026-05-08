import {
  EventBus,
  getTemplate,
  getTrigger,
  listSchedules,
  markTriggerFired,
  parseCron,
  recordScheduleRun,
  renderTemplate,
  setTriggerEnabled,
  setTriggerError,
  shouldFireAt,
  type Db,
} from "@agentd/core";
import type { TaskManager } from "./taskManager.ts";
import { evaluateTriggers } from "./triggerEvaluator.ts";

const TICK_INTERVAL_MS = 60_000;

/**
 * Wakes once per minute. Two passes per tick:
 *
 *   1. Cron schedules — fire any whose cron matches the current minute,
 *      dedupe by `lastRunAt` minute floor.
 *   2. Conditional triggers — evaluate predicates (datetime, webhook
 *      readiness, github poll), spawn the linked template's task for
 *      each match.
 *
 * Tick body is awaited end-to-end before re-arming so two ticks can't
 * race on the same trigger.
 */
export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(
    private readonly db: Db,
    private readonly tasks: TaskManager,
    private readonly bus: EventBus,
  ) {}

  start(): void {
    if (this.timer) return;
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
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.tickSchedules();
      await this.tickTriggers();
    } finally {
      this.ticking = false;
    }
  }

  private async tickSchedules(): Promise<void> {
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

  private async tickTriggers(): Promise<void> {
    const now = Date.now();
    let readyIds: string[] = [];
    try {
      readyIds = await evaluateTriggers({ db: this.db, now });
    } catch (e) {
      console.error(
        `[scheduler] trigger evaluation failed: ${(e as Error).message}`,
      );
      return;
    }
    for (const id of readyIds) {
      const trg = getTrigger(this.db, id);
      if (!trg) continue;
      const tpl = getTemplate(this.db, trg.templateId);
      if (!tpl) {
        const msg = `template ${trg.templateId} missing`;
        console.error(`[scheduler] trigger ${trg.name}: ${msg}`);
        setTriggerError(this.db, trg.id, msg);
        continue;
      }
      try {
        const prompt = renderTemplate(tpl.promptTemplate, trg.templateArgs);
        const task = await this.tasks.create({
          agent: tpl.agent,
          repoPath: tpl.repoPath,
          baseBranch: tpl.baseBranch,
          prompt,
          title: `${trg.name}: ${tpl.name}`,
          autoPush: tpl.autoPush,
          templateId: tpl.id,
        });
        const updated = markTriggerFired(this.db, trg.id, task.id, now);
        console.log(
          `[scheduler] trigger ${trg.name} fired → ${task.id}${trg.repeat ? "" : " (auto-disabled)"}`,
        );
        if (updated) {
          this.bus.publishSystem({
            kind: "trigger_fired",
            trigger: updated,
            taskId: task.id,
          });
          this.bus.publishSystem({
            kind: "trigger_updated",
            trigger: updated,
          });
        }
      } catch (e) {
        const msg = (e as Error).message;
        console.error(`[scheduler] trigger ${trg.name} failed to fire: ${msg}`);
        const updated = setTriggerError(this.db, trg.id, msg);
        if (updated && !updated.enabled) {
          // Auto-disabled — fire one more event so UIs reflect the
          // state flip without a refetch.
          setTriggerEnabled(this.db, trg.id, false);
        }
        if (updated) {
          this.bus.publishSystem({ kind: "trigger_updated", trigger: updated });
        }
      }
    }
  }
}
