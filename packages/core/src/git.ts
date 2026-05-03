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
  /**
   * Which CLI to drive the helper through. Defaults to `claude` —
   * existing helpers (commit message, branch name, ideation, plan)
   * have always run there. `codex` lets the operator brainstorm /
   * plan with OpenAI's models too.
   */
  agent?: "claude" | "codex";
  binary?: string;
  model?: string;
  effort?: "low" | "medium" | "high" | "max" | "xhigh";
}

/**
 * Build the helper argv ending with `-p <prompt>` (claude) or
 * `<prompt>` as positional (codex). Caller passes the prompt + cwd.
 *
 * For claude: `claude --permission-mode bypassPermissions --allow-… --effort … [--model …] [--add-dir …] -p <prompt>`
 * For codex:  `codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox [--model …] --config model_reasoning_effort="…" <prompt>`
 *
 * Honors AGENTD_CLAUDE_BIN / AGENTD_CODEX_BIN as legacy binary
 * overrides so existing installs keep working.
 */
/**
 * Stream events the helper produces while it's running. Lets the UI
 * render the agent's tool calls in real time (Read/Glob/Grep/Bash)
 * instead of just showing a spinner. `text` carries assistant prose
 * deltas; `tool_use` and `tool_result` mirror the Claude stream-json
 * shape so the web's existing tool-line rendering plugs in cleanly.
 */
export type HelperStreamEvent =
  | { kind: "tool_use"; name: string; input: unknown }
  | { kind: "tool_result"; ok: boolean; preview?: string }
  | { kind: "text"; delta: string }
  /**
   * A chunk of plan content the agent is currently writing into a
   * `<plan-update>…</plan-update>` block. Routed to the right-side
   * plan panel in the workshop UI; never persisted as a chat token.
   */
  | { kind: "plan_delta"; delta: string }
  | { kind: "raw"; text: string };

interface ClaudeJsonLine {
  type?: string;
  subtype?: string;
  message?: {
    role?: string;
    content?: Array<{
      type?: string;
      text?: string;
      name?: string;
      input?: unknown;
      tool_use_id?: string;
      content?: unknown;
      is_error?: boolean;
    }>;
  };
  result?: string;
  is_error?: boolean;
  event?: {
    type?: string;
    delta?: { type?: string; text?: string };
  };
  content?: unknown;
  tool_use_id?: string;
}

function buildAiHelperArgv(
  opts: AiHelperOptions,
  prompt: string,
  cwd?: string,
  format: "text" | "stream-json" = "text",
): string[] {
  if (opts.agent === "codex") {
    const binary =
      opts.binary?.trim() || process.env.AGENTD_CODEX_BIN || "codex";
    const argv: string[] = [
      binary,
      "exec",
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
    ];
    if (opts.model && opts.model.trim()) {
      argv.push("--model", opts.model.trim());
    }
    const effort = opts.effort ?? "medium";
    const codexEffort = effort === "max" ? "xhigh" : effort;
    argv.push("--config", `model_reasoning_effort="${codexEffort}"`);
    if (cwd) argv.push("--cd", cwd);
    argv.push(prompt);
    return argv;
  }
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
  if (cwd) argv.push("--add-dir", cwd);
  if (format === "stream-json") {
    argv.push(
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
    );
  }
  argv.push("-p", prompt);
  return argv;
}

/**
 * Spawn the claude helper in stream-json mode and yield typed events
 * (text deltas + tool_use + tool_result) as they arrive. Returns the
 * accumulated assistant text + a `source` flag at the end.
 *
 * Codex doesn't support the same stream-json format as claude — for
 * codex helpers we fall back to plain stdout streaming and emit
 * everything as `text` events.
 */
async function* runHelperWithEvents(
  cwd: string,
  prompt: string,
  opts: AiHelperOptions = {},
): AsyncGenerator<
  HelperStreamEvent,
  { text: string; source: "claude" | "codex" | "fallback-empty" | "fallback-error"; error?: string },
  void
> {
  const useJson = (opts.agent ?? "claude") === "claude";
  const argv = buildAiHelperArgv(
    opts,
    prompt,
    cwd,
    useJson ? "stream-json" : "text",
  );
  let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    proc = Bun.spawn({
      cmd: argv,
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: process.env as Record<string, string>,
    });
  } catch (e) {
    return {
      text: "",
      source: "fallback-error",
      error: (e as Error).message,
    };
  }

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let acc = "";
  const pendingEvents: HelperStreamEvent[] = [];

  const handleClaudeLine = (line: string): void => {
    if (!line.trim()) return;
    let parsed: ClaudeJsonLine;
    try {
      parsed = JSON.parse(line) as ClaudeJsonLine;
    } catch {
      return;
    }
    // Streaming text delta from --include-partial-messages.
    if (
      parsed.type === "stream_event" &&
      parsed.event?.type === "content_block_delta" &&
      parsed.event.delta?.type === "text_delta" &&
      typeof parsed.event.delta.text === "string"
    ) {
      const delta = parsed.event.delta.text;
      if (delta) {
        acc += delta;
        pendingEvents.push({ kind: "text", delta });
      }
      return;
    }
    // Final assembled assistant message — surface tool_use blocks.
    if (parsed.type === "assistant" && parsed.message?.content) {
      for (const block of parsed.message.content) {
        if (block.type === "tool_use" && block.name) {
          pendingEvents.push({
            kind: "tool_use",
            name: block.name,
            input: block.input ?? {},
          });
        }
      }
      return;
    }
    // Tool results land as user-role content blocks.
    if (parsed.type === "user" && parsed.message?.content) {
      for (const block of parsed.message.content) {
        if (block.type === "tool_result") {
          let preview: string | undefined;
          if (typeof block.content === "string") {
            preview = block.content.slice(0, 240);
          } else if (Array.isArray(block.content)) {
            const txt = (block.content as Array<{ type?: string; text?: string }>)
              .filter((c) => c.type === "text" && typeof c.text === "string")
              .map((c) => c.text!)
              .join("\n");
            if (txt) preview = txt.slice(0, 240);
          }
          pendingEvents.push({
            kind: "tool_result",
            ok: !block.is_error,
            ...(preview ? { preview } : {}),
          });
        }
      }
      return;
    }
    // Final result envelope from claude — overrides accumulated text
    // with the canonical reply.
    if (parsed.type === "result" && typeof parsed.result === "string") {
      acc = parsed.result;
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (useJson) {
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          handleClaudeLine(line);
          while (pendingEvents.length > 0) yield pendingEvents.shift()!;
        }
      } else {
        // Codex / text mode — pass chunks through as text events.
        const chunk = buffer;
        buffer = "";
        if (chunk) {
          acc += chunk;
          yield { kind: "text", delta: chunk };
        }
      }
    }
    if (useJson && buffer.trim()) {
      handleClaudeLine(buffer);
      while (pendingEvents.length > 0) yield pendingEvents.shift()!;
    } else if (!useJson && buffer) {
      acc += buffer;
      yield { kind: "text", delta: buffer };
    }
  } catch {
    // stream cancelled
  }
  await proc.exited;
  if (!acc.trim()) {
    return { text: "", source: "fallback-empty" };
  }
  return {
    text: acc,
    source: opts.agent === "codex" ? "codex" : "claude",
  };
}

