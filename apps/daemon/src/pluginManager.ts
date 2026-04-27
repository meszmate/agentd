import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createSystemSession,
  loadConfig,
  saveConfig,
  sessionExists,
  type AgentdConfig,
  type Db,
  type PluginName,
} from "@agentd/core";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..", "..");
const TELEGRAM_ENTRY = resolve(ROOT, "apps", "telegram", "src", "index.ts");
const DISCORD_ENTRY = resolve(ROOT, "apps", "discord", "src", "index.ts");

interface PluginProcessState {
  proc: Bun.Subprocess<"ignore", "pipe", "pipe"> | null;
  startedAt: number;
  restarts: number;
  lastError: string | null;
}

export interface PluginStatus {
  name: PluginName;
  enabled: boolean;
  running: boolean;
  pid: number | null;
  restarts: number;
  lastError: string | null;
  startedAt: number | null;
}

const RESTART_BACKOFF_MS = [1000, 2000, 5000, 15000, 30000];
const MAX_RESTARTS_PER_HOUR = 8;

export class PluginManager {
  private states = new Map<PluginName, PluginProcessState>();
  private restartTimers = new Map<PluginName, ReturnType<typeof setTimeout>>();
  private restartHistory = new Map<PluginName, number[]>();
  private shuttingDown = false;

  constructor(
    private readonly rootDir: string,
    private readonly serverUrl: string,
    private readonly db: Db,
  ) {
    for (const name of ["telegram", "discord"] as const) {
      this.states.set(name, {
        proc: null,
        startedAt: 0,
        restarts: 0,
        lastError: null,
      });
      this.restartHistory.set(name, []);
    }
  }

  /** Start every plugin marked enabled in the config. */
  startAll(): void {
    const cfg = loadConfig(this.rootDir);
    const sessionToken = this.ensurePluginSession(cfg);
    for (const name of ["telegram", "discord"] as const) {
      if (cfg.plugins[name].enabled) this.spawn(name, cfg, sessionToken);
    }
  }

  /** Stop everything (called on daemon shutdown). */
  async stopAll(): Promise<void> {
    this.shuttingDown = true;
    for (const t of this.restartTimers.values()) clearTimeout(t);
    this.restartTimers.clear();
    const stops: Promise<unknown>[] = [];
    for (const [, st] of this.states) {
      if (st.proc) {
        try {
          st.proc.kill("SIGTERM");
        } catch {
          // already gone
        }
        stops.push(st.proc.exited);
      }
    }
    await Promise.allSettled(stops);
  }

  status(): PluginStatus[] {
    const cfg = loadConfig(this.rootDir);
    const out: PluginStatus[] = [];
    for (const name of ["telegram", "discord"] as const) {
      const st = this.states.get(name)!;
      out.push({
        name,
        enabled: cfg.plugins[name].enabled,
        running: !!st.proc && st.proc.exitCode == null,
        pid: st.proc?.pid ?? null,
        restarts: st.restarts,
        lastError: st.lastError,
        startedAt: st.startedAt || null,
      });
    }
    return out;
  }

  /** Re-read config and (re)spawn plugins to match. Used when config changes. */
  async reload(): Promise<void> {
    const cfg = loadConfig(this.rootDir);
    const sessionToken = this.ensurePluginSession(cfg);
    for (const name of ["telegram", "discord"] as const) {
      const want = cfg.plugins[name].enabled;
      const st = this.states.get(name)!;
      const running = !!st.proc && st.proc.exitCode == null;
      if (want && !running) {
        this.spawn(name, cfg, sessionToken);
      } else if (!want && running) {
        try {
          st.proc?.kill("SIGTERM");
        } catch {
          // already gone
        }
      } else if (want && running) {
        // restart so config changes take effect
        try {
          st.proc?.kill("SIGTERM");
        } catch {
          // ignore
        }
        await st.proc?.exited;
        this.spawn(name, cfg, sessionToken);
      }
    }
  }

  private spawn(
    name: PluginName,
    cfg: AgentdConfig,
    sessionToken: string,
  ): void {
    if (this.shuttingDown) return;
    const entry = name === "telegram" ? TELEGRAM_ENTRY : DISCORD_ENTRY;
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      AGENTD_SERVER: this.serverUrl,
      AGENTD_TOKEN: sessionToken,
    };

