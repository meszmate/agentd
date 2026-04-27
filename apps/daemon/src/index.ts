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

  const { app, wsHandler, upgradeRequest } = buildServer({
    db,
    bus,
    paths,
    tasks,
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

  const baseUrl = `http://${cfg.host}:${server.port}`;
  console.log(`agentd v${VERSION}`);
  console.log(`listening on ${baseUrl}`);
  console.log(`web ui:    ${webHtml ? baseUrl + "/" : "(disabled — apps/web/index.html not found)"}`);
  console.log(`db:        ${paths.db}`);
  console.log(`worktrees: ${paths.worktrees}`);
  console.log("");

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
