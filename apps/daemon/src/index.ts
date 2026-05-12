import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { networkInterfaces, hostname as osHostname } from "node:os";
import { spawnSync } from "node:child_process";
import qrcode from "qrcode-terminal";
import {
  EventBus,
  createSystemSession,
  ensurePaths,
  issuePairingToken,
  loadConfig as loadAgentdConfig,
  openDb,
  resolvePaths,
  saveConfig,
  sessionExists,
  backfillProjectsFromTasks,
} from "@agentd/core";
import { loadConfig } from "./config.ts";
import { buildServer } from "./server.ts";
import { TaskManager } from "./taskManager.ts";
import { PluginManager } from "./pluginManager.ts";
import { Scheduler } from "./scheduler.ts";
import { BrainstormSweep } from "./brainstormSweep.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const WEB_DIST = resolve(REPO_ROOT, "apps", "web", "dist");
const WEB_INDEX = resolve(WEB_DIST, "index.html");
const WEB_PKG = resolve(REPO_ROOT, "apps", "web", "package.json");

const VERSION = "0.0.1";

/**
 * Build the web bundle on the fly when running from a source checkout and
 * `apps/web/dist/index.html` isn't there yet. Lets `bun apps/daemon/src/index.ts`
 * be a true single command — no separate `bun --filter @agentd/web build`
 * step required for a first run.
 *
 * We only attempt this when the workspace package.json exists (i.e. we
 * really are inside the monorepo, not running from a packaged bundle).
 * `AGENTD_NO_AUTOBUILD=1` opts out for operators who want to control the
 * build themselves.
 */
function ensureWebBuilt(): void {
  if (existsSync(WEB_INDEX)) return;
  if (process.env.AGENTD_NO_AUTOBUILD === "1") return;
  if (!existsSync(WEB_PKG)) return;

  console.log("web bundle not found — building once (apps/web/dist)…");
  const r = spawnSync("bun", ["--filter", "@agentd/web", "build"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  if (r.status !== 0) {
    console.error(
      "warning: web build failed — daemon will start without the UI.\n" +
        "         fix the build and restart, or run `bun --filter @agentd/web build` manually.",
    );
  }
}

/**
 * Enumerate the URLs this host is reachable at on the LAN/tailnet/etc.
 * Used in the startup banner when the daemon is bound to 0.0.0.0 — so
 * the operator deploying on a "little server" sees the concrete URL to
 * paste into a browser rather than the un-routable wildcard address.
 */
function listReachableUrls(port: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const host = osHostname();
  if (host && !seen.has(host)) {
    out.push(`http://${host}:${port}`);
    seen.add(host);
  }
  const ifaces = networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const i of ifaces[name] ?? []) {
      if (i.internal) continue;
      // Skip IPv6 — URLs need brackets and most operators want the v4 they
      // can DNS / put in a docs link. If only v6 is configured, the
      // hostname row above still gives them something to copy.
      if (i.family !== "IPv4") continue;
      if (seen.has(i.address)) continue;
      seen.add(i.address);
      out.push(`http://${i.address}:${port}`);
    }
  }
  return out;
}

