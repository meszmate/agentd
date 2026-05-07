import {
  autoDismissStalePending,
  EventBus,
  loadConfig,
  purgeOldArchived,
  type AgentdPaths,
  type Db,
} from "@agentd/core";

/**
 * Background TTL sweep for ephemeral brainstorm suggestions.
 *
 * Two passes per tick, both no-ops when the operator opted out via
 * `cfg.brainstorm.{pendingTtlHours,archiveTtlDays}` set to 0:
 *
 *   1. Auto-dismiss `pending` rows older than `pendingTtlHours` — the
 *      brainstorm window the operator never picked from stops cluttering
 *      the project's pending list. Emits `suggestion_updated` so any
 *      open surface (web stack, telegram inbox) drops the row live.
 *   2. Hard-delete `dismissed` / `resolved` rows older than
 *      `archiveTtlDays`. Emits `suggestion_removed` for each so caches
 *      drop without a refetch.
 *
 * Cadence comes from `cfg.brainstorm.sweepIntervalMinutes`; defaulting
 * to 30 minutes keeps it cheap (two indexed selects + small batch of
 * point writes). Re-reads config on every tick so editing
 * `~/.agentd/config.json` takes effect without a daemon restart.
 */
export class BrainstormSweep {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly db: Db,
    private readonly bus: EventBus,
    private readonly paths: AgentdPaths,
  ) {}

  start(): void {
    if (this.timer) return;
    const cfg = loadConfig(this.paths.root);
    const intervalMs = Math.max(60_000, cfg.brainstorm.sweepIntervalMinutes * 60_000);
    this.timer = setInterval(() => this.tick(), intervalMs);
    // Run once a few seconds after boot so any pre-existing stale rows
    // get caught without waiting for the first interval.
    setTimeout(() => this.tick(), 10_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    try {
      const cfg = loadConfig(this.paths.root);
      const pendingMs = cfg.brainstorm.pendingTtlHours * 3_600_000;
      const archiveMs = cfg.brainstorm.archiveTtlDays * 86_400_000;
      const dismissed = autoDismissStalePending(this.db, pendingMs);
      for (const sug of dismissed) {
        this.bus.publishSystem({ kind: "suggestion_updated", suggestion: sug });
      }
      const removed = purgeOldArchived(this.db, archiveMs);
      for (const r of removed) {
        this.bus.publishSystem({
          kind: "suggestion_removed",
          suggestionId: r.id,
          projectId: r.projectId,
        });
      }
      if (dismissed.length > 0 || removed.length > 0) {
        console.log(
          `[brainstorm-sweep] auto-dismissed ${dismissed.length}, purged ${removed.length}`,
        );
      }
    } catch (e) {
      console.error(`[brainstorm-sweep] tick failed: ${(e as Error).message}`);
    }
  }
}