/**
 * Tidy a final assistant reply: strip any "Agent:" / "[agent]" /
 * "**Agent:**" prefix the model leaks despite instructions, drop
 * code-fence wrappers around the whole reply.
 */
function cleanAssistantText(raw: string): string {
  return raw
    .trim()
    .replace(/^```[a-z]*\n?|```\s*$/g, "")
    .replace(
      /^(?:[\*]{0,2}(?:agent|assistant)[\*]{0,2}\s*[:>—-]\s*)/i,
      "",
    )
    .replace(/^(?:\[(?:agent|assistant)\]\s*)/i, "")
    .trim();
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

function buildCommitPrompt(
  diff: string,
  shape: CommitMessageShape,
  extraInstructions?: string,
): string {
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
    extraInstructions?.trim()
      ? `Project-wide commit guidance:\n${extraInstructions.trim()}`
      : "",
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
    /** Free-form guidance appended to the helper's system rules. */
    extraInstructions?: string;
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
  const prompt = buildCommitPrompt(diff, opts, opts.extraInstructions);
  const argv = buildAiHelperArgv(opts.helper ?? {}, prompt);
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
    extraInstructions?: string;
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
  const prompt = buildCommitPrompt(diff, opts, opts.extraInstructions);
  const argv = buildAiHelperArgv(opts.helper ?? {}, prompt);
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

function buildPrPrompt(
  diff: string,
  shape: PrMessageShape,
  extraInstructions?: string,
): string {
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
    extraInstructions?.trim()
      ? `Project-wide PR guidance:\n${extraInstructions.trim()}`
      : "",
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
    extraInstructions?: string;
  } & PrMessageShape = {},
): AsyncGenerator<string, PrMessageResult, void> {
  const { diff } = await readCombinedDiff(cwd, opts.baseRef);
  if (!diff.trim()) {
    const fallback = `${opts.taskTitle ? `feat: ${slugifyTitle(opts.taskTitle)}` : "chore: update"}\n\n${PR_FALLBACK_BODY(opts.taskPrompt)}`;
    yield fallback;
    const split = splitPrOutput(fallback);
    return { ...split, source: "fallback-no-changes" };
  }
  const prompt = buildPrPrompt(diff, opts, opts.extraInstructions);
  const argv = buildAiHelperArgv(opts.helper ?? {}, prompt);
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

/* ── Ideation runner ───────────────────────────────────────────────── */

export interface IdeationResult {
  options: string[];
  source: "claude" | "fallback-empty" | "fallback-error";
  error?: string;
}

/**
 * Run a small Claude helper with the user's ideation prompt and parse
 * the output into a list of option strings. The prompt is augmented
 * with formatting rules — the agent must output one option per line,
 * 1-line each, no preamble. We then split + clean.
 *
 * `cwd` is the project's repo path so the agent can `Read` real files.
 * `extraInstructions` is the operator's optional `agentInstructions`.
 */
function buildIdeationPrompt(prompt: string, max: number): string {
  return [
    `You are brainstorming high-leverage ideas for the operator's project. Each idea is a SHORT directional pitch — what to build and why it's worth doing — not a full implementation spec. The plan tool will name files and steps later when the operator picks one to refine.`,
    "",
    `RECON STEP (mandatory, do this BEFORE generating any options):`,
    `Use your tools to actually look at the project so your ideas are grounded in what it really is. At minimum:`,
    `  1. Glob the top-level layout (\`*\` and \`*/*\` is enough to see the shape).`,
    `  2. Read the README (or equivalent — look for README.md, README, docs/index.md).`,
    `  3. Read whatever the project's manifest is (package.json, Cargo.toml, pyproject.toml, go.mod, etc) so you know the language, deps, and stated purpose.`,
    `  4. Skim 1-2 key source dirs only if needed to understand the domain.`,
    `Don't generate options before doing this. Don't guess what the project is from the brief alone.`,
    `Don't quote specific file paths or symbols in the FINAL options — keep those for the plan tool. The recon is for YOUR grounding, not the output.`,
    "",
    `Return up to ${max} options.`,
    "",
    `Clarify-first rule (IMPORTANT):`,
    `If the operator's brief is too vague to commit to a coherent direction — single words like "ads", "ideas", "make it better", "improvements", or anything you can't ground in what the project actually is — DO NOT generate options. Generating speculative ideas wastes the operator's time. Instead, output ONE clarifying question.`,
    `Output the question as a single line starting with the literal prefix "?? " (two question marks + space). Examples:`,
    `?? "ads" is ambiguous — do you mean billing/conversion features, marketing pages, in-app announcements, or something else?`,
    `?? "make it better" is too broad — which area (workshop, brainstorm, task page) and what dimension (perf, UX, code quality)?`,
    `Stop after the question. No options, no preamble, no second line.`,
    "",
    `Output format when the brief is concrete enough — strictly one option per line:`,
    `  [score: NN] <directional pitch> — <1-line critique>`,
    "",
    `Examples:`,
    `[score: 88] Ship a one-tap "share this task" surface so completed runs become organic distribution — strong growth lever, hinges on a tasteful redaction layer to not leak private repos.`,
    `[score: 72] Add lightweight per-project usage analytics (turns, tokens, time-to-PR) — useful for the operator's own retro, low risk, but easy to over-build if it tries to be a dashboard.`,
    `[score: 45] Build a public "ideas changelog" generator from completed tasks — nice flex, but probably premature; nobody's reading changelogs of a brand-new tool.`,
    "",
    `Rules for the option list:`,
    `- Start every line with "[score: NN] " where NN is a 0-100 estimate of value-vs-effort for THIS project at its current stage. Calibrate honestly: 90+ = ship-now obvious wins, 70-85 = strong, 50-65 = worth considering, <50 = mention only if the brief specifically asked for that direction. Spread the scores; don't bunch everything in 80-90.`,
    `- The directional pitch (after the score) is one tight sentence: WHAT we'd build and the angle that makes it interesting. Don't name specific files, modules, or functions — that's the plan tool's job.`,
    `- The critique (after " — ") is candid: why this matters now, the main risk, or what would make it shippable. Don't praise. Surface the load-bearing concern.`,
    `- Use exactly the em dash separator " — " between pitch and critique.`,
    `- One line per option. No numbering, no bullets, no markdown headers, no preamble.`,
    "",
    `Operator's brief:`,
    prompt.slice(0, 2000),
  ].join("\n");
}

function cleanIdeationLine(raw: string): string {
  return raw
    .trim()
    // Strip leading numbering ("1.", "1)", "- ", "* ").
    .replace(/^(\d+[\.\)]|\-|\*)\s+/, "")
    // Trim a possible single backtick fence opener.
    .replace(/^```[a-z]*\s*$/i, "")
    .replace(/^```\s*$/, "")
    .trim();
}

/**
 * Stream the brainstorm helper, yielding each option line as it's
 * produced. Returns the complete set + source as the final value.
 *
 * The helper outputs one option per line; we read stdout in
 * chunks, split on newline, dedup, and emit cleaned lines. This
 * lets the UI tick options in one-by-one with a fade-in animation
 * instead of waiting 10–30s for the whole batch.
 */
/**
 * Events the brainstorm helper emits. `option` arrives once per
 * extracted idea line; `tool_use` / `tool_result` mirror the agent's
 * Read / Glob / Grep / Bash calls so the brainstorm UI can show live
 * activity (same shape as the workshop's `IdeaChatEvent`).
 */
export type IdeationStreamEvent =
  | { kind: "option"; text: string }
  | { kind: "tool_use"; name: string; input: unknown }
  | { kind: "tool_result"; ok: boolean; preview?: string };

export async function* streamIdeation(
  cwd: string,
  prompt: string,
  opts: { helper?: AiHelperOptions; max?: number } = {},
): AsyncGenerator<IdeationStreamEvent, IdeationResult, void> {
  const max = Math.max(2, Math.min(9, opts.max ?? 5));
  const ask = buildIdeationPrompt(prompt, max);
  const collected: string[] = [];
  const seen = new Set<string>();
  let buffer = "";

  const tryEmit = (raw: string): string | null => {
    if (collected.length >= max) return null;
    const line = cleanIdeationLine(raw);
    if (!line) return null;
    if (seen.has(line)) return null;
    seen.add(line);
    collected.push(line);
    return line;
  };

  // Flush any complete lines from the running text buffer. Lets the
  // UI show options the moment the agent finishes a line, rather
  // than waiting for the whole batch.
  function* drainLines(): Generator<IdeationStreamEvent> {
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      const emitted = tryEmit(raw);
      if (emitted) yield { kind: "option", text: emitted };
    }
  }

  const it = runHelperWithEvents(cwd, ask, opts.helper ?? {});
  let final: { text: string; source: string; error?: string } | null = null;
  try {
    while (true) {
      const next = await it.next();
      if (next.done) {
        final = next.value;
        break;
      }
      const ev = next.value;
      if (ev.kind === "text") {
        buffer += ev.delta;
        for (const line of drainLines()) yield line;
      } else if (ev.kind === "tool_use") {
        yield { kind: "tool_use", name: ev.name, input: ev.input };
      } else if (ev.kind === "tool_result") {
        yield {
          kind: "tool_result",
          ok: ev.ok,
          ...(ev.preview ? { preview: ev.preview } : {}),
        };
      }
      if (collected.length >= max) break;
    }
    // Flush any trailing line that didn't end with a newline.
    if (buffer.trim()) {
      const emitted = tryEmit(buffer);
      if (emitted) yield { kind: "option", text: emitted };
      buffer = "";
    }
  } catch {
    // stream aborted / cancelled
  }
  if (collected.length === 0) {
    return {
      options: [],
      source: (final?.source as IdeationResult["source"]) ?? "fallback-empty",
      ...(final?.error ? { error: final.error } : {}),
    };
  }
  return { options: collected, source: "claude" };
}

