// Electron main process for @agentd/desktop.
//
// This is intentionally a thin wrapper. The web UI is the same React app
// the daemon already serves at /, loaded via http://127.0.0.1:3773. The
// desktop app:
//
//   1. Tries to reach an existing daemon on AGENTD_DESKTOP_PORT (default 3773).
//   2. If none is running and AGENTD_DESKTOP_NO_SPAWN is not set, spawns
//      `bun apps/daemon/src/index.ts` from the repo root and waits for
//      /health to come up.
//   3. Loads the daemon URL into a single BrowserWindow.
//   4. Tears the spawned daemon down on quit.
//
// AGENTD_DESKTOP_URL overrides the URL to load (used by `bun run dev` to
// point the window at the Vite dev server on :5173).

"use strict";

const { app, BrowserWindow, shell, Menu } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");

const PORT = Number(process.env.AGENTD_DESKTOP_PORT ?? 3773);
const HOST = "127.0.0.1";
const DAEMON_BASE = `http://${HOST}:${PORT}`;
const TARGET_URL = process.env.AGENTD_DESKTOP_URL || DAEMON_BASE;
const NO_SPAWN = process.env.AGENTD_DESKTOP_NO_SPAWN === "1";

// Resolve repo root from this file: apps/desktop/src/main.cjs -> ../../..
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const DAEMON_ENTRY = path.join(REPO_ROOT, "apps", "daemon", "src", "index.ts");

let daemonProc = null;
let mainWindow = null;

function pingHealth(timeoutMs = 800) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: HOST, port: PORT, path: "/health", timeout: timeoutMs },
      (res) => {
        // Drain to free the socket.
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

async function waitForHealth(maxMs = 30_000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (await pingHealth()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function spawnDaemon() {
  if (NO_SPAWN) return null;
  if (!fs.existsSync(DAEMON_ENTRY)) {
    console.warn(
      `[desktop] daemon entry not found at ${DAEMON_ENTRY}; ` +
        `not spawning. Set AGENTD_DESKTOP_URL or start the daemon manually.`,
    );
    return null;
  }
  console.log(`[desktop] spawning daemon: bun ${DAEMON_ENTRY}`);
  const proc = spawn("bun", [DAEMON_ENTRY], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env },
  });
  proc.on("exit", (code, signal) => {
    console.log(`[desktop] daemon exited code=${code} signal=${signal}`);
    daemonProc = null;
  });
  proc.on("error", (err) => {
    console.error("[desktop] failed to spawn daemon:", err.message);
    daemonProc = null;
  });
  return proc;
}

function killDaemon() {
  if (!daemonProc) return;
  try {
    daemonProc.kill("SIGTERM");
  } catch {
    // ignore
  }
  daemonProc = null;
}

function createWindow(url) {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 720,
    minHeight: 480,
    title: "agentd",
    backgroundColor: "#0b0b0b",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  // External links open in the user's browser, not inside the app.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//i.test(target)) {
      shell.openExternal(target).catch(() => {});
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  win.loadURL(url);
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });
  return win;
}

async function bootstrap() {
  // If the user pointed us at a custom URL (e.g. Vite dev server), don't
  // spawn or health-check anything — just load it.
  if (process.env.AGENTD_DESKTOP_URL) {
    mainWindow = createWindow(TARGET_URL);
    return;
  }

  const alive = await pingHealth();
  if (!alive) {
    daemonProc = spawnDaemon();
    if (daemonProc) {
      const ok = await waitForHealth();
      if (!ok) {
        console.error(
          "[desktop] daemon did not respond on /health within 30s; " +
            "loading the URL anyway",
        );
      }
    }
  } else {
    console.log(`[desktop] attaching to existing daemon at ${DAEMON_BASE}`);
  }

  mainWindow = createWindow(TARGET_URL);
}

// Strip the default menu bar; the web app provides its own navigation.
Menu.setApplicationMenu(null);

app.on("ready", () => {
  bootstrap().catch((err) => {
    console.error("[desktop] bootstrap failed:", err);
    app.quit();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    bootstrap().catch(() => {});
  }
});

app.on("before-quit", () => {
  killDaemon();
});
