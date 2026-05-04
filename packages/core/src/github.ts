import type {
  GithubComment,
  GithubCommitRef,
  GithubIssue,
  GithubListQuery,
  GithubPr,
  GithubReview,
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

// Field set for the list rows. Kept lean — no comments/reviews/commits
// here to keep the JSON payload small when the operator pulls 100+ items.
// Per-row detail (with full conversation) is fetched on demand via
// `viewIssueDetail` / `viewPrDetail`.
const ISSUE_LIST_FIELDS =
  "number,title,state,url,body,author,labels,assignees,milestone,createdAt,updatedAt,closedAt";
const PR_LIST_FIELDS =
  "number,title,state,url,body,author,labels,assignees,milestone,isDraft,baseRefName,headRefName,mergeable,mergeStateStatus,reviewDecision,createdAt,updatedAt,closedAt,mergedAt";

// Field set for the detail fetch — includes the entire conversation:
// comments, reviews (with inline review comments), commits, plus diff
// stats so the agent knows the size of the change before reading it.
const ISSUE_DETAIL_FIELDS =
  "number,title,state,url,body,author,labels,assignees,milestone,comments,createdAt,updatedAt,closedAt";
const PR_DETAIL_FIELDS =
  "number,title,state,url,body,author,labels,assignees,milestone,isDraft,baseRefName,headRefName,mergeable,mergeStateStatus,reviewDecision,comments,reviews,commits,additions,deletions,changedFiles,createdAt,updatedAt,closedAt,mergedAt";

interface GhListItem {
  number?: number;
  title?: string;
  state?: string;
  url?: string;
  body?: string | null;
  author?: { login?: string } | null;
  labels?: Array<{ name?: string; color?: string | null }> | null;
  assignees?: Array<{ login?: string }> | null;
  milestone?: { title?: string } | null;
  isDraft?: boolean;
  baseRefName?: string;
  headRefName?: string;
  mergeable?: string | null;
  mergeStateStatus?: string | null;
  reviewDecision?: string | null;
  additions?: number | null;
  deletions?: number | null;
  changedFiles?: number | null;
  closedAt?: string | null;
  mergedAt?: string | null;
  comments?: Array<{
    author?: { login?: string } | null;
    body?: string;
    createdAt?: string;
    url?: string;
  }> | null;
  reviews?: Array<{
    author?: { login?: string } | null;
    state?: string;
    body?: string;
    submittedAt?: string;
    comments?: Array<{
      body?: string;
      path?: string;
      author?: { login?: string } | null;
    }>;
  }> | null;
  commits?: Array<{
    oid?: string;
    messageHeadline?: string;
    authoredDate?: string;
    authors?: Array<{ login?: string | null; name?: string | null }>;
  }> | null;
  createdAt?: string;
  updatedAt?: string;
}

function normalizeComments(raw: GhListItem["comments"]): GithubComment[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.map((c) => ({
    author: c.author?.login ? { login: c.author.login } : null,
    body: c.body ?? "",
    createdAt: c.createdAt ?? "",
    ...(c.url ? { url: c.url } : {}),
  }));
}

function normalizeReviews(raw: GhListItem["reviews"]): GithubReview[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.map((r) => ({
    author: r.author?.login ? { login: r.author.login } : null,
    state: r.state ?? "",
    body: r.body ?? "",
    ...(r.submittedAt ? { submittedAt: r.submittedAt } : {}),
    comments: Array.isArray(r.comments)
      ? r.comments.map((c) => ({
          body: c.body ?? "",
          ...(c.path ? { path: c.path } : {}),
          author: c.author?.login ? { login: c.author.login } : null,
        }))
      : [],
  }));
}

function normalizeCommits(raw: GhListItem["commits"]): GithubCommitRef[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.map((c) => ({
    oid: c.oid ?? "",
    messageHeadline: c.messageHeadline ?? "",
    ...(c.authoredDate ? { authoredDate: c.authoredDate } : {}),
    authors: Array.isArray(c.authors)
      ? c.authors.map((a) => ({
          login: a.login ?? null,
          name: a.name ?? null,
        }))
      : [],
  }));
}

function normalizeIssue(raw: GhListItem): GithubIssue | null {
  if (typeof raw.number !== "number") return null;
  const comments = normalizeComments(raw.comments);
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
    assignees: (raw.assignees ?? [])
      .filter((a): a is { login: string } => typeof a?.login === "string")
      .map((a) => ({ login: a.login })),
    milestone: raw.milestone?.title ? { title: raw.milestone.title } : null,
    closedAt: raw.closedAt ?? null,
    ...(comments ? { comments, commentCount: comments.length } : {}),
    createdAt: raw.createdAt ?? "",
    updatedAt: raw.updatedAt ?? "",
  };
}

