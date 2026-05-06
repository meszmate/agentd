// Electron main process for @agentd/desktop.
//
// This is intentionally a thin wrapper. The web UI is the same React app
// the daemon already serves at /, loaded via http://127.0.0.1:3773. The
// desktop app:
//
//   1. Honors AGENTD_DESKTOP_URL if set (used by `bun run dev`).
//   2. Tries any URL the operator previously saved via the in-app
//      connect page (userData/connection.json).
//   3. Tries to reach a local daemon on AGENTD_DESKTOP_PORT (default 3773).
//   4. If none is running and AGENTD_DESKTOP_NO_SPAWN is not set, spawns
//      `bun apps/daemon/src/index.ts` from the repo root and waits for
//      /health to come up.
//   5. If Bun isn't installed and there's no saved/remote URL, opens a
//      built-in connect.html window where the operator can enter a URL
//      pointing at a daemon on another machine. The URL is persisted so
//      subsequent launches use it directly.
//   6. Loads the daemon URL into a single BrowserWindow.
//   7. Tears any spawned daemon down on quit.

"use strict";

const {
  app,
  BrowserWindow,
  shell,
  Menu,
  ipcMain,
} = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");

const PORT = Number(process.env.AGENTD_DESKTOP_PORT ?? 3773);
const HOST = "127.0.0.1";
const DAEMON_BASE = `http://${HOST}:${PORT}`;
const ENV_URL = process.env.AGENTD_DESKTOP_URL || "";
const NO_SPAWN = process.env.AGENTD_DESKTOP_NO_SPAWN === "1";

// Resolve repo root from this file: apps/desktop/src/main.cjs -> ../../..
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const DAEMON_ENTRY = path.join(REPO_ROOT, "apps", "daemon", "src", "index.ts");

let daemonProc = null;
let mainWindow = null;
let connectWindow = null;
let connectReason = "";

function getConfigPath() {
  return path.join(app.getPath("userData"), "connection.json");
}

function readSavedUrl() {
  try {
    const raw = fs.readFileSync(getConfigPath(), "utf8");
    const data = JSON.parse(raw);
    if (typeof data?.url === "string" && data.url.trim()) {
      return data.url.trim();
    }
  } catch {
    // No file or unreadable; treat as unset.
  }
  return "";
}

function writeSavedUrl(url) {
  try {
    fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
    fs.writeFileSync(
      getConfigPath(),
      JSON.stringify({ url }, null, 2),
      "utf8",
    );
    return true;
  } catch (err) {
    console.error("[desktop] failed to persist daemon URL:", err.message);
    return false;
  }
}

function clearSavedUrl() {
  try {
    fs.rmSync(getConfigPath(), { force: true });
  } catch {
    // ignore
  }
}

