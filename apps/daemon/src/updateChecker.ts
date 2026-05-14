/**
 * Periodic npm-update check. Owns one piece of state — the latest known
 * `UpdateInfo` snapshot — and broadcasts it on the EventBus whenever it
 * changes so the web banner (and any other connected surface) can render
 * without polling.
 *
 * Schedule: a check fires on `start()`, then every 24h. We also retry
 * sooner (every 1h) after a failed check so a transient registry hiccup
 * resolves itself within a day instead of waiting until tomorrow's slot.
 *
 * Disable per-operator via `cfg.prefs.updateCheck = false` — handled by
 * the caller, not here; this class is dumb and just polls.
 */

import type { UpdateInfo } from "@agentd/contracts";
import type { EventBus } from "@agentd/core";

const REGISTRY_URL = "https://registry.npmjs.org/@meszmate/agentd/latest";
const NORMAL_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RETRY_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Are we running under a service manager that will restart us on a
 * non-zero exit? systemd sets `INVOCATION_ID` for every spawned unit;
 * launchd sets `XPC_SERVICE_NAME` for Launch{Agents,Daemons}. Anything
 * else (foreground `agentd serve`, Docker without --restart, etc.)
 * doesn't qualify — the one-click update button would download the new
 * version, exit, and the daemon would stay down.
 */
export function isServiceManaged(): boolean {
  if (process.platform === "linux") {
    return !!process.env.INVOCATION_ID;
  }
  if (process.platform === "darwin") {
    return !!process.env.XPC_SERVICE_NAME;
  }
  return false;
}

export class UpdateChecker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private info: UpdateInfo;
  private applying = false;

  constructor(
    private readonly bus: EventBus,
    currentVersion: string,
  ) {
    this.info = {
      currentVersion,
      latestVersion: null,
      checkedAt: null,
      error: null,
      updateAvailable: false,
      serviceManaged: isServiceManaged(),
    };
  }

  getInfo(): UpdateInfo {
    return this.info;
  }

  start(): void {
    void this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Force a re-check now. Used by the `POST /api/update-info/check`
   * endpoint so an operator who just shipped a new version can confirm
   * the banner without waiting 24h.
   */
  async checkNow(): Promise<UpdateInfo> {
    return this.check();
  }

  /**
   * One-click update: spawn `bun install -g @meszmate/agentd@latest`,
   * wait for it, then exit non-zero so the service manager restarts
   * us into the freshly installed version.
   *
   * Returns immediately (the HTTP handler responds before the install
   * starts) — the actual install runs async in the background and the
   * daemon eventually exits. The web client sees the WS disconnect,
   * reconnects when systemd/launchd respawns us, and picks up the new
   * version via the boot probe.
   *
   * Refuses to act if we're not service-managed: a foreground daemon
   * would just download and exit, leaving the operator stuck.
   * Idempotent — concurrent calls collapse to one in-flight install.
   */
  applyUpdate(): { started: boolean; reason?: string } {
    if (!this.info.serviceManaged) {
      return {
        started: false,
        reason:
          "daemon is not service-managed (run `agentd setup` to enable one-click updates)",
      };
    }
    if (this.applying) {
      return { started: false, reason: "update already in progress" };
    }
    this.applying = true;
    // setImmediate so the HTTP response leaves the wire before we
    // start a multi-second `bun install` that may saturate the process.
    setImmediate(() => void this.doApply());
    return { started: true };
  }

  private async doApply(): Promise<void> {
    try {
      console.log("[update] running: bun install -g @meszmate/agentd@latest");
      // process.execPath is the bun binary running us. Reuse it so the
      // child install goes to the same global prefix we'll be restarting
      // out of, regardless of the service manager's PATH.
      const proc = Bun.spawn({
        cmd: [
          process.execPath,
          "install",
          "-g",
          "@meszmate/agentd@latest",
        ],
        stdio: ["ignore", "inherit", "inherit"],
      });
      const code = await proc.exited;
      if (code !== 0) {
        console.error(
          `[update] install exited with code ${code}; not restarting`,
        );
        this.applying = false;
        return;
      }
      console.log(
        "[update] install complete; exiting so service manager restarts us",
      );
      // Exit non-zero so systemd's Restart=on-failure picks us up. launchd's
      // KeepAlive=true doesn't care about exit code — it restarts on any
      // exit. Code 1 is the conventional "intentional failure" marker.
      process.exit(1);
    } catch (e) {
      console.error("[update] failed:", (e as Error).message);
      this.applying = false;
    }
  }

  private async tick(): Promise<void> {
    const info = await this.check();
    const next = info.error ? RETRY_INTERVAL_MS : NORMAL_INTERVAL_MS;
    this.timer = setTimeout(() => void this.tick(), next);
  }

  private async check(): Promise<UpdateInfo> {
    let next: UpdateInfo;
    try {
      // AbortSignal.timeout: don't hold the loop forever on a slow registry.
      // 8s is generous for what is normally a sub-100ms request.
      const r = await fetch(REGISTRY_URL, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) {
        throw new Error(`registry returned HTTP ${r.status}`);
      }
      const body = (await r.json()) as { version?: unknown };
      if (typeof body.version !== "string" || !body.version) {
        throw new Error("registry response missing version field");
      }
      const latest = body.version;
      next = {
        currentVersion: this.info.currentVersion,
        latestVersion: latest,
        checkedAt: Date.now(),
        error: null,
        updateAvailable: isNewer(latest, this.info.currentVersion),
        serviceManaged: this.info.serviceManaged,
      };
    } catch (e) {
      next = {
        currentVersion: this.info.currentVersion,
        latestVersion: this.info.latestVersion,
        checkedAt: Date.now(),
        error: (e as Error).message,
        updateAvailable: this.info.updateAvailable,
        serviceManaged: this.info.serviceManaged,
      };
    }

    if (snapshotEquals(this.info, next)) {
      // No observable change. Skip the broadcast so we don't wake every
      // connected client just to re-deliver the same payload.
      this.info = next;
      return next;
    }

    this.info = next;
    this.bus.publishSystem({ kind: "update_info", info: next });
    return next;
  }
}

