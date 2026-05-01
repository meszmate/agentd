#!/usr/bin/env node
/* eslint-disable */
/**
 * PTY worker — runs under Node.js because node-pty's child-process setup
 * doesn't currently work under Bun (ioctl on the slave returns EIO, so tmux
 * and other terminal-aware programs exit immediately on attach).
 *
 * The daemon (Bun) launches one of these per WS connection via Bun.spawn,
 * and shuttles bytes between the WS and the worker's stdio.
 *
 * Wire protocol — newline-delimited JSON, one message per line:
 *
 *   parent → worker:
 *     {"type":"input","data":"..."}                    raw bytes for the PTY's stdin
 *     {"type":"resize","cols":N,"rows":N}              SIGWINCH equivalent
 *
 *   worker → parent:
 *     {"type":"ready","pid":N,"cwd":"..."}             after spawn succeeds
 *     {"type":"output","data":"..."}                   PTY produced output
 *     {"type":"exit","code":N|null,"signal":N|null}    PTY exited
 *     {"type":"error","message":"..."}                 failed to spawn / fatal error
 *
 * Args (positional):
 *   mode  : "task" | "term"
 *   spec  : for task → absolute path to the worktree; for term → tmux session name
 *   cwd   : starting directory for the shell
 *   cols  : initial columns
 *   rows  : initial rows
 */

const path = require("path");
const fs = require("fs");

// Resolve node-pty from the daemon's installed deps. We accept either the
// vendored copy under apps/daemon/node_modules or the workspace root.
function loadNodePty() {
  const tryPaths = [
    path.resolve(__dirname, "..", "node_modules", "node-pty"),
    path.resolve(__dirname, "..", "..", "..", "node_modules", "node-pty"),
  ];
  for (const p of tryPaths) {
    try {
      return require(p);
    } catch {}
  }
  // Fallback to bare require — works when worker is run with NODE_PATH set.
  return require("node-pty");
}

function emit(obj) {
  try {
    process.stdout.write(JSON.stringify(obj) + "\n");
  } catch {
    // parent went away
  }
}

function fatal(msg) {
  emit({ type: "error", message: msg });
  process.exit(1);
}

const [, , mode, spec, cwdArg, colsArg, rowsArg] = process.argv;
if (!mode || !spec) fatal("usage: pty-worker.cjs <mode> <spec> [cwd] [cols] [rows]");

const cols = Math.max(2, Math.min(500, Number(colsArg) || 100));
const rows = Math.max(2, Math.min(200, Number(rowsArg) || 30));

let cmd;
let args;
let cwd = cwdArg && cwdArg !== "" ? cwdArg : process.env.HOME || "/";

if (mode === "task") {
  // Spawn the user's shell rooted at the worktree.
  cmd = process.env.SHELL || "/bin/bash";
  args = ["-i"];
  cwd = spec;
} else if (mode === "term") {
  // Attach to (or create) a named tmux session. -A creates if missing.
  cmd = "tmux";
  args = ["new-session", "-A", "-s", spec];
} else {
  fatal(`unknown mode: ${mode}`);
}

// Validate cwd — node-pty will throw on a missing path.
try {
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    cwd = process.env.HOME || "/";
  }
} catch {
  cwd = process.env.HOME || "/";
}

let nodePty;
try {
  nodePty = loadNodePty();
} catch (e) {
  fatal("could not load node-pty: " + (e && e.message ? e.message : String(e)));
}

let proc;
try {
  proc = nodePty.spawn(cmd, args, {
    name: "xterm-256color",
    cwd,
    cols,
    rows,
    env: {
      ...process.env,
      TERM: "xterm-256color",
    },
  });
} catch (e) {
  fatal("spawn failed: " + (e && e.message ? e.message : String(e)));
}

emit({ type: "ready", pid: proc.pid, cwd });

proc.onData((chunk) => {
  emit({ type: "output", data: chunk });
});

proc.onExit(({ exitCode, signal }) => {
  emit({ type: "exit", code: exitCode ?? null, signal: signal ?? null });
  // Give stdout a tick to flush, then bail.
  setTimeout(() => process.exit(0), 20);
});

// Read newline-delimited JSON from the parent and dispatch.
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.type === "input" && typeof msg.data === "string") {
      try { proc.write(msg.data); } catch {}
    } else if (msg.type === "resize") {
      const c = Math.max(2, Math.min(500, Number(msg.cols) | 0));
      const r = Math.max(2, Math.min(200, Number(msg.rows) | 0));
      try { proc.resize(c, r); } catch {}
    } else if (msg.type === "kill") {
      try { proc.kill(msg.signal || "SIGHUP"); } catch {}
    }
  }
});

process.stdin.on("end", () => {
  // Parent closed our stdin → tear down.
  try { proc.kill("SIGHUP"); } catch {}
  setTimeout(() => process.exit(0), 50);
});

process.on("SIGTERM", () => {
  try { proc.kill("SIGHUP"); } catch {}
  process.exit(0);
});
process.on("SIGINT", () => {
  try { proc.kill("SIGHUP"); } catch {}
  process.exit(0);
});