function normalizePr(raw: GhListItem): GithubPr | null {
  if (typeof raw.number !== "number") return null;
  const comments = normalizeComments(raw.comments);
  const reviews = normalizeReviews(raw.reviews);
  const commits = normalizeCommits(raw.commits);
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
    assignees: (raw.assignees ?? [])
      .filter((a): a is { login: string } => typeof a?.login === "string")
      .map((a) => ({ login: a.login })),
    milestone: raw.milestone?.title ? { title: raw.milestone.title } : null,
    isDraft: raw.isDraft === true,
    baseRefName: raw.baseRefName ?? "",
    headRefName: raw.headRefName ?? "",
    mergeable: raw.mergeable ?? null,
    mergeStateStatus: raw.mergeStateStatus ?? null,
    reviewDecision: raw.reviewDecision ?? null,
    additions: raw.additions ?? null,
    deletions: raw.deletions ?? null,
    changedFiles: raw.changedFiles ?? null,
    closedAt: raw.closedAt ?? null,
    mergedAt: raw.mergedAt ?? null,
    ...(comments ? { comments, commentCount: comments.length } : {}),
    ...(reviews ? { reviews } : {}),
    ...(commits ? { commits } : {}),
    createdAt: raw.createdAt ?? "",
    updatedAt: raw.updatedAt ?? "",
  };
}

/**
 * Build the shared filter args used by both `gh issue list` and `gh pr
 * list`. Each `--label` repeats once per label so multi-label "AND"
 * filtering works (matches github.com's behavior).
 */
function buildListArgs(
  opts: GithubListQuery | undefined,
  defaults: { state: string; limit: number },
): string[] {
  const args: string[] = [];
  args.push("--state", opts?.state ?? defaults.state);
  args.push("--limit", String(opts?.limit ?? defaults.limit));
  if (opts?.search?.trim()) args.push("--search", opts.search.trim());
  if (opts?.author?.trim()) args.push("--author", opts.author.trim());
  if (opts?.assignee?.trim()) args.push("--assignee", opts.assignee.trim());
  if (opts?.milestone?.trim()) args.push("--milestone", opts.milestone.trim());
  for (const label of opts?.labels ?? []) {
    if (label.trim()) args.push("--label", label.trim());
  }
  return args;
}

/**
 * `gh issue list --json …`. Accepts the full `gh issue list` filter
 * vocabulary plus a `search` query that uses github.com's own search
 * syntax (`is:open author:foo label:bug in:title,body`). Default limit
 * is 50; bump via `opts.limit` (capped at 500 by the contract schema).
 *
 * The list payload is intentionally lean — comments/reviews are not
 * fetched here so a 500-row pull stays fast. Use `viewIssueDetail` for
 * the full conversation.
 */
