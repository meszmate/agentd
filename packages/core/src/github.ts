import type {
  GithubIssue,
  GithubPr,
  GithubStatus,
} from "@agentd/contracts";

/**
 * Thin shell-out wrapper around the operator's `gh` CLI. We deliberately
 * don't use Octokit / a PAT — `gh` already handles auth, multiple hosts,
 * and SSO; reusing it means the operator never has to wire up a token.
 *
 * Every helper takes a `cwd` (the project's repo path) so `gh` picks up
 * the right remote from the local git config. Errors come back as typed
 * `{ ok: false, error }` shapes — callers decide whether to surface or
 * swallow.
 */

async function run(
  cmd: string[],
  cwd: string,
  opts?: { input?: string },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn({
    cmd,
    cwd,
    stdin: opts?.input ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
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

export interface GhResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

/**
 * Probe `gh --version` + `gh auth status`. The web's GitHub tab gates
 * on this — when `ok` is false the tab shows a setup card explaining
 * what's missing.
 *
 * Runs from `process.cwd()` since we're not asking about a specific
 * repo's remote. Auth is global to the operator.
 */
export async function ghStatus(): Promise<GithubStatus> {
  // Step 1: is gh installed?
  const ver = await run(["gh", "--version"], process.cwd()).catch(() => ({
    stdout: "",
    stderr: "gh not found",
    exitCode: 127,
  }));
  if (ver.exitCode !== 0) {
    return {
      ok: false,
      ghInstalled: false,
      authed: false,
      reason: "gh CLI not installed",
    };
  }
  // Step 2: is the operator authed?
  const auth = await run(["gh", "auth", "status"], process.cwd());
  if (auth.exitCode !== 0) {
    return {
      ok: false,
      ghInstalled: true,
      authed: false,
      reason: "not signed in to gh — run `gh auth login`",
    };
  }
  // Best-effort user pull. `gh api user --jq .login` is the cheapest call.
  const who = await run(["gh", "api", "user", "--jq", ".login"], process.cwd());
  const user = who.exitCode === 0 ? who.stdout.trim() : null;
  return {
    ok: true,
    ghInstalled: true,
    authed: true,
    user: user || null,
  };
}

/**
 * Resolve `owner/repo` for `cwd` via `gh repo view --json nameWithOwner`.
 * Returns null when the repo has no GitHub remote (or `gh` can't pick
 * one). Cached on `Project.githubRepo` after the first hit.
 */
export async function ghRepo(cwd: string): Promise<string | null> {
  const r = await run(
    ["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
    cwd,
  );
  if (r.exitCode !== 0) return null;
  const out = r.stdout.trim();
  return out.length > 0 ? out : null;
}

const ISSUE_FIELDS =
  "number,title,state,url,body,author,labels,createdAt,updatedAt";
const PR_FIELDS =
  "number,title,state,url,body,author,labels,isDraft,baseRefName,headRefName,mergeable,createdAt,updatedAt";

interface GhListItem {
  number?: number;
  title?: string;
  state?: string;
  url?: string;
  body?: string | null;
  author?: { login?: string } | null;
  labels?: Array<{ name?: string; color?: string | null }> | null;
  isDraft?: boolean;
  baseRefName?: string;
  headRefName?: string;
  mergeable?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

function normalizeIssue(raw: GhListItem): GithubIssue | null {
  if (typeof raw.number !== "number") return null;
  return {
    number: raw.number,
    title: raw.title ?? "",
    state: raw.state ?? "OPEN",
    url: raw.url ?? "",
    body: raw.body ?? null,
    author: raw.author?.login ? { login: raw.author.login } : null,
    labels: (raw.labels ?? [])
      .filter((l): l is { name: string; color?: string | null } =>
        typeof l?.name === "string",
      )
      .map((l) => ({ name: l.name, color: l.color ?? null })),
    createdAt: raw.createdAt ?? "",
    updatedAt: raw.updatedAt ?? "",
  };
}

function normalizePr(raw: GhListItem): GithubPr | null {
  if (typeof raw.number !== "number") return null;
  return {
    number: raw.number,
    title: raw.title ?? "",
    state: raw.state ?? "OPEN",
    url: raw.url ?? "",
    body: raw.body ?? null,
    author: raw.author?.login ? { login: raw.author.login } : null,
    labels: (raw.labels ?? [])
      .filter((l): l is { name: string; color?: string | null } =>
        typeof l?.name === "string",
      )
      .map((l) => ({ name: l.name, color: l.color ?? null })),
    isDraft: raw.isDraft === true,
    baseRefName: raw.baseRefName ?? "",
    headRefName: raw.headRefName ?? "",
    mergeable: raw.mergeable ?? null,
    createdAt: raw.createdAt ?? "",
    updatedAt: raw.updatedAt ?? "",
  };
}

/**
 * `gh issue list --json …`. Caps at 50 results — pagination is a v2
 * feature, the tab's a triage list not an archive viewer.
 */
export async function listIssues(cwd: string): Promise<GhResult<GithubIssue[]>> {
  const r = await run(
    [
      "gh",
      "issue",
      "list",
      "--state",
      "open",
      "--limit",
      "50",
      "--json",
      ISSUE_FIELDS,
    ],
    cwd,
  );
  if (r.exitCode !== 0) {
    return { ok: false, error: r.stderr.trim() || `gh exit ${r.exitCode}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (e) {
    return { ok: false, error: `gh issue list returned non-JSON: ${(e as Error).message}` };
  }
  if (!Array.isArray(parsed)) return { ok: true, data: [] };
  const out: GithubIssue[] = [];
  for (const row of parsed) {
    const norm = normalizeIssue(row as GhListItem);
    if (norm) out.push(norm);
  }
  return { ok: true, data: out };
}

/** `gh pr list --json …` — same 50-row cap as `listIssues`. */
export async function listPrs(cwd: string): Promise<GhResult<GithubPr[]>> {
  const r = await run(
    [
      "gh",
      "pr",
      "list",
      "--state",
      "open",
      "--limit",
      "50",
      "--json",
      PR_FIELDS,
    ],
    cwd,
  );
  if (r.exitCode !== 0) {
    return { ok: false, error: r.stderr.trim() || `gh exit ${r.exitCode}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (e) {
    return { ok: false, error: `gh pr list returned non-JSON: ${(e as Error).message}` };
  }
  if (!Array.isArray(parsed)) return { ok: true, data: [] };
  const out: GithubPr[] = [];
  for (const row of parsed) {
    const norm = normalizePr(row as GhListItem);
    if (norm) out.push(norm);
  }
  return { ok: true, data: out };
}

/** Single-PR fetch with full body + branch refs. Used by the spawn flow. */
export async function viewPr(
  cwd: string,
  number: number,
): Promise<GhResult<GithubPr>> {
  const r = await run(
    [
      "gh",
      "pr",
      "view",
      String(number),
      "--json",
      PR_FIELDS,
    ],
    cwd,
  );
  if (r.exitCode !== 0) {
    return { ok: false, error: r.stderr.trim() || `gh exit ${r.exitCode}` };
  }
  try {
    const obj = JSON.parse(r.stdout) as GhListItem;
    const norm = normalizePr(obj);
    if (!norm) return { ok: false, error: "gh pr view returned an unrecognized shape" };
    return { ok: true, data: norm };
  } catch (e) {
    return { ok: false, error: `gh pr view returned non-JSON: ${(e as Error).message}` };
  }
}

/** Single-issue fetch — same pattern as `viewPr`. */
export async function viewIssue(
  cwd: string,
  number: number,
): Promise<GhResult<GithubIssue>> {
  const r = await run(
    ["gh", "issue", "view", String(number), "--json", ISSUE_FIELDS],
    cwd,
  );
  if (r.exitCode !== 0) {
    return { ok: false, error: r.stderr.trim() || `gh exit ${r.exitCode}` };
  }
  try {
    const obj = JSON.parse(r.stdout) as GhListItem;
    const norm = normalizeIssue(obj);
    if (!norm) return { ok: false, error: "gh issue view returned an unrecognized shape" };
    return { ok: true, data: norm };
  } catch (e) {
    return { ok: false, error: `gh issue view returned non-JSON: ${(e as Error).message}` };
  }
}

/**
 * Run `gh pr checkout <n>` inside an existing worktree. Used as a
 * pre-spawn step for PR tasks so the agent lands directly on the
 * PR's branch instead of a fresh agentd-named branch.
 */
export async function checkoutPrInWorktree(
  worktreePath: string,
  number: number,
): Promise<GhResult<void>> {
  const r = await run(
    ["gh", "pr", "checkout", String(number)],
    worktreePath,
  );
  if (r.exitCode !== 0) {
    return {
      ok: false,
      error: r.stderr.trim() || r.stdout.trim() || `gh exit ${r.exitCode}`,
    };
  }
  return { ok: true };
}

/** `gh pr comment <n> --body <body>`. Used by the task PR action bar. */
export async function prComment(
  cwd: string,
  number: number,
  body: string,
): Promise<GhResult<void>> {
  if (!body.trim()) return { ok: false, error: "comment body is required" };
  const r = await run(
    ["gh", "pr", "comment", String(number), "--body-file", "-"],
    cwd,
    { input: body },
  );
  if (r.exitCode !== 0) {
    return { ok: false, error: r.stderr.trim() || `gh exit ${r.exitCode}` };
  }
  return { ok: true };
}

export type PrReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

/**
 * `gh pr review <n>` with `--approve` / `--request-changes` / `--comment`.
 * Body is required for `REQUEST_CHANGES` and `COMMENT`; optional for
 * approvals.
 */
export async function prReview(
  cwd: string,
  number: number,
  event: PrReviewEvent,
  body?: string,
): Promise<GhResult<void>> {
  const flag =
    event === "APPROVE"
      ? "--approve"
      : event === "REQUEST_CHANGES"
        ? "--request-changes"
        : "--comment";
  if (event !== "APPROVE" && !body?.trim()) {
    return { ok: false, error: `${event} review requires a body` };
  }
  const args = ["gh", "pr", "review", String(number), flag];
  if (body?.trim()) {
    args.push("--body-file", "-");
  }
  const r = await run(args, cwd, body?.trim() ? { input: body } : undefined);
  if (r.exitCode !== 0) {
    return { ok: false, error: r.stderr.trim() || `gh exit ${r.exitCode}` };
  }
  return { ok: true };
}

export type PrMergeMethod = "merge" | "squash" | "rebase";

/** `gh pr merge <n>` with the chosen method. Defaults to squash. */
export async function prMerge(
  cwd: string,
  number: number,
  method: PrMergeMethod = "squash",
): Promise<GhResult<void>> {
  const flag =
    method === "merge" ? "--merge" : method === "rebase" ? "--rebase" : "--squash";
  const r = await run(["gh", "pr", "merge", String(number), flag], cwd);
  if (r.exitCode !== 0) {
    return { ok: false, error: r.stderr.trim() || `gh exit ${r.exitCode}` };
  }
  return { ok: true };
}

/** `gh issue comment <n> --body-file -`. */
export async function issueComment(
  cwd: string,
  number: number,
  body: string,
): Promise<GhResult<void>> {
  if (!body.trim()) return { ok: false, error: "comment body is required" };
  const r = await run(
    ["gh", "issue", "comment", String(number), "--body-file", "-"],
    cwd,
    { input: body },
  );
  if (r.exitCode !== 0) {
    return { ok: false, error: r.stderr.trim() || `gh exit ${r.exitCode}` };
  }
  return { ok: true };
}
