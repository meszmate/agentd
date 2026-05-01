async function run(
  cmd: string[],
  cwd: string,
  opts?: { input?: string },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn({
    cmd,
    cwd,
    stdin: opts?.input ? "pipe" : "inherit",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (opts?.input) {
    proc.stdin?.write(opts.input);
    proc.stdin?.end();
  }
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

export async function hasChanges(cwd: string): Promise<boolean> {
  const r = await run(["git", "status", "--porcelain"], cwd);
  if (r.exitCode !== 0) return false;
  return r.stdout.trim().length > 0;
}

export interface AutoCommitInput {
  cwd: string;
  title: string;
  body?: string;
  authorName?: string;
  authorEmail?: string;
}

export interface AutoCommitResult {
  committed: boolean;
  sha?: string;
  message?: string;
}

export async function autoCommit(input: AutoCommitInput): Promise<AutoCommitResult> {
  if (!(await hasChanges(input.cwd))) return { committed: false };
  const add = await run(["git", "add", "-A"], input.cwd);
  if (add.exitCode !== 0) {
    throw new Error(`git add failed: ${add.stderr || add.stdout}`);
  }
  const author = `${input.authorName ?? "agentd"} <${input.authorEmail ?? "agentd@local"}>`;
  const args = [
    "git",
    "-c",
    `user.name=${input.authorName ?? "agentd"}`,
    "-c",
    `user.email=${input.authorEmail ?? "agentd@local"}`,
    "commit",
    "--author",
    author,
    "--no-verify",
    "-m",
    input.title,
  ];
  if (input.body && input.body.trim().length > 0) {
    args.push("-m", input.body);
  }
  const commit = await run(args, input.cwd);
  if (commit.exitCode !== 0) {
    throw new Error(`git commit failed: ${commit.stderr || commit.stdout}`);
  }
  const sha = await run(["git", "rev-parse", "HEAD"], input.cwd);
  return {
    committed: true,
    sha: sha.stdout.trim(),
    message: input.title,
  };
}

export interface DiffResult {
  diff: string;
  stat: string;
  baseRef: string;
  headRef: string;
}

export async function diffAgainst(
  cwd: string,
  baseRef: string,
): Promise<DiffResult> {
  const stat = await run(["git", "diff", "--stat", `${baseRef}...HEAD`], cwd);
  const diff = await run(["git", "diff", `${baseRef}...HEAD`], cwd);
  // Also include uncommitted changes against HEAD
  const wt = await run(["git", "diff", "HEAD"], cwd);
  return {
    diff: diff.stdout + (wt.stdout.length > 0 ? "\n" + wt.stdout : ""),
    stat: stat.stdout,
    baseRef,
    headRef: "HEAD",
  };
}

export async function listFiles(cwd: string): Promise<string[]> {
  const r = await run(
    ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
    cwd,
  );
  if (r.exitCode !== 0) return [];
  return r.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .sort();
}

export type GitFileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "untracked"
  | "ignored";

export interface GitStatusEntry {
  path: string;
  status: GitFileStatus;
  /** Lines added relative to the index. 0 if not computable. */
  additions: number;
  /** Lines removed relative to the index. 0 if not computable. */
  deletions: number;
  /** True if any change (worktree or staged). */
  changed: boolean;
}

/**
 * Worktree status with per-file line counts. Used by the task workspace's
 * file tree to give it a "git" feel — A/M/D/U badges + +N/−M counts.
 *
 * `baseRef` is the comparison point. For agentd worktrees the agent's
 * changes are auto-committed onto a task branch, so comparing against
 * HEAD shows nothing — we want the diff against the task's `baseBranch`
 * (typically `main`). Falls back to HEAD if the base doesn't resolve.
 *
 * Combines:
 *   - `git diff --name-status <base>...HEAD` (committed changes vs base)
 *   - `git status --porcelain` (uncommitted worktree state)
 *   - `git diff --numstat <base>` (line counts; "..." merge-base form
 *     to ignore base's own progress)
 */
export async function gitStatus(
  cwd: string,
  baseRef = "HEAD",
): Promise<GitStatusEntry[]> {
  // Resolve baseRef to make sure it exists in this worktree. If it
  // doesn't (fresh project, no upstream), silently fall back to HEAD.
  let base = baseRef;
  if (base !== "HEAD") {
    const ok = await run(["git", "rev-parse", "--verify", base], cwd);
    if (ok.exitCode !== 0) base = "HEAD";
  }

  // Use three-dot to compare against the merge-base — committed work on
  // the task branch shows as the diff regardless of how `base` advances.
  const range = base === "HEAD" ? "HEAD" : `${base}...HEAD`;

  // numstat across the committed range PLUS the uncommitted worktree.
  // For the worktree side we run a separate `git diff --numstat` (no
  // ref) and merge results.
  const [committed, working, status, untracked] = await Promise.all([
    base === "HEAD"
      ? Promise.resolve({ stdout: "", stderr: "", exitCode: 0 })
      : run(["git", "diff", "--numstat", range], cwd),
    run(["git", "diff", "--numstat"], cwd),
    run(
      ["git", "status", "--porcelain=v1", "--untracked-files=all"],
      cwd,
    ),
    run(["git", "ls-files", "--others", "--exclude-standard"], cwd),
  ]);

  const counts = new Map<string, { add: number; del: number }>();
  const addCounts = (raw: string): void => {
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split("\t");
      if (parts.length < 3) continue;
      const add = parts[0] === "-" ? 0 : Number(parts[0] ?? 0);
      const del = parts[1] === "-" ? 0 : Number(parts[1] ?? 0);
      const path = parts.slice(2).join("\t");
      const cur = counts.get(path) ?? { add: 0, del: 0 };
      counts.set(path, {
        add: cur.add + (Number.isFinite(add) ? add : 0),
        del: cur.del + (Number.isFinite(del) ? del : 0),
      });
    }
  };
  addCounts(committed.stdout);
  addCounts(working.stdout);

  const entries: GitStatusEntry[] = [];
  const seen = new Set<string>();

  // Files that differ vs base (committed). Use --name-status to learn
  // the kind of change. Then we'll layer the porcelain (uncommitted)
  // on top so a file that's already-committed-but-modified still shows
  // as modified, not double-counted.
  if (base !== "HEAD") {
    const ns = await run(["git", "diff", "--name-status", range], cwd);
    for (const line of ns.stdout.split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split("\t");
      const code = parts[0] ?? "";
      const last = parts[parts.length - 1] ?? "";
      if (!last) continue;
      let kind: GitFileStatus = "modified";
      if (code.startsWith("A")) kind = "added";
      else if (code.startsWith("D")) kind = "deleted";
      else if (code.startsWith("R")) kind = "renamed";
      else if (code.startsWith("M")) kind = "modified";
      const c = counts.get(last);
      seen.add(last);
      entries.push({
        path: last,
        status: kind,
        additions: c?.add ?? 0,
        deletions: c?.del ?? 0,
        changed: true,
      });
    }
  }

  // Layer uncommitted worktree changes — porcelain output. Bumps the
  // count if we already saw the file via the committed range.
  for (const line of status.stdout.split("\n")) {
    if (!line) continue;
    const xy = line.slice(0, 2);
    const rest = line.slice(3);
    if (!rest) continue;
    let kind: GitFileStatus;
    if (xy === "??") kind = "untracked";
    else if (xy === "!!") kind = "ignored";
    else if (xy.includes("A")) kind = "added";
    else if (xy.includes("D")) kind = "deleted";
    else if (xy.includes("R")) kind = "renamed";
    else kind = "modified";
    const display =
      kind === "renamed" && rest.includes(" -> ")
        ? rest.split(" -> ").pop()!
        : rest;
    if (seen.has(display)) continue;
    const c = counts.get(display);
    seen.add(display);
    entries.push({
      path: display,
      status: kind,
      additions: c?.add ?? 0,
      deletions: c?.del ?? 0,
      changed: true,
    });
  }

  // Brand-new files that haven't been committed yet — count their lines.
  for (const line of untracked.stdout.split("\n")) {
    const path = line.trim();
    if (!path || seen.has(path)) continue;
    let additions = 0;
    try {
      const f = await run(["wc", "-l", path], cwd);
      additions = Number(f.stdout.trim().split(/\s+/)[0] ?? 0);
    } catch {
      // ignore
    }
    seen.add(path);
    entries.push({
      path,
      status: "untracked",
      additions,
      deletions: 0,
      changed: true,
    });
  }

  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

export async function listLog(
  cwd: string,
  limit = 50,
): Promise<Array<{ sha: string; subject: string; ts: number; author: string }>> {
  const fmt = "%H%x09%ct%x09%an%x09%s";
  const r = await run(
    ["git", "log", `--max-count=${limit}`, `--pretty=format:${fmt}`],
    cwd,
  );
  if (r.exitCode !== 0) return [];
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, ts, author, ...rest] = line.split("\t");
      return {
        sha: sha ?? "",
        ts: Number(ts) * 1000,
        author: author ?? "",
        subject: rest.join("\t"),
      };
    });
}

