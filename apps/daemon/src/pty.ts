import type { ServerWebSocket, Subprocess } from "bun";
import type { Task } from "@agentd/contracts";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Browser ↔ daemon PTY bridge.
 *
 * Two modes share the same wire protocol:
 *
 *   - "task"  — spawn `$SHELL -i` rooted at the task's worktree. Used by the
 *               per-task Terminal tab on a task detail page.
 *   - "term"  — attach to a named tmux session (`tmux new-session -A -s NAME`).
 *               The tmux server keeps the session alive across browser
 *               disconnects, so reattaching from another tab / device is
 *               instant. Used by the global Terminal page.
 *
 * The actual PTY allocation runs in a Node.js subprocess (pty-worker.cjs).
 * node-pty's child setup currently misbehaves under Bun — the slave PTY
 * returns EIO on ioctl(TCGETS), which makes tmux and other terminal-aware
 * programs exit immediately. Hosting the PTY in Node fixes that without
 * rewriting the rest of the daemon.
 *
 * Bridge: Bun.spawn the worker, forward WS input → worker stdin (NDJSON),
 * forward worker stdout NDJSON → WS as the existing PtyServerMessage shape.
 */

export type PtyMode = "task" | "term";

export interface PtyAttachData {
  mode: PtyMode;
  // task mode
  taskId?: string;
  task?: Task;
  // term mode
  sessionName?: string;
  proc: Subprocess<"pipe", "pipe", "pipe"> | null;
  cwd?: string;
  /** Newline-delimited JSON buffer for the worker's stdout. */
  stdoutBuf?: string;
}

export type PtyClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

export type PtyServerMessage =
  | { type: "ready"; cwd: string; mode: PtyMode; label: string }
  | { type: "output"; data: string }
  | { type: "exit"; code: number | null };

interface WorkerReady {
  type: "ready";
  pid: number;
  cwd: string;
}
interface WorkerOutput {
  type: "output";
  data: string;
}
interface WorkerExit {
  type: "exit";
  code: number | null;
  signal: number | string | null;
}
interface WorkerError {
  type: "error";
  message: string;
}
type WorkerMessage = WorkerReady | WorkerOutput | WorkerExit | WorkerError;

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = resolve(HERE, "pty-worker.cjs");

function send(ws: ServerWebSocket<PtyAttachData>, msg: PtyServerMessage): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // socket closed
  }
}

function spawnWorkerArgs(data: PtyAttachData): {
  args: string[];
  cwd: string;
  label: string;
} | null {
  if (data.mode === "task") {
    if (!data.task) return null;
    const cwd = data.task.worktreePath;
    return {
      args: ["task", cwd, cwd, "100", "30"],
      cwd,
      label: `task ${data.task.title}`,
    };
  }
  if (data.mode === "term") {
    const name = data.sessionName;
    if (!name) return null;
    const cwd = process.env.HOME || "/";
    return {
      args: ["term", name, cwd, "100", "30"],
      cwd,
      label: `tmux:${name}`,
    };
  }
  return null;
}