/**
 * Synchronous wrapper kept for legacy callers (scheduled ideation
 * templates, telegram CLI). Drains the stream and returns the
 * final result.
 */
export async function runIdeation(
  cwd: string,
  prompt: string,
  opts: { helper?: AiHelperOptions; max?: number } = {},
): Promise<IdeationResult> {
  const it = streamIdeation(cwd, prompt, opts);
  while (true) {
    const next = await it.next();
    if (next.done) return next.value;
  }
}

/* ── Idea validator (second-opinion scoring) ──────────────────────── */

export interface ValidateIdeasResult {
  scores: number[];
  source: "claude" | "codex" | "fallback-empty" | "fallback-error";
  error?: string;
}

/**
 * Re-score a set of brainstorm ideas with a fresh AI helper — usually
 * a different agent / model than the one that produced them — to get
 * a second opinion on value vs. effort. Returns one 0-100 score per
 * idea, in the same order as the input. Lets the operator triangulate
 * across raters instead of trusting a single model's calibration.
 *
 * The output is a tight space-separated number list (e.g. "82 71 45")
 * because that survives transport better than json from CLIs that
 * sometimes wrap output in markdown fences.
 */
export async function validateIdeas(args: {
  cwd: string;
  brief: string;
  ideas: string[];
  helper?: AiHelperOptions;
}): Promise<ValidateIdeasResult> {
  if (args.ideas.length === 0) {
    return { scores: [], source: "fallback-empty" };
  }
  const numbered = args.ideas
    .map((opt, i) => `${i + 1}. ${opt}`)
    .join("\n");
  const ask = [
    `You are evaluating brainstorm ideas for a project. The operator wants a second opinion on each idea's value-vs-effort.`,
    "",
    `Look at the project (read README / manifest / glob top-level dirs) so your scoring is grounded in what the project actually is — don't score from the brief alone.`,
    "",
    `Then for each numbered idea below, give a single integer 0-100 where:`,
    `  90+  ship-now obvious win`,
    `  70-89  strong, worth doing soon`,
    `  50-69  worth considering`,
    `  <50  niche / risky / off-strategy`,
    `Calibrate honestly. Spread the scores; don't bunch everything in 80-90.`,
    "",
    `Output format: ONE LINE only — exactly N space-separated integers in the same order as the ideas, where N is the number of ideas. NO preamble, NO commentary, NO numbering, NO markdown. Just the numbers.`,
    `Example for 3 ideas: "82 64 41"`,
    "",
    `Operator's original brief:`,
    args.brief,
    "",
    `Ideas (${args.ideas.length}):`,
    numbered,
  ].join("\n");
  const argv = buildAiHelperArgv(args.helper ?? {}, ask, args.cwd);
  let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    proc = Bun.spawn({
      cmd: argv,
      cwd: args.cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: process.env as Record<string, string>,
    });
  } catch (e) {
    return { scores: [], source: "fallback-error", error: (e as Error).message };
  }
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  // Pull the longest run of "<int> <int> ..." we can find — guards
  // against helpers that wrap with stray prose despite the prompt.
  const numLine = (out.match(/\b\d{1,3}(?:\s+\d{1,3}){1,}\b/g) ?? [])
    .sort((a, b) => b.length - a.length)[0];
  if (!numLine) {
    return {
      scores: [],
      source: "fallback-empty",
      ...(out ? { error: `unparseable response: ${out.slice(0, 200)}` } : {}),
    };
  }
  const parsed = numLine
    .split(/\s+/)
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isFinite(n) && n >= 0 && n <= 100);
  // Pad / trim to match the input length so the index alignment
  // contract holds even when the helper returned the wrong count.
  const scores: number[] = [];
  for (let i = 0; i < args.ideas.length; i++) {
    scores.push(parsed[i] ?? 0);
  }
  return { scores, source: (args.helper?.agent ?? "claude") };
}