export async function listIssues(
  cwd: string,
  opts?: GithubListQuery,
): Promise<GhResult<GithubIssue[]>> {
  const args = [
    "gh",
    "issue",
    "list",
    ...buildListArgs(opts, { state: "open", limit: 50 }),
    "--json",
    ISSUE_LIST_FIELDS,
  ];
  const r = await run(args, cwd);
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

/**
 * `gh pr list --json …`. Same vocabulary as `listIssues` plus PR-only
 * flags: `draft` (filter to draft PRs) and `base` (target branch).
 */
export async function listPrs(
  cwd: string,
  opts?: GithubListQuery,
): Promise<GhResult<GithubPr[]>> {
  const args = [
    "gh",
    "pr",
    "list",
    ...buildListArgs(opts, { state: "open", limit: 50 }),
  ];
  if (opts?.draft) args.push("--draft");
  if (opts?.base?.trim()) args.push("--base", opts.base.trim());
  args.push("--json", PR_LIST_FIELDS);
  const r = await run(args, cwd);
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

/**
 * Single-PR fetch with the full conversation: body + branch refs +
 * comments + reviews (with inline review comments) + commit list +
 * diff stats. Used by the detail view and the spawn flow so the agent
 * lands knowing everything reviewers have already said about the PR.
 */
export async function viewPr(
  cwd: string,
  number: number,
): Promise<GhResult<GithubPr>> {
  const r = await run(
    ["gh", "pr", "view", String(number), "--json", PR_DETAIL_FIELDS],
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

/** Single-issue fetch with body + comments. Same pattern as `viewPr`. */
export async function viewIssue(
  cwd: string,
  number: number,
): Promise<GhResult<GithubIssue>> {
  const r = await run(
    ["gh", "issue", "view", String(number), "--json", ISSUE_DETAIL_FIELDS],
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
 * Fetch a PR's diff via `gh pr diff`. Capped at ~80KB so we don't
 * blow up the spawn prompt on a 50k-line refactor — the agent can
 * always read the worktree directly once it's checked out.
 */
export async function prDiff(
  cwd: string,
  number: number,
  maxBytes = 80_000,
): Promise<GhResult<string>> {
  const r = await run(["gh", "pr", "diff", String(number)], cwd);
  if (r.exitCode !== 0) {
    return { ok: false, error: r.stderr.trim() || `gh exit ${r.exitCode}` };
  }
  let out = r.stdout;
  if (out.length > maxBytes) {
    out =
      out.slice(0, maxBytes) +
      `\n\n… diff truncated at ${maxBytes} bytes. Read the worktree for the rest.`;
  }
  return { ok: true, data: out };
}

/**
 * Render an issue's full conversation — body + each comment in order —
 * as a single markdown block. Used by the spawn flow to inject the
 * complete picture into the agent's prompt instead of just the body.
 */
export function formatIssueConversation(issue: GithubIssue): string {
  const lines: string[] = [];
  lines.push(`# Issue #${issue.number}: ${issue.title}`);
  const meta: string[] = [];
  meta.push(`State: ${issue.state}`);
  if (issue.author?.login) meta.push(`Author: @${issue.author.login}`);
  if (issue.assignees && issue.assignees.length > 0)
    meta.push(`Assignees: ${issue.assignees.map((a) => "@" + a.login).join(", ")}`);
  if (issue.labels && issue.labels.length > 0)
    meta.push(`Labels: ${issue.labels.map((l) => l.name).join(", ")}`);
  if (issue.milestone?.title) meta.push(`Milestone: ${issue.milestone.title}`);
  meta.push(`URL: ${issue.url}`);
  lines.push(meta.join(" · "));
  lines.push("");
  lines.push("## Description");
  lines.push((issue.body ?? "").trim() || "(no description)");
  const comments = issue.comments ?? [];
  if (comments.length > 0) {
    lines.push("");
    lines.push(`## Comments (${comments.length})`);
    for (const c of comments) {
      const who = c.author?.login ? `@${c.author.login}` : "(unknown)";
      const when = c.createdAt ? ` · ${c.createdAt}` : "";
      lines.push("");
      lines.push(`### ${who}${when}`);
      lines.push((c.body ?? "").trim() || "(empty)");
    }
  }
  return lines.join("\n");
}

/**
 * Render a PR's full conversation — body + commits + reviews (with
 * inline comments) + general comments. The agent gets a single
 * structured markdown blob so it can reason about prior reviewer
 * feedback before touching the diff.
 */
export function formatPrConversation(pr: GithubPr): string {
  const lines: string[] = [];
  lines.push(`# PR #${pr.number}: ${pr.title}`);
  const meta: string[] = [];
  meta.push(`State: ${pr.state}${pr.isDraft ? " (draft)" : ""}`);
  if (pr.author?.login) meta.push(`Author: @${pr.author.login}`);
  meta.push(`Branch: ${pr.headRefName} → ${pr.baseRefName}`);
  if (pr.reviewDecision) meta.push(`Review decision: ${pr.reviewDecision}`);
  if (pr.mergeStateStatus) meta.push(`Merge state: ${pr.mergeStateStatus}`);
  if (pr.assignees && pr.assignees.length > 0)
    meta.push(`Assignees: ${pr.assignees.map((a) => "@" + a.login).join(", ")}`);
  if (pr.labels && pr.labels.length > 0)
    meta.push(`Labels: ${pr.labels.map((l) => l.name).join(", ")}`);
  if (pr.milestone?.title) meta.push(`Milestone: ${pr.milestone.title}`);
  if (typeof pr.changedFiles === "number")
    meta.push(`${pr.changedFiles} files (+${pr.additions ?? 0}/-${pr.deletions ?? 0})`);
  meta.push(`URL: ${pr.url}`);
  lines.push(meta.join(" · "));
  lines.push("");
  lines.push("## Description");
  lines.push((pr.body ?? "").trim() || "(no description)");
  if (pr.commits && pr.commits.length > 0) {
    lines.push("");
    lines.push(`## Commits (${pr.commits.length})`);
    for (const c of pr.commits.slice(0, 50)) {
      const oid = c.oid ? c.oid.slice(0, 7) : "";
      lines.push(`- \`${oid}\` ${c.messageHeadline}`);
    }
    if (pr.commits.length > 50)
      lines.push(`- … and ${pr.commits.length - 50} more`);
  }
  const reviews = pr.reviews ?? [];
  if (reviews.length > 0) {
    lines.push("");
    lines.push(`## Reviews (${reviews.length})`);
    for (const r of reviews) {
      const who = r.author?.login ? `@${r.author.login}` : "(unknown)";
      const when = r.submittedAt ? ` · ${r.submittedAt}` : "";
      const state = r.state ? ` [${r.state}]` : "";
      lines.push("");
      lines.push(`### ${who}${state}${when}`);
      const body = (r.body ?? "").trim();
      if (body) lines.push(body);
      for (const ic of r.comments ?? []) {
        const path = ic.path ? `\`${ic.path}\`: ` : "";
        lines.push(`> ${path}${(ic.body ?? "").trim()}`);
      }
    }
  }
  const comments = pr.comments ?? [];
  if (comments.length > 0) {
    lines.push("");
    lines.push(`## Conversation (${comments.length})`);
    for (const c of comments) {
      const who = c.author?.login ? `@${c.author.login}` : "(unknown)";
      const when = c.createdAt ? ` · ${c.createdAt}` : "";
      lines.push("");
      lines.push(`### ${who}${when}`);
      lines.push((c.body ?? "").trim() || "(empty)");
    }
  }
  return lines.join("\n");
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
