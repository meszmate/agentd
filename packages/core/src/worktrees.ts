import { join } from "node:path";
import { existsSync } from "node:fs";

export interface CreateWorktreeOptions {
  repoPath: string;
  worktreeRoot: string;
  taskId: string;
  baseBranch: string;
  branchName: string;
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

export async function createWorktree(
  opts: CreateWorktreeOptions,
): Promise<CreateWorktreeResult> {
  const { repoPath, worktreeRoot, taskId, baseBranch, branchName } = opts;
  if (!(await isGitRepo(repoPath))) {
    throw new Error(`not a git repository: ${repoPath}`);
  }
  const worktreePath = join(worktreeRoot, taskId);
  const branch = branchName;
  const r = await run(
    ["git", "worktree", "add", "-b", branch, worktreePath, baseBranch],
    repoPath,
  );
  if (r.exitCode !== 0) {
    throw new Error(
      `git worktree add failed (exit ${r.exitCode}): ${r.stderr || r.stdout}`,
    );
  }
  return { worktreePath, branch };
}

export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  opts?: { force?: boolean },
): Promise<void> {
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