function pingHealthAt(baseUrl, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL("/health", baseUrl);
    } catch {
      resolve(false);
      return;
    }
    const lib = parsed.protocol === "https:" ? require("node:https") : http;
    const req = lib.get(
      {
        host: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search,
        timeout: timeoutMs,
      },
      (res) => {
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

function pingLocal(timeoutMs = 800) {
  return pingHealthAt(DAEMON_BASE, timeoutMs);
}

async function waitForHealth(maxMs = 30_000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (await pingLocal()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function isBunAvailable() {
  try {
    const result = spawnSync("bun", ["--version"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return result.status === 0;
  } catch {
    return false;
  }
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

function createConnectWindow(reason) {
  connectReason = reason || "";
  const win = new BrowserWindow({
    width: 640,
    height: 560,
    resizable: false,
    title: "agentd · connect",
    backgroundColor: "#0b0b0b",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "connect-preload.cjs"),
    },
  });
  win.loadFile(path.join(__dirname, "connect.html"));
  win.on("closed", () => {
    if (connectWindow === win) connectWindow = null;
  });
  return win;
}

async function openMainWindow(url) {
  if (connectWindow) {
    const cw = connectWindow;
    connectWindow = null;
    cw.close();
  }
  mainWindow = createWindow(url);
}

function showConnect(reason) {
  if (connectWindow) {
    // Update the reason banner if the page has already loaded.
    connectReason = reason || "";
    return connectWindow;
  }
  connectWindow = createConnectWindow(reason);
  return connectWindow;
}

async function bootstrap() {
  // Highest priority: explicit URL override (Vite dev or one-off remote).
  if (ENV_URL) {
    await openMainWindow(ENV_URL);
    return;
  }

  // Operator previously saved a remote URL via the connect page.
  const saved = readSavedUrl();
  if (saved) {
    if (await pingHealthAt(saved)) {
      console.log(`[desktop] attaching to saved daemon at ${saved}`);
      await openMainWindow(saved);
      return;
    }
    console.warn(`[desktop] saved daemon at ${saved} unreachable`);
    showConnect(`Saved daemon at ${saved} is unreachable.`);
    return;
  }

  // Default: try local daemon, spawn if missing.
  const alive = await pingLocal();
  if (alive) {
    console.log(`[desktop] attaching to existing daemon at ${DAEMON_BASE}`);
    await openMainWindow(DAEMON_BASE);
    return;
  }

  if (NO_SPAWN) {
    console.warn(
      `[desktop] no daemon at ${DAEMON_BASE} and AGENTD_DESKTOP_NO_SPAWN=1; loading anyway`,
    );
    await openMainWindow(DAEMON_BASE);
    return;
  }

  if (!isBunAvailable()) {
    showConnect(
      "Bun isn't installed, so a local daemon can't be started. " +
        "Point this app at a daemon on another machine, or install Bun and retry.",
    );
    return;
  }

  daemonProc = spawnDaemon();
  if (daemonProc) {
    const ok = await waitForHealth();
    if (!ok) {
      console.error(
        "[desktop] daemon did not respond on /health within 30s; loading the URL anyway",
      );
    }
  }
  await openMainWindow(DAEMON_BASE);
}

// IPC handlers for the connect window. Only the connect-preload.cjs
// exposes these channels to its renderer, so the main app window can't
// reach them.
ipcMain.handle("agentd-connect:get-context", () => {
  return {
    savedUrl: readSavedUrl() || DAEMON_BASE,
    reason: connectReason,
  };
});

ipcMain.handle("agentd-connect:connect", async (_evt, rawUrl) => {
  const url = String(rawUrl || "").trim().replace(/\/+$/, "");
  if (!url) return { ok: false, error: "Enter a daemon URL." };
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "That doesn't look like a valid URL." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "URL must start with http:// or https://" };
  }
  const reachable = await pingHealthAt(url, 4000);
  if (!reachable) {
    return {
      ok: false,
      error: "Couldn't reach " + url + "/health. Check the daemon is running.",
    };
  }
  writeSavedUrl(url);
  await openMainWindow(url);
  return { ok: true };
});

ipcMain.handle("agentd-connect:retry-local", async () => {
  // Clear any saved URL so the bootstrap flow falls back to local.
  clearSavedUrl();
  const alive = await pingLocal();
  if (alive) {
    await openMainWindow(DAEMON_BASE);
    return { ok: true };
  }
  if (NO_SPAWN) {
    return {
      ok: false,
      error: "AGENTD_DESKTOP_NO_SPAWN is set; can't auto-spawn the daemon.",
    };
  }
  if (!isBunAvailable()) {
    return {
      ok: false,
      error: "Bun still isn't on PATH. Install it from bun.sh and try again.",
    };
  }
  daemonProc = spawnDaemon();
  if (!daemonProc) {
    return { ok: false, error: "Failed to spawn the local daemon." };
  }
  const ok = await waitForHealth();
  if (!ok) {
    return {
      ok: false,
      error: "Local daemon didn't respond on /health within 30s.",
    };
  }
  await openMainWindow(DAEMON_BASE);
  return { ok: true };
});

ipcMain.handle("agentd-connect:open-bun", () => {
  shell.openExternal("https://bun.sh").catch(() => {});
});

ipcMain.handle("agentd-connect:quit", () => {
  app.quit();
});

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