export function startPty(ws: ServerWebSocket<PtyAttachData>): void {
  const data = ws.data;
  const config = spawnWorkerArgs(data);
  if (!config) {
    send(ws, { type: "exit", code: -1 });
    try {
      ws.close();
    } catch {
      // already closed
    }
    return;
  }

  const node = process.env.AGENTD_NODE_BIN || "node";
  let proc: Subprocess<"pipe", "pipe", "pipe">;
  try {
    proc = Bun.spawn({
      cmd: [node, WORKER_PATH, ...config.args],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });
  } catch (e) {
    console.error("[pty] failed to spawn worker:", (e as Error).message);
    send(ws, { type: "exit", code: -1 });
    try {
      ws.close();
    } catch {
      // already closed
    }
    return;
  }

  data.proc = proc;
  data.cwd = config.cwd;
  data.stdoutBuf = "";

  // Drain stderr to the daemon's own stderr — useful for diagnosing worker
  // failures without surfacing them to the browser.
  void (async () => {
    try {
      const reader = proc.stderr.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) process.stderr.write("[pty-worker] " + decoder.decode(value));
      }
    } catch {
      // stream closed
    }
  })();

  // Stream stdout → parse NDJSON → forward.
  void (async () => {
    try {
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        data.stdoutBuf = (data.stdoutBuf ?? "") + text;
        let nl;
        while ((nl = data.stdoutBuf.indexOf("\n")) >= 0) {
          const line = data.stdoutBuf.slice(0, nl);
          data.stdoutBuf = data.stdoutBuf.slice(nl + 1);
          if (!line) continue;
          let parsed: WorkerMessage;
          try {
            parsed = JSON.parse(line) as WorkerMessage;
          } catch {
            continue;
          }
          dispatch(ws, parsed, config.label);
        }
      }
    } catch {
      // reader cancelled
    }
  })();

  // When the worker exits unexpectedly, make sure the WS sees an exit.
  void proc.exited.then(() => {
    try {
      ws.close();
    } catch {
      // already closed
    }
  });
}

function dispatch(
  ws: ServerWebSocket<PtyAttachData>,
  msg: WorkerMessage,
  label: string,
): void {
  if (msg.type === "ready") {
    send(ws, {
      type: "ready",
      cwd: msg.cwd,
      mode: ws.data.mode,
      label,
    });
  } else if (msg.type === "output") {
    send(ws, { type: "output", data: msg.data });
  } else if (msg.type === "exit") {
    send(ws, { type: "exit", code: msg.code });
    try {
      ws.close();
    } catch {
      // already closed
    }
  } else if (msg.type === "error") {
    console.error("[pty] worker error:", msg.message);
    send(ws, { type: "exit", code: -1 });
    try {
      ws.close();
    } catch {
      // already closed
    }
  }
}

function writeWorker(
  proc: Subprocess<"pipe", "pipe", "pipe">,
  obj: unknown,
): void {
  try {
    // Bun's WritableStream stdin accepts strings/Buffers via .write
    const stdin = proc.stdin;
    if (!stdin) return;
    const text = JSON.stringify(obj) + "\n";
    if (typeof (stdin as { write?: unknown }).write === "function") {
      (stdin as { write: (s: string) => void }).write(text);
    } else {
      // Fallback for older Bun where stdin is a FileSink.
      const writer = (stdin as unknown as { getWriter: () => WritableStreamDefaultWriter<Uint8Array> }).getWriter();
      void writer.write(new TextEncoder().encode(text));
      writer.releaseLock();
    }
  } catch {
    // broken pipe — worker exited
  }
}

export function handlePtyClientMessage(
  ws: ServerWebSocket<PtyAttachData>,
  raw: string,
): void {
  let parsed: PtyClientMessage;
  try {
    parsed = JSON.parse(raw) as PtyClientMessage;
  } catch {
    return;
  }
  const proc = ws.data.proc;
  if (!proc) return;
  if (parsed.type === "input") {
    writeWorker(proc, { type: "input", data: parsed.data });
  } else if (parsed.type === "resize") {
    const cols = Math.max(2, Math.min(500, parsed.cols | 0));
    const rows = Math.max(2, Math.min(200, parsed.rows | 0));
    writeWorker(proc, { type: "resize", cols, rows });
  }
}

export function closePty(ws: ServerWebSocket<PtyAttachData>): void {
  const proc = ws.data.proc;
  if (!proc) return;
  // For "term" mode this just detaches the browser side — the tmux server
  // keeps the session running, so reconnecting picks back up.
  try {
    writeWorker(proc, { type: "kill", signal: "SIGHUP" });
  } catch {
    // ignore
  }
  try {
    proc.kill("SIGTERM");
  } catch {
    // already gone
  }
  ws.data.proc = null;
}
