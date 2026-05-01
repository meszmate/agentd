/**
 * Thin wrapper around the `tmux` CLI for listing / creating / killing
 * sessions and windows. The actual PTY attach happens elsewhere — these
 * helpers are just for the management API.
 */

export interface TmuxSession {
  name: string;
  windows: number;
  attached: boolean;
  createdAt: number;
  activity: number | null;
}

export interface TmuxWindow {
  /** 0-based index within the session. */
  index: number;
  name: string;
  active: boolean;
  panes: number;
  /** Last activity for this window, ms since epoch. null if tmux didn't report it. */
  activity: number | null;
}

const SESSION_FORMAT =
  "#{session_name}|#{session_windows}|#{?session_attached,1,0}|#{session_created}|#{session_activity}";
const WINDOW_FORMAT =
  "#{window_index}|#{window_name}|#{?window_active,1,0}|#{window_panes}|#{window_activity}";

async function spawn(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn(["tmux", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    return { exitCode: proc.exitCode ?? -1, stdout, stderr };
  } catch (e) {
    // tmux missing entirely
    return { exitCode: -1, stdout: "", stderr: (e as Error).message };
  }
}

export async function listTmuxSessions(): Promise<TmuxSession[]> {
  const { exitCode, stdout } = await spawn(["list-sessions", "-F", SESSION_FORMAT]);
  if (exitCode !== 0) return [];
  if (!stdout.trim()) return [];
  return stdout
    .trim()
    .split("\n")
    .map(parseSessionLine)
    .filter((s): s is TmuxSession => s !== null);
}

function parseSessionLine(line: string): TmuxSession | null {
  const parts = line.split("|");
  if (parts.length < 5) return null;
  const [name, windows, attached, created, activity] = parts;
  if (!name) return null;
  const w = Number(windows);
  const c = Number(created) * 1000;
  const a = Number(activity) * 1000;
  return {
    name,
    windows: Number.isFinite(w) ? w : 1,
    attached: attached === "1",
    createdAt: Number.isFinite(c) ? c : Date.now(),
    activity: Number.isFinite(a) && a > 0 ? a : null,
  };
}

export async function createTmuxSession(
  name: string,
  cwd?: string,
): Promise<TmuxSession | null> {
  // -d: don't attach. -s: name. -c: starting directory.
  const args = ["new-session", "-d", "-s", name];
  if (cwd) args.push("-c", cwd);
  const { exitCode } = await spawn(args);
  if (exitCode !== 0) return null;
  const all = await listTmuxSessions();
  return all.find((s) => s.name === name) ?? null;
}

export async function killTmuxSession(name: string): Promise<boolean> {
  const { exitCode } = await spawn(["kill-session", "-t", name]);
  return exitCode === 0;
}

export async function tmuxSessionExists(name: string): Promise<boolean> {
  const { exitCode } = await spawn(["has-session", "-t", name]);
  return exitCode === 0;
}

export async function renameTmuxSession(
  oldName: string,
  newName: string,
): Promise<boolean> {
  const { exitCode } = await spawn(["rename-session", "-t", oldName, newName]);
  return exitCode === 0;
}

// ── windows ─────────────────────────────────────────────────────────

export async function listTmuxWindows(session: string): Promise<TmuxWindow[]> {
  const { exitCode, stdout } = await spawn([
    "list-windows",
    "-t",
    session,
    "-F",
    WINDOW_FORMAT,
  ]);
  if (exitCode !== 0) return [];
  if (!stdout.trim()) return [];
  return stdout
    .trim()
    .split("\n")
    .map(parseWindowLine)
    .filter((w): w is TmuxWindow => w !== null);
}

function parseWindowLine(line: string): TmuxWindow | null {
  const parts = line.split("|");
  if (parts.length < 5) return null;
  const [index, name, active, panes, activity] = parts;
  const i = Number(index);
  if (!Number.isFinite(i)) return null;
  const p = Number(panes);
  const a = Number(activity) * 1000;
  return {
    index: i,
    name: name ?? "",
    active: active === "1",
    panes: Number.isFinite(p) ? p : 1,
    activity: Number.isFinite(a) && a > 0 ? a : null,
  };
}

export async function newTmuxWindow(
  session: string,
  opts: { name?: string; cwd?: string } = {},
): Promise<TmuxWindow | null> {
  const args = ["new-window", "-t", session];
  if (opts.cwd) args.push("-c", opts.cwd);
  if (opts.name) args.push("-n", opts.name);
  const { exitCode } = await spawn(args);
  if (exitCode !== 0) return null;
  const windows = await listTmuxWindows(session);
  // The newly created window is the active one.
  return windows.find((w) => w.active) ?? null;
}

export async function killTmuxWindow(
  session: string,
  index: number,
): Promise<boolean> {
  const { exitCode } = await spawn([
    "kill-window",
    "-t",
    `${session}:${index}`,
  ]);
  return exitCode === 0;
}

export async function selectTmuxWindow(
  session: string,
  index: number,
): Promise<boolean> {
  const { exitCode } = await spawn([
    "select-window",
    "-t",
    `${session}:${index}`,
  ]);
  return exitCode === 0;
}

export async function renameTmuxWindow(
  session: string,
  index: number,
  newName: string,
): Promise<boolean> {
  const { exitCode } = await spawn([
    "rename-window",
    "-t",
    `${session}:${index}`,
    newName,
  ]);
  return exitCode === 0;
}

/**
 * Send a literal string into a session's active pane. `enter: true` appends
 * a Return so it executes as a command.
 */
export async function sendTmuxKeys(
  session: string,
  text: string,
  opts: { enter?: boolean } = {},
): Promise<boolean> {
  const args = ["send-keys", "-t", session, text];
  if (opts.enter) args.push("Enter");
  const { exitCode } = await spawn(args);
  return exitCode === 0;
}
