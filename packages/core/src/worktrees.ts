import { join } from "node:path";
import { existsSync } from "node:fs";

export interface CreateWorktreeOptions {
  repoPath: string;
  worktreeRoot: string;
  taskId: string;
  baseBranch: string;
  branchName: string;
  /**
   * `worktree` (default) — git worktree add, isolated from the operator's checkout.
   * `in_place`           — work directly inside `repoPath`. The branch handling
   *                        below still applies but no extra worktree is created.
   */
  workspaceMode?: "worktree" | "in_place";
  /**
   * `new` (default) — create `branchName` off `baseBranch`.
   * `existing`      — switch onto `branchName` (must already exist locally
   *                   or as a remote tracking branch).
   */
  branchMode?: "new" | "existing";
  /** Run `git fetch && git pull --ff-only` on the base before creating. */
  pullLatest?: boolean;
  /** Optional remote name for fetch/pull (default `origin`). */
  remote?: string;
}

export interface CreateWorktreeResult {
  worktreePath: string;
  branch: string;
}

async function run(
  cmd: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn({
    cmd,
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

export async function isGitRepo(path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  const r = await run(["git", "rev-parse", "--is-inside-work-tree"], path);
  return r.exitCode === 0 && r.stdout.trim() === "true";
}

export async function detectDefaultBranch(repoPath: string): Promise<string> {
  const r = await run(
    ["git", "symbolic-ref", "--short", "HEAD"],
    repoPath,
  );
  if (r.exitCode === 0) return r.stdout.trim();
  return "main";
}

export async function listBranches(
  repoPath: string,
): Promise<{
  current: string | null;
  local: string[];
  remote: { ref: string; remote: string }[];
}> {
  const localR = await run(
    ["git", "for-each-ref", "--format=%(refname:short)", "refs/heads/"],
    repoPath,
  );
  const remoteR = await run(
    ["git", "for-each-ref", "--format=%(refname:short)", "refs/remotes/"],
    repoPath,
  );
  const head = await run(["git", "symbolic-ref", "--short", "-q", "HEAD"], repoPath);
  const local =
    localR.exitCode === 0
      ? localR.stdout.split("\n").map((s) => s.trim()).filter(Boolean)
      : [];
  const remote =
    remoteR.exitCode === 0
      ? remoteR.stdout
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean)
          .filter((r) => !r.endsWith("/HEAD"))
          .map((r) => {
            const slash = r.indexOf("/");
            return slash > 0
              ? { remote: r.slice(0, slash), ref: r.slice(slash + 1) }
              : { remote: "", ref: r };
          })
      : [];
  return {
    current: head.exitCode === 0 ? head.stdout.trim() : null,
    local,
    remote,
  };
}

/**
 * Best-effort pull on a branch. We do `git fetch <remote>` first so the
 * remote tracking branch is fresh, then either `git pull --ff-only` if we're
 * on the branch in `repoPath`, or `git fetch <remote> <branch>:<branch>` to
 * fast-forward a local branch we're not currently on. Failures are surfaced
 * so the caller can decide whether to abort.
 */
export async function pullLatestBranch(
  repoPath: string,
  branch: string,
  remote = "origin",
): Promise<void> {
  // Skip silently if the repo has no remotes configured at all.
  const rs = await run(["git", "remote"], repoPath);
  if (rs.exitCode !== 0 || !rs.stdout.trim()) return;
  const fetch = await run(["git", "fetch", remote, branch], repoPath);
  if (fetch.exitCode !== 0) {
    throw new Error(`git fetch failed: ${fetch.stderr || fetch.stdout}`);
  }
  const head = await run(["git", "symbolic-ref", "--short", "-q", "HEAD"], repoPath);
  const onBranch = head.exitCode === 0 && head.stdout.trim() === branch;
  if (onBranch) {
    const pull = await run(["git", "pull", "--ff-only", remote, branch], repoPath);
    if (pull.exitCode !== 0) {
      throw new Error(`git pull --ff-only failed: ${pull.stderr || pull.stdout}`);
    }
  } else {
    // Fast-forward the local ref without checking it out.
    const ff = await run(
      ["git", "fetch", remote, `${branch}:${branch}`],
      repoPath,
    );
    if (ff.exitCode !== 0) {
      // Non-fatal — it's typical for ${branch} not to exist locally yet.
      // We've already fetched the remote tracking branch above, so worktree
      // add against `${remote}/${branch}` would still pick up the latest.
    }
  }
}

async function localBranchExists(
  repoPath: string,
  branch: string,
): Promise<boolean> {
  const r = await run(
    ["git", "show-ref", "--verify", `refs/heads/${branch}`],
    repoPath,
  );
  return r.exitCode === 0;
}

async function hasUncommittedChanges(repoPath: string): Promise<boolean> {
  const r = await run(["git", "status", "--porcelain"], repoPath);
  if (r.exitCode !== 0) return false;
  return r.stdout.trim().length > 0;
}

export async function createWorktree(
  opts: CreateWorktreeOptions,
): Promise<CreateWorktreeResult> {
  const {
    repoPath,
    worktreeRoot,
    taskId,
    baseBranch,
    branchName,
    workspaceMode = "worktree",
    branchMode = "new",
    pullLatest = false,
    remote = "origin",
  } = opts;
  if (!(await isGitRepo(repoPath))) {
    throw new Error(`not a git repository: ${repoPath}`);
  }

  // Pull-latest happens BEFORE branch creation so the new branch starts
  // from the freshest base. For in-place we pull the existing branch we'll
  // use; for worktree we pull the base.
  if (pullLatest) {
    const target = branchMode === "existing" ? branchName : baseBranch;
    try {
      await pullLatestBranch(repoPath, target, remote);
    } catch (e) {
      throw new Error(`pull latest failed: ${(e as Error).message}`);
    }
  }

  if (workspaceMode === "in_place") {
    if (await hasUncommittedChanges(repoPath)) {
      throw new Error(
        "in-place mode refuses to start with uncommitted changes — commit, stash, or use worktree mode",
      );
    }
    if (branchMode === "existing") {
      const exists = await localBranchExists(repoPath, branchName);
      const args = exists
        ? ["git", "checkout", branchName]
        : ["git", "checkout", "-B", branchName, `${remote}/${branchName}`];
      const r = await run(args, repoPath);
      if (r.exitCode !== 0) {
        throw new Error(
          `git checkout ${branchName} failed: ${r.stderr || r.stdout}`,
        );
      }
    } else {
      // new branch from baseBranch
      const r = await run(
        ["git", "checkout", "-b", branchName, baseBranch],
        repoPath,
      );
      if (r.exitCode !== 0) {
        throw new Error(
          `git checkout -b ${branchName} failed: ${r.stderr || r.stdout}`,
        );
      }
    }
    return { worktreePath: repoPath, branch: branchName };
  }

  // ── worktree mode ──
  const worktreePath = join(worktreeRoot, taskId);
  if (branchMode === "existing") {
    // git worktree add accepts either the branch name (will check out) or
    // -B for a force-create. For an existing branch, plain add is right.
    const args = ["git", "worktree", "add", worktreePath, branchName];
    const r = await run(args, repoPath);
    if (r.exitCode !== 0) {
      throw new Error(
        `git worktree add (existing branch) failed: ${r.stderr || r.stdout}`,
      );
    }
    return { worktreePath, branch: branchName };
  }
  const r = await run(
    ["git", "worktree", "add", "-b", branchName, worktreePath, baseBranch],
    repoPath,
  );
  if (r.exitCode !== 0) {
    throw new Error(
      `git worktree add failed (exit ${r.exitCode}): ${r.stderr || r.stdout}`,
    );
  }
  return { worktreePath, branch: branchName };
}

export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  opts?: { force?: boolean },
): Promise<void> {
  // Refuse to "remove" the project's main checkout. In-place tasks set
  // worktreePath = repoPath; cleanup for those is a no-op.
  if (worktreePath === repoPath) return;
  const args = ["git", "worktree", "remove", worktreePath];
  if (opts?.force) args.push("--force");
  const r = await run(args, repoPath);
  if (r.exitCode !== 0) {
    throw new Error(
      `git worktree remove failed (exit ${r.exitCode}): ${r.stderr || r.stdout}`,
    );
  }
}

export function slugify(input: string, max = 40): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max);
  return slug || "task";
}