    if (name === "telegram") {
      const tg = cfg.plugins.telegram;
      if (!tg.botToken) {
        this.recordError(name, "telegram enabled but botToken is empty");
        return;
      }
      env.TELEGRAM_BOT_TOKEN = tg.botToken;
      env.TELEGRAM_ALLOWED_USER_IDS = tg.allowedUserIds.join(",");
      env.TELEGRAM_ALLOWED_CHAT_IDS = tg.allowedChatIds.join(",");
      if (tg.defaultRepo) env.AGENTD_DEFAULT_REPO = tg.defaultRepo;
    } else {
      const dc = cfg.plugins.discord;
      if (!dc.botToken) {
        this.recordError(name, "discord enabled but botToken is empty");
        return;
      }
      env.DISCORD_BOT_TOKEN = dc.botToken;
      env.DISCORD_ALLOWED_USER_IDS = dc.allowedUserIds.join(",");
      env.DISCORD_ALLOWED_CHANNEL_IDS = dc.allowedChannelIds.join(",");
      if (dc.defaultRepo) env.AGENTD_DEFAULT_REPO = dc.defaultRepo;
    }

    let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
    try {
      proc = Bun.spawn({
        cmd: ["bun", entry],
        cwd: ROOT,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env,
      });
    } catch (e) {
      this.recordError(name, `spawn failed: ${(e as Error).message}`);
      this.scheduleRestart(name);
      return;
    }

    const st = this.states.get(name)!;
    st.proc = proc;
    st.startedAt = Date.now();
    st.lastError = null;

    void this.pipeOutput(name, proc.stdout);
    void this.pipeOutput(name, proc.stderr, true);
    void this.watchExit(name, proc);
  }

  private async pipeOutput(
    name: PluginName,
    stream: ReadableStream<Uint8Array>,
    isErr = false,
  ): Promise<void> {
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          const stream = isErr ? "stderr" : "stdout";
          console.log(`[${name}:${stream}] ${line}`);
        }
      }
      if (buffer.trim()) console.log(`[${name}] ${buffer}`);
    } catch {
      // stream ended
    }
  }

  private async watchExit(
    name: PluginName,
    proc: Bun.Subprocess<"ignore", "pipe", "pipe">,
  ): Promise<void> {
    const code = await proc.exited;
    const st = this.states.get(name)!;
    if (st.proc === proc) st.proc = null;
    if (this.shuttingDown) return;
    if (code === 0) {
      console.log(`[${name}] exited cleanly`);
      return;
    }
    this.recordError(name, `exited with code ${code}`);
    this.scheduleRestart(name);
  }

  private scheduleRestart(name: PluginName): void {
    if (this.shuttingDown) return;
    const history = this.restartHistory.get(name)!;
    const oneHourAgo = Date.now() - 3_600_000;
    const recent = history.filter((t) => t > oneHourAgo);
    this.restartHistory.set(name, recent);
    if (recent.length >= MAX_RESTARTS_PER_HOUR) {
      this.recordError(
        name,
        `${recent.length} restarts in the last hour — giving up. Fix config and run 'agentd plugin reload'.`,
      );
      return;
    }
    const idx = Math.min(recent.length, RESTART_BACKOFF_MS.length - 1);
    const delay = RESTART_BACKOFF_MS[idx]!;
    console.log(`[${name}] restarting in ${delay}ms (attempt ${recent.length + 1})`);
    const timer = setTimeout(() => {
      recent.push(Date.now());
      this.restartHistory.set(name, recent);
      const cfg = loadConfig(this.rootDir);
      const sessionToken = this.ensurePluginSession(cfg);
      const st = this.states.get(name)!;
      st.restarts += 1;
      this.spawn(name, cfg, sessionToken);
    }, delay);
    this.restartTimers.set(name, timer);
  }

  private recordError(name: PluginName, msg: string): void {
    const st = this.states.get(name)!;
    st.lastError = msg;
    console.error(`[${name}] ${msg}`);
  }

  /**
   * Mint (or reuse) a long-lived session for plugin subprocesses to authenticate
   * with the daemon. Stored in the config so it survives daemon restarts.
   */
  private ensurePluginSession(cfg: AgentdConfig): string {
    if (cfg.pluginSessionToken && sessionExists(this.db, cfg.pluginSessionToken)) {
      return cfg.pluginSessionToken;
    }
    const { sessionToken } = createSystemSession(this.db, "agentd:plugins");
    saveConfig(this.rootDir, { ...cfg, pluginSessionToken: sessionToken });
    return sessionToken;
  }
}