function snapshotEquals(a: UpdateInfo, b: UpdateInfo): boolean {
  return (
    a.currentVersion === b.currentVersion &&
    a.latestVersion === b.latestVersion &&
    a.error === b.error &&
    a.updateAvailable === b.updateAvailable
  );
}

/**
 * Tiny semver comparator: returns true if `latest` is strictly greater than
 * `current`. We don't pull in a full semver package — the formats we accept
 * are the canonical `MAJOR.MINOR.PATCH` plus an optional prerelease tag
 * (`0.0.5-rc.1`), which the registry always normalizes. Anything weirder
 * falls back to `latest !== current` so the banner stays useful for
 * malformed tags rather than silently going quiet.
 */
function isNewer(latest: string, current: string): boolean {
  if (latest === current) return false;
  const parse = (v: string): [number, number, number, string] => {
    const [core, pre = ""] = v.split("-", 2);
    if (!core) return [0, 0, 0, ""];
    const parts = core.split(".").map((p) => parseInt(p, 10));
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, pre];
  };
  const [lM, lm, lp, lpre] = parse(latest);
  const [cM, cm, cp, cpre] = parse(current);
  if ([lM, lm, lp, cM, cm, cp].some((n) => !Number.isFinite(n))) {
    return latest !== current;
  }
  if (lM !== cM) return lM > cM;
  if (lm !== cm) return lm > cm;
  if (lp !== cp) return lp > cp;
  // Equal core: a prerelease tag (e.g. 0.0.5-rc.1) loses to the bare
  // release (0.0.5). Otherwise compare prerelease strings lexicographically.
  if (cpre && !lpre) return true;
  if (lpre && !cpre) return false;
  return lpre > cpre;
}