export async function revertCommit(cwd: string, sha: string): Promise<void> {
  const r = await run(
    ["git", "revert", "--no-edit", "--no-gpg-sign", sha],
    cwd,
  );
  if (r.exitCode !== 0) {
    throw new Error(`git revert failed: ${r.stderr || r.stdout}`);
  }
}

export interface PushResult {
  pushed: boolean;
  remote: string;
  branch: string;
  output: string;
}

export async function pushBranch(
  cwd: string,
  remote = "origin",
): Promise<PushResult> {
  const branchOut = await run(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd);
  const branch = branchOut.stdout.trim();
  if (!branch || branch === "HEAD") {
    throw new Error("not on a named branch; cannot push");
  }
  const r = await run(["git", "push", "-u", remote, branch], cwd);
  if (r.exitCode !== 0) {
    throw new Error(`git push failed: ${r.stderr || r.stdout}`);
  }
  return {
    pushed: true,
    remote,
    branch,
    output: r.stdout + r.stderr,
  };
}

export interface CreatePrInput {
  cwd: string;
  title: string;
  body: string;
  baseBranch: string;
  draft?: boolean;
}

export interface CreatePrResult {
  url: string;
  output: string;
}

/**
 * Uses the gh CLI to open a PR for the current branch. Requires `gh auth status`
 * to be set up on the host. Returns the PR URL parsed from gh's stdout.
 */
export async function createPr(input: CreatePrInput): Promise<CreatePrResult> {
  const args = [
    "gh",
    "pr",
    "create",
    "--base",
    input.baseBranch,
    "--title",
    input.title,
    "--body",
    input.body || "Opened automatically by agentd.",
  ];
  if (input.draft) args.push("--draft");
  const r = await run(args, input.cwd);
  if (r.exitCode !== 0) {
    throw new Error(`gh pr create failed: ${r.stderr || r.stdout}`);
  }
  // gh prints the URL on stdout when creation succeeds
  const url = (r.stdout.match(/https?:\/\/\S+/) || [""])[0];
  return { url, output: r.stdout + r.stderr };
}
