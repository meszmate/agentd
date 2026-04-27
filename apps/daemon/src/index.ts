import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import qrcode from "qrcode-terminal";
import {
  EventBus,
  ensurePaths,
  issuePairingToken,
  openDb,
  resolvePaths,
} from "@agentd/core";
import { loadConfig } from "./config.ts";
import { buildServer } from "./server.ts";
import { TaskManager } from "./taskManager.ts";
import { PluginManager } from "./pluginManager.ts";
import { Scheduler } from "./scheduler.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_INDEX = resolve(HERE, "..", "..", "web", "index.html");

const VERSION = "0.0.1";

async function main() {
  const cfg = loadConfig();
  const paths = resolvePaths(cfg.rootDir);
  ensurePaths(paths);

  const { db } = openDb(paths.db);
  const bus = new EventBus();
  const tasks = new TaskManager(db, bus, paths);

  const baseUrl = `http://${cfg.host === "0.0.0.0" ? "127.0.0.1" : cfg.host}:${cfg.port}`;
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

  const server = Bun.serve({
    hostname: cfg.host,
    port: cfg.port,
    fetch(req, server) {
      const upgraded = upgradeRequest(req, server);
      if (upgraded !== undefined) return upgraded;
      const url = new URL(req.url);
      if ((url.pathname === "/" || url.pathname === "/index.html") && webHtml) {
        return new Response(webHtml, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      return app.fetch(req, { server });
    },
    websocket: wsHandler,
  });

  const announceUrl = `http://${cfg.host}:${server.port}`;
  console.log(`agentd v${VERSION}`);
  console.log(`listening on ${announceUrl}`);
  console.log(`web ui:    ${webHtml ? announceUrl + "/" : "(disabled — apps/web/index.html not found)"}`);
  console.log(`db:        ${paths.db}`);
  console.log(`worktrees: ${paths.worktrees}`);
  console.log(`config:    ${paths.root}/config.json`);
  console.log("");

  const scheduler = new Scheduler(db, tasks);
  scheduler.start();
  console.log("scheduler: ticking once per minute");

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
    scheduler.stop();
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