/* ── Suggestion → plan generator ───────────────────────────────────── */

/**
 * Stream a detailed plan for an idea the operator picked. Reads the
 * project's repo so the plan can name real files, modules, and
 * patterns. Output is a markdown-ish brief that the operator hands
 * to whichever executor (claude / codex / a different model) they
 * want — separating the "creative planning" model from the "build
 * it" model lets the operator use a strong reasoner for spec work
 * and a fast/cheap model for execution.
 *
 * Yields raw text chunks; returns a `{ plan, source }` final value.
 */
export interface PlanResult {
  plan: string;
  source: "claude" | "fallback-empty" | "fallback-error";
  error?: string;
}

export async function* streamSuggestionPlan(
  cwd: string,
  brief: string,
  opts: { helper?: AiHelperOptions; extraInstructions?: string } = {},
): AsyncGenerator<string, PlanResult, void> {
  const ask = [
    `You are writing an implementation plan for the operator's idea.`,
    `Read the repo (use Read / Glob / Grep) before writing — the plan should name real files, real symbols, and real patterns from this codebase.`,
    "",
    `Output a plain-text plan with these sections, each as a small markdown header:`,
    `## Goal`,
    `One short paragraph: what we're shipping and why.`,
    `## Approach`,
    `Bulleted strategy. Mention specific files, modules, and patterns from the repo.`,
    `## Changes`,
    `Concrete file-by-file edits with one-line intent each, in implementation order. Use \`path/to/file.ts\` syntax.`,
    `## Edge cases`,
    `Things that could break: backwards-compat, race conditions, invalid input, etc.`,
    `## Acceptance`,
    `Checklist of what "done" looks like — tests added, manual verification, type-check, build.`,
    "",
    `Style:`,
    `- Be specific. Vague plans don't survive contact with the codebase.`,
    `- 250–500 words total. No preamble.`,
    `- No code blocks unless quoting an exact API shape — the executor model will write the code.`,
    opts.extraInstructions ? `\nExtra guidance from the operator:\n${opts.extraInstructions}` : "",
    "",
    `The operator's idea:`,
    brief.slice(0, 2000),
  ].join("\n");

  const argv = buildAiHelperArgv(opts.helper ?? {}, ask, cwd);

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
    return {
      plan: "",
      source: "fallback-error",
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
  const cleaned = raw
    .trim()
    .replace(/^```[a-z]*\n?|```$/g, "")
    .trim();
  if (!cleaned) return { plan: "", source: "fallback-empty" };
  return { plan: cleaned, source: "claude" };
}

/* ── Idea workshop conversation ────────────────────────────────────── */

/**
 * Stream the agent's reply to a refinement question about an idea.
 * The agent reads the project repo, sees the idea + prior thread,
 * and answers concisely. `mode: "challenge"` flips the directive
 * so the agent self-critiques the idea + plan instead of answering
 * a question — the operator's "talk it through with itself" tap.
 */
export interface IdeaChatTurn {
  role: "user" | "agent" | "system";
  content: string;
}

export interface IdeaChatResult {
  reply: string;
  source: "claude" | "fallback-empty" | "fallback-error";
  error?: string;
  /**
   * Content of a `<plan-update>…</plan-update>` block the agent
   * emitted in chat/challenge mode — meaning: "update the plan to
   * this". The daemon writes it to `idea.planDraft` and the workshop
   * UI shows it in the right panel. Null when no block was emitted.
   */
  planContent?: string | null;
}

export async function* streamIdeaConversation(
  cwd: string,
  args: {
    title: string;
    description?: string | null;
    planDraft?: string | null;
    history: IdeaChatTurn[];
    userMessage?: string;
    mode?: "chat" | "challenge" | "plan";
    helper?: AiHelperOptions;
  },
): AsyncGenerator<HelperStreamEvent, IdeaChatResult, void> {
  const mode = args.mode ?? "chat";
  const directive =
    mode === "challenge"
      ? `Challenge this idea. Question its assumptions, point out edge cases or risks, suggest where it might be the wrong scope, and propose 1-2 alternatives if you see better paths. Be candid and specific. Reference real files / patterns from the repo when relevant. Keep it under 250 words.`
      : mode === "plan"
        ? [
            `Produce a thorough, executable implementation plan for this idea — the kind a senior engineer would write before opening a PR.`,
            `Read the repo first: skim the relevant directories, open the files you'd actually touch, and pin specific functions/lines you'd modify.`,
            ``,
            `Format strictly as markdown with these headings, in this exact order:`,
            ``,
            `## Goal`,
            `One paragraph. What we're shipping and why it matters here.`,
            ``,
            `## Approach`,
            `2-5 bullets covering the core design choices and the reasoning behind each. Call out the alternatives you considered and rejected.`,
            ``,
            `## Files`,
            `Bulleted list of every file you'd touch. For each: \`path/to/file.ts\` — what changes there (one line). Group by package/app.`,
            ``,
            `## Steps`,
            `Numbered, ordered steps an agent can execute top-to-bottom. Each step is one atomic change with the file it touches and the symbol/function it adds or modifies. Be concrete: "Add \`fooBar()\` to packages/core/src/x.ts that does Y" — not "implement X".`,
            ``,
            `## Edge cases & risks`,
            `Bulleted. Concurrency, error paths, migration safety, backwards compat, performance traps. What can go wrong and how the plan handles it.`,
            ``,
            `## Acceptance`,
            `Bulleted, observable outcomes — "running \`X\` shows Y", "the UI now does Z". No vague "works correctly".`,
            ``,
            `## Test plan`,
            `Bulleted. Manual checks the operator should run end-to-end, plus any unit/integration test coverage that should land with the change.`,
            ``,
            `Be specific. Reference real files/symbols/lines. Avoid filler. If a section truly has nothing to say, write "n/a — <one-line reason>".`,
            ``,
            `If the prior plan draft already exists, refine and extend it instead of rewriting from scratch — keep what's right, fix what's wrong, fill in what's missing. The operator's latest message (if any) is the diff to apply.`,
          ].join("\n")
        : `Refine this idea with the operator. Be candid, concise, and specific — reference real files/patterns from the repo when relevant. Question assumptions when you spot them. Don't restate the operator; respond to them. Keep replies under 250 words.`;

  const transcript = args.history
    .filter((m) => m.role !== "system")
    .map((m) =>
      m.role === "user" ? `[operator] ${m.content}` : `[agent] ${m.content}`,
    )
    .join("\n\n");

  const idea = [
    `Title: ${args.title}`,
    args.description ? `Description:\n${args.description}` : "",
    args.planDraft ? `Plan draft so far:\n${args.planDraft}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  // Plan-update protocol — only relevant in chat/challenge modes.
  // Plan mode already returns the entire reply as the plan body, so
  // teaching it the tag would just be confusing.
  const planProtocol =
    mode === "plan"
      ? ""
      : [
          `Plan update protocol:`,
          args.planDraft
            ? `The current plan draft is shown above. When this conversation produces a substantive change to the plan — the operator gave you a new file location, suggested a different approach, fixed a misunderstanding, requested a section change, or anything else that should land in the spec — emit the FULL updated plan inside <plan-update>...</plan-update> tags. Then continue your conversational reply explaining what changed and why.`
            : `When the conversation has produced enough clarity to draft a plan (operator asked for one, or you've reached a clear approach), emit the full plan markdown inside <plan-update>...</plan-update> tags, then continue your conversational reply. Otherwise, keep chatting normally without the tags.`,
          `Inside the tags, write the plan as full markdown with these headings: ## Goal, ## Approach, ## Files, ## Steps, ## Edge cases & risks, ## Acceptance, ## Test plan. Reference real files/symbols. Be specific.`,
          `Only emit one <plan-update> block per reply. Do NOT emit it for trivial chatter or when the operator is just asking a question — emit only when the plan should change.`,
        ].join("\n");

  const ask = [
    `You are the operator's thinking partner for a project idea.`,
    directive,
    "",
    `Format: Reply directly. NEVER prefix with "Agent:", "Assistant:", "[agent]", or any role label — the UI handles attribution.`,
    `Use markdown for structure when it helps (bold, lists, inline code for file paths and symbols).`,
    "",
    planProtocol,
    "",
    `The idea:`,
    idea,
    "",
    transcript ? `Conversation so far:\n${transcript}` : "",
    args.userMessage ? `\nOperator's latest message:\n${args.userMessage}` : "",
    "",
    `Respond now.`,
  ]
    .filter(Boolean)
    .join("\n");

  const it = runHelperWithEvents(cwd, ask, args.helper ?? {});
  let final: { text: string; source: string; error?: string } | null = null;

  // Streaming filter for the plan-update protocol — splits text deltas
  // into chat tokens and plan tokens so the workshop can update the
  // right panel live as the agent writes the plan, while the chat
  // thread keeps showing only the conversational reply.
  const splitter = makePlanSplitter();

  try {
    while (true) {
      const next = await it.next();
      if (next.done) {
        final = next.value;
        break;
      }
      const ev = next.value;
      if (ev.kind === "text" && mode !== "plan") {
        for (const out of splitter.feed(ev.delta)) yield out;
      } else {
        yield ev;
      }
    }
    for (const out of splitter.flush()) yield out;
  } catch {
    // stream cancelled
  }
  if (!final || !final.text.trim()) {
    return {
      reply: "",
      source: (final?.source as IdeaChatResult["source"]) ?? "fallback-empty",
      ...(final?.error ? { error: final.error } : {}),
    };
  }
  // Pull the plan-update block out of the final assistant text — that
  // body is what gets persisted as the chat message, so the chat
  // thread should never see the plan markup.
  let planContent: string | null = null;
  let body = final.text;
  if (mode !== "plan") {
    const m = body.match(/<plan-update>([\s\S]*?)<\/plan-update>/);
    if (m) {
      planContent = m[1]!.trim() || null;
      body = body.replace(/<plan-update>[\s\S]*?<\/plan-update>/g, "").trim();
    }
  }
  const cleaned = cleanAssistantText(body);
  return {
    reply: cleaned,
    source: "claude",
    ...(planContent ? { planContent } : {}),
  };
}

/**
 * Streaming-safe splitter for `<plan-update>…</plan-update>` blocks.
 * Feeds in text deltas and yields a sequence of `text` and
 * `plan_delta` events with the tags themselves stripped. Tolerates
 * tag boundaries that span multiple deltas — buffers up to N-1
 * trailing chars where N is the longest tag length so it can match
 * a partial tag once more chars arrive.
 */
function makePlanSplitter() {
  const START = "<plan-update>";
  const END = "</plan-update>";
  const KEEP = Math.max(START.length, END.length) - 1;
  let buf = "";
  let inPlan = false;

  function* drain(): Generator<HelperStreamEvent> {
    while (true) {
      if (!inPlan) {
        const i = buf.indexOf(START);
        if (i >= 0) {
          if (i > 0) yield { kind: "text", delta: buf.slice(0, i) };
          buf = buf.slice(i + START.length);
          inPlan = true;
          continue;
        }
        const safe = Math.max(0, buf.length - KEEP);
        if (safe > 0) {
          yield { kind: "text", delta: buf.slice(0, safe) };
          buf = buf.slice(safe);
        }
        return;
      }
      const j = buf.indexOf(END);
      if (j >= 0) {
        if (j > 0) yield { kind: "plan_delta", delta: buf.slice(0, j) };
        buf = buf.slice(j + END.length);
        inPlan = false;
        continue;
      }
      const safe = Math.max(0, buf.length - KEEP);
      if (safe > 0) {
        yield { kind: "plan_delta", delta: buf.slice(0, safe) };
        buf = buf.slice(safe);
      }
      return;
    }
  }

  return {
    *feed(delta: string): Generator<HelperStreamEvent> {
      buf += delta;
      yield* drain();
    },
    *flush(): Generator<HelperStreamEvent> {
      // Drain whatever's left. If we're still in-plan with no closing
      // tag, treat the remainder as plan content (safer than dropping).
      if (buf.length > 0) {
        if (inPlan) {
          yield { kind: "plan_delta", delta: buf };
        } else {
          yield { kind: "text", delta: buf };
        }
        buf = "";
      }
    },
  };
}

/* ── Suggestion reply router ───────────────────────────────────────── */

/**
 * What the operator wants done with a pending suggestion. Mirrors the
 * shape of the AI router's structured output but is also produced by
 * the cheap heuristic gate (numeric / yes / skip).
 *
 *   pick     — operator picked option N. The agent uses that text.
 *   custom   — operator wants a different prompt entirely (or "do N
 *              but also X" — we synthesize the prompt).
 *   clarify  — too ambiguous to act safely. Bot asks the question back;
 *              suggestion stays pending.
 *   dismiss  — operator skipped.
 */
export type SuggestionAction =
  | {
      action: "pick";
      index: number;
      agent?: "claude" | "codex";
      model?: string;
      thinkingLevel?: "low" | "medium" | "high" | "max" | "xhigh";
    }
  | {
      action: "custom";
      prompt: string;
      agent?: "claude" | "codex";
      model?: string;
      thinkingLevel?: "low" | "medium" | "high" | "max" | "xhigh";
    }
  | { action: "clarify"; question: string }
  | { action: "dismiss" };

// Model alias resolution lives in config.ts (`resolveModelInRegistry`)
// so the registry stays the single source of truth. The router below
// imports it lazily to avoid a circular type dependency.

function resolveThinkingAlias(
  raw: string,
):
  | "low"
  | "medium"
  | "high"
  | "max"
  | "xhigh"
  | undefined {
  const k = raw.trim().toLowerCase();
  if (["low", "fast", "quick"].includes(k)) return "low";
  if (["medium", "normal", "balanced"].includes(k)) return "medium";
  if (["high", "default"].includes(k)) return "high";
  if (["max", "deep", "thorough", "deepest"].includes(k)) return "max";
  if (["xhigh", "very high", "extra high"].includes(k)) return "xhigh";
  return undefined;
}

const AFFIRMATIVE = /^(y|yes|ok|okay|go|do it|sure|sgtm|yep|yeah|please)\b\.?$/i;
const NEGATIVE =
  /^(skip|cancel|dismiss|no|nope|nah|not now|later|ignore|never mind|nvm)\b\.?$/i;

/**
 * Heuristic + AI route a free-form chat reply against a list of
 * suggestion options. Cheap path handles 80% of common replies for
 * free; the AI router covers ambiguous / mixed replies and extracts
 * model/agent/effort overrides ("do option 2 with opus xhigh").
 */
export async function interpretSuggestionReply(args: {
  options: string[];
  text: string;
  helper?: AiHelperOptions;
  /**
   * Resolver for nickname → full model id. Caller passes a closure
   * that knows the user's registry (since we don't import config.ts
   * here to avoid a cycle). Default: identity.
   */
  resolveModel?: (
    raw: string,
    agent: "claude" | "codex",
  ) => string;
  /**
   * The full set of model nicknames + ids the user has in their
   * registry, used to teach the AI router which strings to look for.
   * Optional — when missing, the prompt falls back to a generic hint.
   */
  modelHints?: { agent: "claude" | "codex"; aliases: string[] }[];
}): Promise<SuggestionAction> {
  const text = args.text.trim();
  if (!text) return { action: "clarify", question: "Empty reply — what would you like me to do?" };

  // Cheap path 1: numeric pick.
  const numeric = /^\d+$/.test(text) ? Number(text) : NaN;
  if (Number.isFinite(numeric)) {
    if (numeric >= 1 && numeric <= args.options.length) {
      return { action: "pick", index: numeric - 1 };
    }
    return {
      action: "clarify",
      question: `That's outside the range. Pick 1-${args.options.length}, write your own direction, or say skip.`,
    };
  }

  // Cheap path 2: clear dismissals.
  if (NEGATIVE.test(text)) return { action: "dismiss" };

  // Cheap path 3: bare affirmative against a single option.
  if (AFFIRMATIVE.test(text) && args.options.length === 1) {
    return { action: "pick", index: 0 };
  }

  // AI router. Output is a single line of JSON. Worth the latency
  // because this is where the "talking to a real human" feel lives —
  // "do 2 but also check WS reconnect coverage" → custom prompt.
  const ask = [
    `You are a router. The user saw these options:`,
    args.options.map((o, i) => `${i + 1}. ${o}`).join("\n"),
    "",
    `The user replied: ${JSON.stringify(text)}`,
    "",
    `Output a single line of JSON, no preamble, no fences. Schema:`,
    `{"action":"pick"|"custom"|"clarify"|"dismiss","index"?:number(1-${args.options.length}),"prompt"?:string,"question"?:string,"agent"?:"claude"|"codex","model"?:string,"effort"?:"low"|"medium"|"high"|"max"|"xhigh"}`,
    ``,
    `Rules:`,
    `- pick when they clearly want one of the listed options. Index is 1-based.`,
    `- custom when they want something different OR a hybrid like "do option 2 but also X" — synthesize the prompt that captures both.`,
    `- clarify only when it's genuinely too ambiguous to act safely. Output a short question.`,
    `- dismiss when they want to skip / not now.`,
    `- If they mention a model, include the closest match in "model" (use the user's literal text — the server resolves aliases).${
      args.modelHints?.length
        ? ` Known models: ${args.modelHints
            .flatMap((h) =>
              h.aliases.map((a) => `${a} (${h.agent})`),
            )
            .join(", ")}.`
        : ""
    }`,
    `- If they mention thinking effort (low/medium/high/max/xhigh) include it in "effort".`,
    `- If they mention an agent ("with claude" / "with codex") include it in "agent".`,
    `- Default agent is claude if not specified.`,
    "",
    `Examples:`,
    `User: "1" → {"action":"pick","index":1}`,
    `User: "do option 2 with opus" → {"action":"pick","index":2,"agent":"claude","model":"opus"}`,
    `User: "actually focus on auth instead, codex high" → {"action":"custom","prompt":"focus on auth","agent":"codex","effort":"high"}`,
    `User: "do 2 but also check WS reconnect coverage" → {"action":"custom","prompt":"<option 2 text> AND verify WS reconnect coverage"}`,
    `User: "skip" → {"action":"dismiss"}`,
    `User: "what about both?" → {"action":"clarify","question":"You want me to do both? I can only spawn one task at a time."}`,
    "",
    `JSON:`,
  ].join("\n");

  const argv = buildAiHelperArgv(args.helper ?? {}, ask);
  let raw = "";
  try {
    const proc = Bun.spawn({
      cmd: argv,
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
      env: process.env as Record<string, string>,
    });
    raw = await new Response(proc.stdout).text();
    await proc.exited;
  } catch {
    // Helper unreachable — treat the literal text as a custom prompt.
    return { action: "custom", prompt: text };
  }

  // Pull a JSON object out. Strip fences if Claude wrapped it.
  const cleaned = raw
    .trim()
    .replace(/^```[a-z]*\n?|```$/g, "")
    .trim();
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    // Maybe extra text bracketed the JSON. Try a regex fallback.
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        parsed = JSON.parse(m[0]) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
    }
  }
  if (!parsed) {
    // Garbage — fall back to treating user text as a free-form prompt.
    return { action: "custom", prompt: text };
  }

  const action = String(parsed.action ?? "");
  const agent =
    parsed.agent === "claude" || parsed.agent === "codex"
      ? parsed.agent
      : undefined;
  const resolveModel =
    args.resolveModel ?? ((raw: string) => raw.trim());
  const modelAgent: "claude" | "codex" =
    parsed.agent === "codex" ? "codex" : "claude";
  const model =
    typeof parsed.model === "string" && parsed.model.trim()
      ? resolveModel(parsed.model, modelAgent)
      : undefined;
  const effort =
    typeof parsed.effort === "string"
      ? resolveThinkingAlias(parsed.effort)
      : undefined;

  if (action === "pick") {
    const idx = Number(parsed.index);
    if (
      Number.isFinite(idx) &&
      idx >= 1 &&
      idx <= args.options.length
    ) {
      return {
        action: "pick",
        index: idx - 1,
        ...(agent ? { agent } : {}),
        ...(model ? { model } : {}),
        ...(effort ? { thinkingLevel: effort } : {}),
      };
    }
    // Pick with bad index — degrade to custom with the user's text.
    return { action: "custom", prompt: text };
  }
  if (action === "custom") {
    const promptText =
      typeof parsed.prompt === "string" && parsed.prompt.trim()
        ? parsed.prompt.trim()
        : text;
    return {
      action: "custom",
      prompt: promptText,
      ...(agent ? { agent } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { thinkingLevel: effort } : {}),
    };
  }
  if (action === "clarify") {
    const q =
      typeof parsed.question === "string" && parsed.question.trim()
        ? parsed.question.trim()
        : "Could you say a bit more about what you want?";
    return { action: "clarify", question: q };
  }
  if (action === "dismiss") {
    return { action: "dismiss" };
  }
  // Unknown action — degrade safely.
  return { action: "custom", prompt: text };
}

