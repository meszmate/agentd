import type { ServerWebSocket } from "bun";
import type { Task } from "@agentd/contracts";

/**
 * Tracks shell subprocesses keyed by WS instance. Each WS connection owns one
 * shell rooted at the task's worktree. Without `node-pty` we get a non-tty
 * shell — this means full TUIs (vim, htop) won't render correctly, but
 * line-oriented commands (`ls`, `git`, `npm`, `cargo`) work fine, which is
 * 95% of the "I want to poke around in the worktree" use case.
 *
 * If we ever need a real PTY, swap to `node-pty` and reuse the same WS
 * framing — the on-the-wire protocol is intentionally stable.
 */

export interface PtyAttachData {
  taskId: string;
  task: Task;
  proc: Bun.Subprocess<"pipe", "pipe", "pipe"> | null;
}

export type PtyClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

export type PtyServerMessage =
  | { type: "ready"; cwd: string }
  | { type: "output"; data: string }
  | { type: "exit"; code: number | null };

function send(ws: ServerWebSocket<PtyAttachData>, msg: PtyServerMessage): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // socket closed
  }
}

export function startPty(ws: ServerWebSocket<PtyAttachData>): void {
  const cwd = ws.data.task.worktreePath;
  const shell = process.env.SHELL || "/bin/bash";
  const proc = Bun.spawn({
    cmd: [shell, "-i"],
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...(process.env as Record<string, string>),
      // Hint to programs that this isn't a real terminal so they tone down
      // ANSI noise that would garble the WS text frames.
      TERM: "dumb",
      PS1: "$ ",
    },
  });
  ws.data.proc = proc;
  send(ws, { type: "ready", cwd });

  void pipe(proc.stdout, (chunk) => send(ws, { type: "output", data: chunk }));
  void pipe(proc.stderr, (chunk) => send(ws, { type: "output", data: chunk }));
  void (async () => {
    const code = await proc.exited;
    send(ws, { type: "exit", code: code ?? null });
    try {
      ws.close();
    } catch {
      // already closed
    }
  })();
}

async function pipe(
  stream: ReadableStream<Uint8Array>,
  onChunk: (s: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (text.length > 0) onChunk(text);
    }
  } catch {
    // stream errored
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
  if (parsed.type === "input") {
    const proc = ws.data.proc;
    if (!proc) return;
    try {
      proc.stdin?.write(parsed.data);
    } catch {
      // shell exited mid-write
    }
  }
  // resize is a no-op without a real PTY; future node-pty integration
  // will hook this up.
}

export function closePty(ws: ServerWebSocket<PtyAttachData>): void {
  const proc = ws.data.proc;
  if (!proc) return;
  try {
    proc.kill("SIGHUP");
  } catch {
    // already gone
  }
  ws.data.proc = null;
}