async function main() {
  const cfg = loadConfig();
  const paths = resolvePaths(cfg.rootDir);
  ensurePaths(paths);

  ensureWebBuilt();

  const { db } = openDb(paths.db);
  const bus = new EventBus();
  const backfilled = backfillProjectsFromTasks(db);
  if (backfilled > 0) {
    console.log(`[projects] backfilled ${backfilled} task(s) into projects`);
  }
  const baseUrl = `http://${cfg.host === "0.0.0.0" ? "127.0.0.1" : cfg.host}:${cfg.port}`;
  // Session for in-process subprocesses (agent runners + chat plugins).
  // Reused across restarts via the user config's pluginSessionToken.
  const agentdCfg = loadAgentdConfig(paths.root);
  let agentSessionToken = agentdCfg.pluginSessionToken ?? "";
  if (!agentSessionToken || !sessionExists(db, agentSessionToken)) {
    const { sessionToken } = createSystemSession(db, "agentd:plugins");
    agentSessionToken = sessionToken;
    saveConfig(paths.root, {
      ...agentdCfg,
      pluginSessionToken: sessionToken,
    });
  }
  const tasks = new TaskManager(db, bus, paths, baseUrl, agentSessionToken);
  // Sweep up tasks that were mid-run when the daemon last died.
  // Their runner processes went with the daemon; the rows stayed
  // at `running`/`waiting_*`/`idle` and the UI would draw "agent is
  // thinking…" forever otherwise.
  tasks.recoverOrphans();
  // Tick a stall watchdog while we're up, too — a live daemon can
  // still get its agent CLI wedged by a network drop, a Mac sleeping
  // mid-API-call, or a hung HTTP socket. The watchdog kills runners
  // whose connections went dead and unsticks the UI without waiting
  // for a daemon restart.
  tasks.startStallWatchdog();

  const plugins = new PluginManager(paths.root, baseUrl, db);

  const { app, wsHandler, upgradeRequest } = buildServer({
    db,
    bus,
    paths,
    tasks,
    plugins,
    version: VERSION,
  });

  const webHtml = existsSync(WEB_INDEX) ? readFileSync(WEB_INDEX, "utf8") : null;

  /**
   * Serve the built Vite app from apps/web/dist when present.
   *
   * Three rules, in order:
   *   1. Static assets (anything in /assets or with a known extension) are
   *      served from disk. Hashed names get an immutable cache.
   *   2. API/WS routes (/api, /ws, /pty, /pair, /health) bypass us entirely
   *      and fall through to the Hono app — handled by returning null below.
   *   3. Everything else (/, /tasks/:id, /templates, ...) gets the SPA shell
   *      so client-side React Router can resolve the route. Without this,
   *      hard-refreshing on /templates would 404.
   */
  function serveWeb(req: Request): Response | null {
    if (!webHtml) return null;
    const url = new URL(req.url);

    // 2. API + WS reserved paths — let the Hono app / WS handler take them.
    if (
      url.pathname.startsWith("/api") ||
      url.pathname.startsWith("/ws") ||
      url.pathname.startsWith("/pty/") ||
      url.pathname === "/pair" ||
      url.pathname === "/health"
    ) {
      return null;
    }

    // 1. Static assets — Vite-hashed assets, plus root-level files (PWA
    //    manifest, icons, favicon). The PWA manifest.json must be served
    //    from the root, so we explicitly include `.json` and `.webmanifest`.
    const assetMatch =
      url.pathname.startsWith("/assets/") ||
      url.pathname.startsWith("/icons/") ||
      url.pathname === "/manifest.json" ||
      /\.(js|css|map|svg|png|webp|ico|woff2?|webmanifest|json|txt)$/.test(url.pathname);
    if (assetMatch) {
      const safe = resolve(WEB_DIST, "." + url.pathname);
      if (!safe.startsWith(WEB_DIST) || !existsSync(safe)) return null;
      const isHashed = /\/assets\//.test(url.pathname);
      return new Response(Bun.file(safe), {
        headers: {
          "cache-control": isHashed
            ? "public, max-age=31536000, immutable"
            : "public, max-age=300",
        },
      });
    }

    // 3. SPA shell fallback — only for GET; let other verbs 404 through Hono.
    if (req.method !== "GET" && req.method !== "HEAD") return null;
    return new Response(webHtml, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache",
      },
    });
  }

  const server = Bun.serve({
    hostname: cfg.host,
    port: cfg.port,
    // AI helper streams (commit message gen, PR title/body gen, etc.)
    // can take 20-60s on large diffs. Bun's default idleTimeout is
    // 10s, which was killing long-running requests with a 500 before
    // the helper finished. Bump to the max (255s) so streaming has
    // room to complete.
    idleTimeout: 255,
    fetch(req, server) {
      const upgraded = upgradeRequest(req, server);
      if (upgraded !== undefined) return upgraded;
      const webResp = serveWeb(req);
      if (webResp) return webResp;
      return app.fetch(req, { server });
    },
    websocket: wsHandler,
  });

  const announceUrl = `http://${cfg.host}:${server.port}`;
  console.log(`agentd v${VERSION}`);
  console.log(`listening on ${announceUrl}`);
  if (cfg.host === "0.0.0.0" || cfg.host === "::") {
    // Bound to every interface — list the actual reachable URLs so the
    // operator can copy/paste one into a browser instead of staring at
    // 0.0.0.0 wondering which IP to use.
    const reachable = listReachableUrls(server.port ?? cfg.port);
    if (reachable.length > 0) {
      console.log("reachable at:");
      for (const u of reachable) console.log(`  ${u}`);
    }
  }
  console.log(
    `web ui:    ${webHtml ? announceUrl + "/" : "(not built — run `bun --filter @agentd/web build`)"}`,
  );
  console.log(`db:        ${paths.db}`);
  console.log(`worktrees: ${paths.worktrees}`);
  console.log(`config:    ${paths.root}/config.json`);
  console.log("");

  const scheduler = new Scheduler(db, tasks, bus);
  scheduler.start();
  console.log("scheduler: ticking once per minute");

  const brainstormSweep = new BrainstormSweep(db, bus, paths);
  brainstormSweep.start();

  plugins.startAll();
  const pluginStatuses = plugins.status();
  for (const p of pluginStatuses) {
    if (!p.enabled) continue;
    console.log(`plugin ${p.name}: ${p.running ? "running (pid " + p.pid + ")" : "failed to start"}${p.lastError ? " — " + p.lastError : ""}`);
  }
  if (pluginStatuses.every((p) => !p.enabled)) {
    console.log("plugins:   none enabled (use `agentd plugin enable <telegram|discord> ...` to add one)");
  }
  console.log("");

  const shutdown = async (sig: string) => {
    console.log(`\nreceived ${sig}, shutting down...`);
    tasks.stopStallWatchdog();
    scheduler.stop();
    brainstormSweep.stop();
    await plugins.stopAll();
    server.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  if (cfg.printPairing) {
    const issued = issuePairingToken(db);
    const pairingUrl = `${baseUrl}/pair?token=${issued.token}`;
    console.log("Pair a new device with this one-time token:");
    console.log(`  token:  ${issued.token}`);
    console.log(`  url:    ${pairingUrl}`);
    console.log(`  expires in 10 minutes`);
    console.log("");
    qrcode.generate(pairingUrl, { small: true });
    console.log("\nuse: agentd pair --server " + baseUrl + " --token <token>");
  }
}

main().catch((err) => {
  console.error("daemon failed:", err);
  process.exit(1);
});