/* ── Council judge ─────────────────────────────────────────────────── */

export interface JudgeCandidate {
  /** Stable id (the task id) so the caller can map the verdict back. */
  id: string;
  /** Short human label ("opus xhigh", "gpt-5-codex"). */
  label: string;
  /** The candidate's worktree path — the judge reads its diff. */
  cwd: string;
  /** Base branch to diff against. */
  baseRef: string;
}

export interface JudgeVerdict {
  winnerId: string;
  explanation: string;
  source: "claude" | "fallback";
  error?: string;
}

/**
 * Read each candidate's diff vs its base, ask the helper to pick the
 * best, and return the winner's id + a one-line explanation.
 *
 * Falls back to "first candidate that produced any diff" when the
 * helper isn't reachable, so the council always settles eventually.
 */
export async function runJudge(
  prompt: string,
  candidates: JudgeCandidate[],
  opts: { helper?: AiHelperOptions } = {},
): Promise<JudgeVerdict> {
  if (candidates.length === 0) {
    return {
      winnerId: "",
      explanation: "no candidates",
      source: "fallback",
    };
  }
  // Gather diffs.
  const diffs: { id: string; label: string; diff: string }[] = [];
  for (const c of candidates) {
    const { diff } = await readCombinedDiff(c.cwd, c.baseRef);
    diffs.push({ id: c.id, label: c.label, diff: diff.slice(0, 12000) });
  }
  const nonEmpty = diffs.filter((d) => d.diff.trim().length > 0);
  if (nonEmpty.length === 0) {
    return {
      winnerId: candidates[0]!.id,
      explanation: "no candidate produced changes; defaulting to the first",
      source: "fallback",
    };
  }
  if (nonEmpty.length === 1) {
    return {
      winnerId: nonEmpty[0]!.id,
      explanation: `only candidate "${nonEmpty[0]!.label}" produced changes`,
      source: "fallback",
    };
  }
  // Build a short letter-keyed prompt: A / B / C / ... so the model
  // picks one letter, easy to parse out.
  const letters = "ABCDE";
  const sections = nonEmpty
    .map(
      (d, i) =>
        `### Candidate ${letters[i]} (${d.label})\n--- diff start ---\n${d.diff}\n--- diff end ---`,
    )
    .join("\n\n");
  const ask = [
    `You are judging ${nonEmpty.length} parallel attempts at the same task.`,
    `Original prompt:\n${prompt.slice(0, 1500)}`,
    `Pick the candidate whose diff is most likely correct, complete, and idiomatic.`,
    `Output a SINGLE LINE: the candidate's letter, a colon, then a one-sentence reason. No preamble. Example: "B: cleaner separation, no dead code."`,
    "",
    sections,
  ].join("\n\n");
  const argv = buildAiHelperArgv(opts.helper ?? {}, ask);
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
    const cleaned = out.trim().replace(/^```[a-z]*\n?|```$/g, "").trim();
    const m = cleaned.match(/^([A-E])\s*[:.\-]\s*(.+)$/im);
    if (m) {
      const letter = m[1]!.toUpperCase();
      const idx = letters.indexOf(letter);
      const target = idx >= 0 && idx < nonEmpty.length ? nonEmpty[idx] : null;
      if (target) {
        return {
          winnerId: target.id,
          explanation: m[2]!.trim().slice(0, 240),
          source: "claude",
        };
      }
    }
    // Couldn't parse — pick the longest non-empty diff as a heuristic.
    const longest = nonEmpty
      .slice()
      .sort((a, b) => b.diff.length - a.diff.length)[0]!;
    return {
      winnerId: longest.id,
      explanation: "judge output unparseable; chose largest diff",
      source: "fallback",
    };
  } catch (e) {
    return {
      winnerId: nonEmpty[0]!.id,
      explanation: "judge unreachable; defaulted to first non-empty",
      source: "fallback",
      error: (e as Error).message,
    };
  }
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
  const argv = buildAiHelperArgv(opts.helper ?? {}, ask);
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
