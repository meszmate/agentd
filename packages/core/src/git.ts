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

/**
 * Settings that drive the small Claude helper invocations agentd uses for
 * commit messages, PR bodies, and branch-name suggestions. Mirrors the
 * `aiHelpers` config block but stays decoupled so callers can override
 * per-call (e.g. higher effort for PR bodies than commit subjects).
 */
export interface AiHelperOptions {
  binary?: string;
  model?: string;
  effort?: "low" | "medium" | "high" | "max" | "xhigh";
}

/**
 * Build the `claude -p ...` argv from helper settings. Caller appends the
 * actual prompt as the final positional. Honors AGENTD_CLAUDE_BIN as a
 * legacy override for the binary so existing installs keep working.
 */
function buildAiHelperArgv(opts: AiHelperOptions): string[] {
  const binary =
    opts.binary?.trim() || process.env.AGENTD_CLAUDE_BIN || "claude";
  const argv: string[] = [
    binary,
    "--permission-mode",
    "bypassPermissions",
    "--allow-dangerously-skip-permissions",
    "--effort",
    opts.effort ?? "medium",
  ];
  if (opts.model && opts.model.trim()) {
    argv.push("--model", opts.model.trim());
  }
  return argv;
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

// ── AI commit message generation ─────────────────────────────────
//
// Runs `claude -p` against the worktree's current diff and returns a
// conventional-commit subject (and optional body). Used by both the
// manual Ship → Commit dialog and the auto-commit-on-exit hook so the
// committed message reflects the actual change, not the task title.

export interface CommitMessageShape {
  includeBody?: boolean;
  includeScope?: boolean;
  wip?: boolean;
  /** Free-form operator hint — e.g. "focus on the streaming part". */
  hint?: string;
}

export interface CommitMessageResult {
  message: string;
  source: "claude" | "fallback-no-changes" | "fallback-empty-output" | "fallback-claude-error";
  error?: string;
}

const COMMIT_DIFF_LIMIT = 12000;
const COMMIT_FALLBACK = (hint: string) =>
  `chore: ${(hint || "update").slice(0, 60).replace(/\s+/g, " ").trim()}`;

/**
 * Read the diff Claude should describe.
 *
 *   1. Prefer staged + working-tree changes (`git diff --staged` + `git diff`).
 *      That's "what's about to be committed".
 *   2. If that's empty AND we have a baseRef, fall back to `git diff
 *      <base>...HEAD` — i.e. "what does this feature branch contain vs
 *      its starting point". This is the case after auto-commit-on-exit:
 *      the working tree is clean but the branch has the agent's commits.
 *
 * Returns the diff text plus a small marker for the caller's logs.
 */
async function readCombinedDiff(
  cwd: string,
  baseRef?: string,
): Promise<{ diff: string; source: "uncommitted" | "branch" | "empty" }> {
  const [staged, working] = await Promise.all([
    run(["git", "diff", "--staged", "--no-color"], cwd),
    run(["git", "diff", "--no-color"], cwd),
  ]);
  const uncommitted = staged.stdout + (staged.stdout && working.stdout ? "\n" : "") + working.stdout;
  if (uncommitted.trim().length > 0) {
    return { diff: uncommitted.slice(0, COMMIT_DIFF_LIMIT), source: "uncommitted" };
  }
  if (baseRef) {
    // Make sure baseRef resolves; if not we just give up.
    const ok = await run(["git", "rev-parse", "--verify", baseRef], cwd);
    if (ok.exitCode === 0) {
      const branch = await run(
        ["git", "diff", "--no-color", `${baseRef}...HEAD`],
        cwd,
      );
      if (branch.stdout.trim().length > 0) {
        return { diff: branch.stdout.slice(0, COMMIT_DIFF_LIMIT), source: "branch" };
      }
    }
  }
  return { diff: "", source: "empty" };
}

/** Short `git diff --stat` summary used to enrich deterministic fallbacks. */
async function readDiffStat(
  cwd: string,
  baseRef?: string,
): Promise<string> {
  // Prefer the same range we'd describe — uncommitted first, branch second.
  const wt = await run(["git", "diff", "--stat"], cwd);
  if (wt.stdout.trim()) return wt.stdout.trim().split("\n").slice(-1)[0]!;
  if (baseRef) {
    const ok = await run(["git", "rev-parse", "--verify", baseRef], cwd);
    if (ok.exitCode === 0) {
      const r = await run(
        ["git", "diff", "--stat", `${baseRef}...HEAD`],
        cwd,
      );
      if (r.stdout.trim()) return r.stdout.trim().split("\n").slice(-1)[0]!;
    }
  }
  return "";
}

function buildCommitPrompt(diff: string, shape: CommitMessageShape): string {
  const rules = [
    "Output ONLY the commit message. No preamble, no fences, no quotes.",
    shape.wip
      ? "Use prefix `wip` (e.g. `wip: small description`)."
      : "Use a Conventional Commit type: feat, fix, refactor, docs, chore, style, test, perf, ci, build.",
    shape.includeScope
      ? "Optionally include a short scope in parentheses if obvious from the diff: `feat(api): ...`."
      : "Do NOT include a scope.",
    "Subject line must be lowercase, in imperative mood, under 70 characters total.",
    shape.includeBody
      ? "After the subject add a blank line, then 1-3 short bullet points explaining what changed. No test plan, no AI attribution."
      : "Subject line only — no body.",
    shape.hint?.trim() ? `Operator hint: ${shape.hint.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return `Generate a single git commit message for this diff.\n\n${rules}\n\n--- DIFF ---\n${diff}\n--- END DIFF ---`;
}

function cleanCommitOutput(raw: string): string {
  return raw
    .trim()
    .replace(/^```[a-z]*\n?|```$/g, "")
    .replace(/^["']|["']$/g, "")
    .trim();
}

/**
 * Synchronous-ish generator: spawn claude, wait, return the cleaned
 * message. Falls back gracefully when claude is missing or empty.
 *
 * `baseRef` lets the generator describe the whole feature branch when
 * the working tree is clean (the post-auto-commit state). Without it,
 * a clean tree falls back to the deterministic message.
 */
export async function generateCommitMessage(
  cwd: string,
  opts: {
    fallbackHint?: string;
    baseRef?: string;
    helper?: AiHelperOptions;
  } & CommitMessageShape = {},
): Promise<CommitMessageResult> {
  const { diff, source: diffSource } = await readCombinedDiff(cwd, opts.baseRef);
  if (!diff.trim()) {
    const stat = await readDiffStat(cwd, opts.baseRef);
    const hint = stat
      ? `${opts.fallbackHint ?? "update"} (${stat})`
      : opts.fallbackHint ?? "";
    return {
      message: COMMIT_FALLBACK(hint),
      source: "fallback-no-changes",
    };
  }
  const prompt = buildCommitPrompt(diff, opts);
  const argv = buildAiHelperArgv(opts.helper ?? {});
  argv.push("-p", prompt);
  try {
    const proc = Bun.spawn(
      argv,
      {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: process.env as Record<string, string>,
      },
    );
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const cleaned = cleanCommitOutput(out);
    if (!cleaned) {
      const stat = await readDiffStat(cwd, opts.baseRef);
      return {
        message: COMMIT_FALLBACK(
          stat
            ? `${opts.fallbackHint ?? "update"} (${stat})`
            : opts.fallbackHint ?? "",
        ),
        source: "fallback-empty-output",
      };
    }
    void diffSource;
    return { message: cleaned, source: "claude" };
  } catch (e) {
    return {
      message: COMMIT_FALLBACK(opts.fallbackHint ?? ""),
      source: "fallback-claude-error",
      error: (e as Error).message,
    };
  }
}

/**
 * Streaming variant. Yields chunks as Claude prints them. The caller can
 * forward those chunks to a streaming HTTP response so the web shows the
 * commit message being typed live. Resolves with the full cleaned message.
 */
export async function* streamCommitMessage(
  cwd: string,
  opts: {
    fallbackHint?: string;
    baseRef?: string;
    helper?: AiHelperOptions;
  } & CommitMessageShape = {},
): AsyncGenerator<string, CommitMessageResult, void> {
  const { diff } = await readCombinedDiff(cwd, opts.baseRef);
  if (!diff.trim()) {
    const stat = await readDiffStat(cwd, opts.baseRef);
    const fallback = COMMIT_FALLBACK(
      stat
        ? `${opts.fallbackHint ?? "update"} (${stat})`
        : opts.fallbackHint ?? "",
    );
    yield fallback;
    return { message: fallback, source: "fallback-no-changes" };
  }
  const prompt = buildCommitPrompt(diff, opts);
  const argv = buildAiHelperArgv(opts.helper ?? {});
  argv.push("-p", prompt);
  let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    proc = Bun.spawn({
      cmd: argv,
      cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: process.env as Record<string, string>,
    });
  } catch (e) {
    const fallback = COMMIT_FALLBACK(opts.fallbackHint ?? "");
    yield fallback;
    return {
      message: fallback,
      source: "fallback-claude-error",
      error: (e as Error).message,
    };
  }

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      raw += chunk;
      yield chunk;
    }
  } catch {
    // stream cancelled
  }
  await proc.exited;
  const cleaned = cleanCommitOutput(raw);
  if (!cleaned) {
    const fallback = COMMIT_FALLBACK(opts.fallbackHint ?? "");
    return {
      message: fallback,
      source: "fallback-empty-output",
    };
  }
  return { message: cleaned, source: "claude" };
}

/* ── PR title + body generator ─────────────────────────────────────── */

export interface PrMessageShape {
  /** Operator hint that nudges the model toward what's important. */
  hint?: string;
  /** Whether to include "What changed" bullets. Default true. */
  includeBullets?: boolean;
  /** Optional context: the original task prompt, for framing the PR. */
  taskPrompt?: string;
  /** Optional context: the task title, for fallback subject. */
  taskTitle?: string;
}

export interface PrMessageResult {
  /** Subject line, ready to drop into `gh pr create --title`. */
  title: string;
  /** Markdown body, ready for `gh pr create --body`. */
  body: string;
  source: "claude" | "fallback-no-changes" | "fallback-empty-output" | "fallback-claude-error";
  error?: string;
}

function buildPrPrompt(diff: string, shape: PrMessageShape): string {
  const rules = [
    "Output ONLY two parts separated by a blank line: a single subject line, then a Markdown body.",
    "Subject: lowercase, conventional-commit style (`feat: ...`, `fix: ...`), under 70 characters, imperative mood.",
    shape.includeBullets === false
      ? "Body: one short paragraph (no list)."
      : "Body: 2-5 short bullet points starting with `- `, focused on what changed and why. No 'Test plan', no AI attribution, no boilerplate.",
    "No closing summary, no headings, no code fences, no quotes around the subject.",
    shape.taskPrompt?.trim()
      ? `Original task prompt (for context only — describe the diff, not the prompt):\n${shape.taskPrompt.trim()}`
      : "",
    shape.hint?.trim() ? `Operator hint: ${shape.hint.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return `Generate a pull request subject + body for this diff.\n\n${rules}\n\n--- DIFF ---\n${diff}\n--- END DIFF ---`;
}

function splitPrOutput(raw: string): { title: string; body: string } {
  const cleaned = cleanCommitOutput(raw);
  const idx = cleaned.indexOf("\n");
  if (idx < 0) return { title: cleaned, body: "" };
  return {
    title: cleaned.slice(0, idx).trim(),
    body: cleaned.slice(idx + 1).trim(),
  };
}

const PR_FALLBACK_BODY = (taskPrompt?: string): string => {
  if (taskPrompt?.trim()) {
    return `## What changed\n\n${taskPrompt.trim()}\n`;
  }
  return "## What changed\n\n- (auto-fallback — could not reach the AI helper)\n";
};

/** Stream a PR subject + body. Yields chunks for the wire, returns the parsed result. */
export async function* streamPrMessage(
  cwd: string,
  opts: {
    baseRef?: string;
    helper?: AiHelperOptions;
  } & PrMessageShape = {},
): AsyncGenerator<string, PrMessageResult, void> {
  const { diff } = await readCombinedDiff(cwd, opts.baseRef);
  if (!diff.trim()) {
    const fallback = `${opts.taskTitle ? `feat: ${slugifyTitle(opts.taskTitle)}` : "chore: update"}\n\n${PR_FALLBACK_BODY(opts.taskPrompt)}`;
    yield fallback;
    const split = splitPrOutput(fallback);
    return { ...split, source: "fallback-no-changes" };
  }
  const prompt = buildPrPrompt(diff, opts);
  const argv = buildAiHelperArgv(opts.helper ?? {});
  argv.push("-p", prompt);
  let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    proc = Bun.spawn({
      cmd: argv,
      cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: process.env as Record<string, string>,
    });
  } catch (e) {
    const fallback = `${opts.taskTitle ? `feat: ${slugifyTitle(opts.taskTitle)}` : "chore: update"}\n\n${PR_FALLBACK_BODY(opts.taskPrompt)}`;
    yield fallback;
    const split = splitPrOutput(fallback);
    return { ...split, source: "fallback-claude-error", error: (e as Error).message };
  }
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      raw += chunk;
      yield chunk;
    }
  } catch {
    // stream cancelled
  }
  await proc.exited;
  const split = splitPrOutput(raw);
  if (!split.title) {
    return {
      title: opts.taskTitle ? `feat: ${slugifyTitle(opts.taskTitle)}` : "chore: update",
      body: PR_FALLBACK_BODY(opts.taskPrompt),
      source: "fallback-empty-output",
    };
  }
  return { ...split, source: "claude" };
}

function slugifyTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 6)
    .join(" ");
}

/* ── Branch-name generator ─────────────────────────────────────────── */

export interface BranchNameResult {
  /** Generated kebab-case slug, no prefix (e.g. "worktree-option"). */
  slug: string;
  source: "claude" | "fallback";
  error?: string;
}

const STOPWORDS = new Set([
  "a","an","and","are","as","at","be","but","by","can","could","do","does","done",
  "fix","for","from","get","got","has","have","i","if","in","is","it","its","just",
  "like","make","many","me","my","no","not","of","on","one","or","our","out","over",
  "please","s","so","some","that","the","their","then","there","these","they","this",
  "to","up","want","was","we","were","what","when","where","which","who","why","will",
  "with","you","your","really","actually","things","stuff","like",
]);

/** Cheap deterministic fallback: pick the first 3-5 meaningful words. */
function deterministicSlug(prompt: string): string {
  const words = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  const picked = words.slice(0, 5).join("-");
  return picked || "task";
}

/**
 * Ask Claude for a tight feature-branch slug. Returns just the slug — no
 * `feature/` prefix, no leading/trailing punctuation. Falls back to a
 * deterministic slug when Claude is unavailable or empty.
 */
export async function generateBranchName(
  prompt: string,
  opts: { helper?: AiHelperOptions } = {},
): Promise<BranchNameResult> {
  const trimmed = prompt.trim();
  if (!trimmed) return { slug: "task", source: "fallback" };
  const ask =
    `Suggest a short kebab-case feature branch name for this task. ` +
    `Output ONLY the slug (lowercase letters, digits, hyphens). 2-5 words, ` +
    `under 35 characters total. No prefix like "feature/". No quotes, no extra text.\n\n` +
    `Task: ${trimmed.slice(0, 800)}`;
  const argv = buildAiHelperArgv(opts.helper ?? {});
  argv.push("-p", ask);
  try {
    const proc = Bun.spawn({
      cmd: argv,
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
      env: process.env as Record<string, string>,
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const cleaned = out
      .trim()
      .replace(/^```[a-z]*\n?|```$/g, "")
      .replace(/^["'`]|["'`]$/g, "")
      .trim()
      .toLowerCase()
      .replace(/^feature\//, "")
      .replace(/^[a-z]+\//, "")
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
    if (!cleaned) return { slug: deterministicSlug(trimmed), source: "fallback" };
    return { slug: cleaned, source: "claude" };
  } catch (e) {
    return {
      slug: deterministicSlug(trimmed),
      source: "fallback",
      error: (e as Error).message,
    };
  }
}

/**
 * Best-effort PR state lookup via the `gh` CLI. Returns the merge state
 * if the URL parses to an owner/repo + number; null otherwise (no gh,
 * not authed, not a github URL, etc.). Used to auto-close tasks once
 * their PR merges.
 */
export async function getPrState(
  prUrl: string,
): Promise<{ state: string; merged: boolean; mergedAt: string | null } | null> {
  const m = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(prUrl);
  if (!m) return null;
  const [, owner, repo, num] = m;
  const r = await run(
    [
      "gh",
      "pr",
      "view",
      num!,
      "-R",
      `${owner}/${repo}`,
      "--json",
      "state,mergedAt",
    ],
    process.cwd(),
  );
  if (r.exitCode !== 0) return null;
  try {
    const j = JSON.parse(r.stdout) as { state?: string; mergedAt?: string };
    return {
      state: j.state ?? "UNKNOWN",
      merged: j.state === "MERGED",
      mergedAt: j.mergedAt ?? null,
    };
  } catch {
    return null;
  }
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
