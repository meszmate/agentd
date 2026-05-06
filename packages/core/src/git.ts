import {
  IdeaQuestion as IdeaQuestionSchema,
  stripAskUserBlocks,
  stripPlanSlicesBlock,
  type IdeaQuestion,
} from "@agentd/contracts";

async function run(
  cmd: string[],
  cwd: string,
  opts?: { input?: string },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  let proc;
  try {
    proc = Bun.spawn({
      cmd,
      cwd,
      stdin: opts?.input ? "pipe" : "inherit",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (e) {
    // Bun.spawn throws synchronously when the binary isn't on PATH
    // (ENOENT). Returning a non-zero exit code here keeps every caller
    // on the same code path as a normal git failure instead of
    // crashing the daemon's completion hooks, helpers, etc.
    const msg = (e as Error).message || String(e);
    return { stdout: "", stderr: `${cmd[0]}: ${msg}`, exitCode: 127 };
  }
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
  effort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
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
  /**
   * A chunk of instruction content the agent is currently writing
   * into an `<instructions>…</instructions>` block. Routed to the
   * right-side preview in the project-instructions workshop modal.
   */
  | { kind: "instructions_delta"; delta: string }
  /**
   * Structured clarifying question the agent emitted via an
   * `<ask-user>` block. Surfaces (web, telegram, discord) render the
   * options as buttons; tapping one (or typing free-form) feeds back
   * as the operator's next turn. Stripped from the persisted reply.
   */
  | { kind: "question"; question: IdeaQuestion }
  /**
   * Cumulative token + cost usage emitted as the helper progresses
   * (and once more on the final `result` envelope). The UI reads
   * these to render a live "N tok in / M tok out" counter beside
   * the elapsed timer, so the operator can watch how much the agent
   * is burning while it works.
   */
  | {
      kind: "usage";
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      costUsd?: number;
    }
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
    usage?: ClaudeUsage;
  };
  result?: string;
  is_error?: boolean;
  event?: {
    type?: string;
    delta?: { type?: string; text?: string };
  };
  content?: unknown;
  tool_use_id?: string;
  usage?: ClaudeUsage;
  total_cost_usd?: number;
}

interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/**
 * Probe `codex exec --help` once per binary to learn which approval/
 * sandbox flags this install actually supports. Different codex
 * versions ship different surfaces:
 *   - newer:  --dangerously-bypass-approvals-and-sandbox  (one flag)
 *   - older:  --sandbox <mode> + relies on `-c` for approvals
 *   - oldest: only `-c` config overrides
 * We cache the result keyed by binary so we only shell out once.
 */
interface CodexCaps {
  supportsBypass: boolean;
  supportsSandboxFlag: boolean;
  supportsSkipGitRepoCheck: boolean;
}
const CODEX_CAPS_CACHE = new Map<string, CodexCaps>();
function detectCodexCaps(binary: string): CodexCaps {
  const hit = CODEX_CAPS_CACHE.get(binary);
  if (hit) return hit;
  // Pessimistic default — `-c` overrides only, which all codex
  // versions support.
  let caps: CodexCaps = {
    supportsBypass: false,
    supportsSandboxFlag: false,
    supportsSkipGitRepoCheck: false,
  };
  try {
    const out = Bun.spawnSync({
      cmd: [binary, "exec", "--help"],
      stdout: "pipe",
      stderr: "pipe",
      env: process.env as Record<string, string>,
    });
    const text =
      new TextDecoder().decode(out.stdout) +
      new TextDecoder().decode(out.stderr);
    caps = {
      supportsBypass: text.includes("--dangerously-bypass-approvals-and-sandbox"),
      supportsSandboxFlag: /--sandbox\b/.test(text) || /-s,\s*--sandbox/.test(text),
      supportsSkipGitRepoCheck: text.includes("--skip-git-repo-check"),
    };
  } catch {
    // probe failed — keep conservative defaults
  }
  CODEX_CAPS_CACHE.set(binary, caps);
  return caps;
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
    const caps = detectCodexCaps(binary);
    const argv: string[] = [binary, "exec"];
    if (caps.supportsSkipGitRepoCheck) {
      argv.push("--skip-git-repo-check");
    }
    // Pick the flag combo this codex version actually understands.
    // The bypass flag is the cleanest one-shot; otherwise fall back
    // to a sandbox flag + a `-c` override for approvals; the very
    // oldest codex needs both knobs via `-c`. The operator can force
    // a specific path via `AGENTD_CODEX_APPROVAL_MODE`:
    //   - "bypass"  → use the bypass flag (will fail loudly if old)
    //   - "config"  → only `-c` overrides
    //   - "off"     → no bypass at all (will block on first prompt)
    const forced = process.env.AGENTD_CODEX_APPROVAL_MODE;
    if (forced !== "off") {
      const wantConfig = forced === "config" || !caps.supportsBypass;
      if (forced === "bypass" || (!wantConfig && caps.supportsBypass)) {
        argv.push("--dangerously-bypass-approvals-and-sandbox");
      } else {
        if (caps.supportsSandboxFlag) {
          argv.push("--sandbox", "danger-full-access");
        } else {
          argv.push("--config", 'sandbox_mode="danger-full-access"');
        }
        argv.push("--config", 'approval_policy="never"');
      }
    }
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
  // stdin: "ignore" so codex's `exec` doesn't block on the
  // "Reading additional input from stdin..." path when stdin is a
  // pipe with no writer (see packages/agent-runner/src/codex.ts).
  // Helpers always pass the prompt on argv, never via stdin.
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn({
      cmd: argv,
      cwd,
      stdin: "ignore",
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
    // with the canonical reply, plus emits a final usage event.
    if (parsed.type === "result") {
      if (typeof parsed.result === "string") acc = parsed.result;
      const u = parsed.usage;
      if (u) {
        pendingEvents.push({
          kind: "usage",
          inputTokens: u.input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          ...(u.cache_read_input_tokens != null
            ? { cacheReadTokens: u.cache_read_input_tokens }
            : {}),
          ...(u.cache_creation_input_tokens != null
            ? { cacheWriteTokens: u.cache_creation_input_tokens }
            : {}),
          ...(typeof parsed.total_cost_usd === "number"
            ? { costUsd: parsed.total_cost_usd }
            : {}),
        });
      }
      return;
    }
    // Per-turn usage on assistant messages — gives the UI a live
    // counter while the helper is still running.
    if (parsed.type === "assistant" && parsed.message?.usage) {
      const u = parsed.message.usage;
      pendingEvents.push({
        kind: "usage",
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        ...(u.cache_read_input_tokens != null
          ? { cacheReadTokens: u.cache_read_input_tokens }
          : {}),
        ...(u.cache_creation_input_tokens != null
          ? { cacheWriteTokens: u.cache_creation_input_tokens }
          : {}),
      });
    }
  };

  // For codex (text mode), drain stderr into `acc` too. Codex's
  // `exec` mode prints progress lines to stderr and the actual reply
  // is interleaved across both streams; if we only watch stdout the
  // SCORES line can land on the wrong fd and the parser sees
  // nothing. Claude in stream-json mode keeps stderr quiet so we
  // skip the drain there.
  const stderrChunks: string[] = [];
  let stderrDrain: Promise<void> | null = null;
  if (!useJson) {
    stderrDrain = (async () => {
      const r = proc.stderr.getReader();
      const d = new TextDecoder();
      while (true) {
        const { value, done } = await r.read();
        if (done) break;
        stderrChunks.push(d.decode(value, { stream: true }));
      }
    })().catch(() => {});
  }
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
  if (stderrDrain) {
    try {
      await stderrDrain;
    } catch {
      // ignore — best-effort
    }
    if (stderrChunks.length > 0) {
      // Concat stderr after stdout — rare for codex to put the
      // payload on stderr only, but if it does the parser needs it.
      const errText = stderrChunks.join("");
      if (errText.trim()) acc = acc + (acc.endsWith("\n") ? "" : "\n") + errText;
    }
  }
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
  source:
    | "claude"
    | "codex"
    | "fallback-no-changes"
    | "fallback-empty-output"
    | "fallback-claude-error";
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
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: process.env as Record<string, string>,
      },
    );
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) {
      return {
        message: COMMIT_FALLBACK(opts.fallbackHint ?? ""),
        source: "fallback-claude-error",
        error: `helper exited ${code}`,
      };
    }
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
    return { message: cleaned, source: opts.helper?.agent ?? "claude" };
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
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn({
      cmd: argv,
      cwd,
      stdin: "ignore",
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
  return { message: cleaned, source: opts.helper?.agent ?? "claude" };
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
  source:
    | "claude"
    | "codex"
    | "fallback-no-changes"
    | "fallback-empty-output"
    | "fallback-claude-error";
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
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn({
      cmd: argv,
      cwd,
      stdin: "ignore",
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
  return { ...split, source: opts.helper?.agent ?? "claude" };
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
  /**
   * Clarifying question the brainstorm helper raised instead of (or
   * before) generating options — the new structured replacement for
   * the legacy "?? " prefix mechanism. Surfaces render this as a
   * question card with option buttons; the operator's pick fires a
   * fresh brainstorm with the disambiguated brief.
   */
  question?: IdeaQuestion | null;
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
/**
 * Project context the brainstorm agent uses to avoid proposing
 * duplicates of work the operator already saved, generated, or
 * shipped. Each list is passed verbatim so the agent can pattern-
 * match against it; we cap each section so the prompt stays small.
 */
export interface BrainstormContext {
  /** Currently saved ideas in the Idea Library. */
  savedIdeas?: string[];
  /** Options from past brainstorm sessions (across all suggestions). */
  pastOptions?: string[];
  /** Recent task titles (open + closed) — what the project's been
   *  building / has built. */
  recentTasks?: string[];
  /** Project's free-text instructions (CLAUDE.md-style). */
  instructions?: string | null;
}

function buildIdeationPrompt(
  prompt: string,
  max: number,
  ctx: BrainstormContext = {},
): string {
  // Cap each list so the prompt doesn't blow up on long-running
  // projects. The most recent entries are the most useful for
  // dedup; older ones are more likely to be stale.
  const cap = (arr: string[] | undefined, n: number) =>
    (arr ?? []).slice(0, n).map((s) => `- ${s.replace(/\s+/g, " ").trim()}`);
  const savedSection = cap(ctx.savedIdeas, 30);
  const pastSection = cap(ctx.pastOptions, 40);
  const taskSection = cap(ctx.recentTasks, 20);
  const dedupBlock: string[] = [];
  if (savedSection.length > 0) {
    dedupBlock.push(
      "",
      `Already saved in the Idea Library (do NOT propose these again):`,
      ...savedSection,
    );
  }
  if (pastSection.length > 0) {
    dedupBlock.push(
      "",
      `Options from past brainstorm sessions (don't repeat these — propose adjacent or different angles instead):`,
      ...pastSection,
    );
  }
  if (taskSection.length > 0) {
    dedupBlock.push(
      "",
      `Recent tasks the project has worked on or shipped (already done — avoid suggesting these as "next features"):`,
      ...taskSection,
    );
  }
  const instructionsBlock =
    ctx.instructions && ctx.instructions.trim().length > 0
      ? [
          "",
          `Project instructions (operator's guidance for any agent — respect these when picking directions):`,
          ctx.instructions.trim().slice(0, 1500),
        ]
      : [];
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
    `If the operator's brief is too vague to commit to a coherent direction — single words like "ads", "ideas", "make it better", "improvements", or anything you can't ground in what the project actually is — DO NOT generate options. Generating speculative ideas wastes the operator's time. Instead, ASK using the \`<ask-user>\` protocol below: one block, 2-5 distinct directional buckets the operator can tap. After the block, stop. Don't also list options — the operator's reply re-fires brainstorm with the disambiguated brief.`,
    "",
    ASK_USER_INSTRUCTION,
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
    ...(savedSection.length > 0 || pastSection.length > 0
      ? [
          `- DEDUP: don't propose anything substantively similar to ideas already in the lists below. Different angles on the same area are fine; near-restatements aren't.`,
        ]
      : []),
    ...dedupBlock,
    ...instructionsBlock,
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
  | { kind: "tool_result"; ok: boolean; preview?: string }
  | {
      kind: "usage";
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      costUsd?: number;
    }
  /**
   * Structured clarifying question the brainstorm helper emitted via
   * an `<ask-user>` block — fired when the brief is too vague to
   * commit to a direction. The UI renders the options as buttons;
   * the operator's pick re-fires brainstorm with the disambiguated
   * brief. Replaces the older "?? " text-prefix mechanism.
   */
  | { kind: "question"; question: IdeaQuestion };

export async function* streamIdeation(
  cwd: string,
  prompt: string,
  opts: {
    helper?: AiHelperOptions;
    max?: number;
    /** Existing project ideas / past suggestions / recent tasks the
     *  agent should dedup against. */
    context?: BrainstormContext;
  } = {},
): AsyncGenerator<IdeationStreamEvent, IdeationResult, void> {
  const max = Math.max(2, Math.min(9, opts.max ?? 5));
  const ask = buildIdeationPrompt(prompt, max, opts.context);
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
  // ask-user splitter: when the brief is too vague, the agent emits a
  // structured question instead of a list of options. The splitter
  // suppresses the JSON body from the line-extraction buffer (otherwise
  // partial JSON would parse into garbage option lines) and emits a
  // `question` event the moment a complete block parses.
  const askSplitter = makeAskUserSplitter();
  let lastQuestion: IdeaQuestion | null = null;
  try {
    while (true) {
      const next = await it.next();
      if (next.done) {
        final = next.value;
        break;
      }
      const ev = next.value;
      if (ev.kind === "text") {
        for (const askEv of askSplitter.feed(ev.delta)) {
          if (askEv.kind === "text") {
            buffer += askEv.delta;
            for (const line of drainLines()) yield line;
          } else if (askEv.kind === "question") {
            lastQuestion = askEv.question;
            yield { kind: "question", question: askEv.question };
          }
        }
      } else if (ev.kind === "tool_use") {
        yield { kind: "tool_use", name: ev.name, input: ev.input };
      } else if (ev.kind === "tool_result") {
        yield {
          kind: "tool_result",
          ok: ev.ok,
          ...(ev.preview ? { preview: ev.preview } : {}),
        };
      } else if (ev.kind === "usage") {
        yield {
          kind: "usage",
          inputTokens: ev.inputTokens,
          outputTokens: ev.outputTokens,
          ...(ev.cacheReadTokens != null
            ? { cacheReadTokens: ev.cacheReadTokens }
            : {}),
          ...(ev.cacheWriteTokens != null
            ? { cacheWriteTokens: ev.cacheWriteTokens }
            : {}),
          ...(ev.costUsd != null ? { costUsd: ev.costUsd } : {}),
        };
      }
      if (collected.length >= max) break;
    }
    // Drain any text the splitter held back at boundaries.
    for (const askEv of askSplitter.flush()) {
      if (askEv.kind === "text") {
        buffer += askEv.delta;
        for (const line of drainLines()) yield line;
      } else if (askEv.kind === "question") {
        lastQuestion = askEv.question;
        yield { kind: "question", question: askEv.question };
      }
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
      ...(lastQuestion ? { question: lastQuestion } : {}),
    };
  }
  return {
    options: collected,
    source: "claude",
    ...(lastQuestion ? { question: lastQuestion } : {}),
  };
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

function buildValidateIdeasPrompt(brief: string, ideas: string[]): string {
  const numbered = ideas.map((opt, i) => `${i + 1}. ${opt}`).join("\n");
  return [
    `You are evaluating brainstorm ideas for a project. The operator wants a second opinion on each idea's value-vs-effort.`,
    "",
    `RECON STEP (mandatory, do this BEFORE scoring — you have shell + file tools, USE them):`,
    `  1. Glob or list the top-level layout to see the shape of the project.`,
    `  2. Read the README (or equivalent — README.md, README, docs/index.md).`,
    `  3. Read the project's manifest (package.json / Cargo.toml / pyproject.toml / go.mod) so you know the language, deps, and stated purpose.`,
    `  4. Skim 1-2 key source dirs only if you still need to understand the domain.`,
    `Don't score from the brief alone. If you skip this step your scores will be wrong and the operator will throw them out.`,
    "",
    `Then for each numbered idea below, give a single integer 0-100 where:`,
    `  90+  ship-now obvious win`,
    `  70-89  strong, worth doing soon`,
    `  50-69  worth considering`,
    `  <50  niche / risky / off-strategy`,
    `Calibrate honestly. Spread the scores; don't bunch everything in 80-90.`,
    "",
    `Output format — STRICT:`,
    `Your final reply MUST end with exactly one line that starts with the literal token "SCORES:" followed by ${ideas.length} space-separated integers in the same order as the ideas. Anything before that line is ignored. The SCORES line must be the LAST line of your reply.`,
    `Example for 3 ideas:`,
    `  SCORES: 82 64 41`,
    "",
    `Operator's original brief:`,
    brief,
    "",
    `Ideas (${ideas.length}):`,
    numbered,
  ].join("\n");
}

/**
 * Streaming validator — same shape as `streamIdeation`, yields tool
 * events as the rater explores the repo, then returns the parsed
 * scores. Lets the UI show "claude opus is reading the README…"
 * during the rate so the operator isn't staring at a silent spinner.
 */
export async function* streamValidateIdeas(args: {
  cwd: string;
  brief: string;
  ideas: string[];
  helper?: AiHelperOptions;
}): AsyncGenerator<HelperStreamEvent, ValidateIdeasResult, void> {
  if (args.ideas.length === 0) {
    return { scores: [], source: "fallback-empty" };
  }
  const ask = buildValidateIdeasPrompt(args.brief, args.ideas);
  const it = runHelperWithEvents(args.cwd, ask, args.helper ?? {});
  let final: { text: string; source: string; error?: string } | null = null;
  try {
    while (true) {
      const next = await it.next();
      if (next.done) {
        final = next.value;
        break;
      }
      const ev = next.value;
      // Forward tool activity so the UI can render live; drop text
      // deltas — the helper's prose is the score line itself which
      // we parse below from final.text.
      if (ev.kind === "tool_use" || ev.kind === "tool_result") yield ev;
    }
  } catch {
    // stream cancelled
  }
  return parseScores(final?.text ?? "", args.ideas.length, final?.error ?? null);
}

/**
 * Synchronous wrapper kept for the (now unused) one-shot validate
 * endpoint and any future caller that doesn't care about live tool
 * events. Drains the streaming variant.
 */
export async function validateIdeas(args: {
  cwd: string;
  brief: string;
  ideas: string[];
  helper?: AiHelperOptions;
}): Promise<ValidateIdeasResult> {
  const it = streamValidateIdeas(args);
  while (true) {
    const next = await it.next();
    if (next.done) return next.value;
  }
}

function parseScores(
  raw: string,
  expectedLen: number,
  err: string | null,
): ValidateIdeasResult {
  const out = raw.trim();
  if (!out && err) {
    return { scores: [], source: "fallback-error", error: err };
  }
  if (expectedLen === 0) {
    return { scores: [], source: "fallback-empty" };
  }
  // Strip ANSI escape sequences (codex / claude both emit color codes
  // that wreck regex matching). Then extract integer runs of any
  // length — single numbers count too, since some helpers emit
  // "1. 82\n2. 64" style instead of a single line. We then pick
  // either the longest space-separated run, OR concatenate the leading
  // integers in order until we have N (one per idea).
  // Strip a wider set of ANSI sequences plus stray control bytes —
  // codex's TUI emits CSI ("\x1b[...X"), OSC ("\x1b]...BEL"), and
  // raw control chars that the regex parser would otherwise miss.
  const cleaned = out
    .replace(/\x1b\[\??[0-9;]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
  let parsed: number[] = [];
  // Tier 1 (most reliable): the prompt mandates a "SCORES: N1 N2 …"
  // line as the LAST thing in the reply. Take the latest match so
  // earlier example numbers in the prompt don't poison parsing.
  const scoresMatches = [
    ...cleaned.matchAll(/SCORES?\s*[:=]\s*([\d\s,]+)/gi),
  ];
  if (scoresMatches.length > 0) {
    const tail = scoresMatches[scoresMatches.length - 1]![1]!;
    parsed = tail
      .split(/[\s,]+/)
      .map((s) => parseInt(s, 10))
      .filter((n) => Number.isFinite(n) && n >= 0 && n <= 100);
  }
  // Tier 2: longest run of "<int> <int> …" — codex sometimes drops
  // the SCORES tag despite the prompt.
  if (parsed.length < expectedLen) {
    const runs = cleaned.match(/\b\d{1,3}(?:\s+\d{1,3}){1,}\b/g) ?? [];
    if (runs.length > 0) {
      const longest = runs
        .sort((a, b) => b.length - a.length)[0]!
        .split(/\s+/)
        .map((s) => parseInt(s, 10))
        .filter((n) => Number.isFinite(n) && n >= 0 && n <= 100);
      if (longest.length > parsed.length) parsed = longest;
    }
  }
  // Tier 3: scrape every "<int>" in document order. Strip option
  // numbers ("1.", "1)") so they don't get counted as scores.
  if (parsed.length < expectedLen) {
    const ints = (cleaned.replace(/\b\d+[\.\)]\s+/g, "").match(/\b\d{1,3}\b/g) ?? [])
      .map((s) => parseInt(s, 10))
      .filter((n) => Number.isFinite(n) && n >= 0 && n <= 100);
    if (ints.length > parsed.length) parsed = ints;
  }
  if (parsed.length === 0) {
    const preview = cleaned.trim().slice(0, 400);
    // Surface the raw output so we can see what the rater actually
    // returned without bouncing through a debugger. Operators read
    // the daemon log when validation breaks.
    console.warn(
      "[validateIdeas] no scores parsed; raw rater output:",
      JSON.stringify(raw.slice(0, 800)),
    );
    return {
      scores: [],
      source: "fallback-empty",
      error: preview
        ? `unparseable rater response: ${preview}`
        : err ?? `rater returned no output`,
    };
  }
  // Pad / trim to match the input length so the index alignment
  // contract holds even when the helper returned the wrong count.
  const scores: number[] = [];
  for (let i = 0; i < expectedLen; i++) {
    scores.push(parsed[i] ?? 0);
  }
  return { scores, source: "claude" };
}

/* ── Plan-slice parsing ───────────────────────────────────────────── */

/**
 * Parse a planner's output into prose + executable slices. The planner
 * emits a fenced \`\`\`json-slices block at the tail; this helper
 * strips the block from the prose body and returns its parsed payload.
 *
 * Forgiving: a missing or malformed block returns `slices: []` and
 * leaves the original text untouched. Operators don't lose their plan
 * to a JSON syntax glitch.
 */
export interface ParsedPlan {
  plan: string;
  slices: Array<{
    title: string;
    prompt: string;
    agent?: "claude" | "codex";
    model?: string;
    thinkingLevel?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
    permissionMode?: "bypassPermissions" | "acceptEdits" | "plan";
  }>;
}

const SLICE_BLOCK_RE = /```json-slices\s*\n([\s\S]*?)\n```/i;

/**
 * Shared instruction for both plan-generating prompts. Tells the model
 * when slices are MANDATORY (any phased / multi-agent / cross-boundary
 * plan) and gives it a concrete shape so the JSON parses cleanly.
 *
 * Kept in one place because the two callers (suggestion plan + idea
 * conversation plan mode) must stay in sync — otherwise one path emits
 * slices and the other doesn't, and the spawn sheet UX silently splits.
 */
/**
 * Shared instruction that teaches the agent to ask clarifying
 * questions via a structured `<ask-user>` block instead of guessing.
 * Mirrors the AskUserQuestion / request_user_input tools in
 * Claude Code and Codex — short header chip, full question, 2-5
 * options each with a tradeoff line. Operators can always type a
 * free-form answer instead of picking. Surfaces (web, telegram,
 * discord) all render this block as button rows.
 *
 * Kept in one place so brainstorm + idea-conversation + plan + idea
 * validate stay in sync — drift between them lands the agent
 * emitting questions in one mode and pure prose in another, and the
 * UX flips silently between flows.
 */
const ASK_USER_INSTRUCTION = [
  `Ask-the-user protocol (USE THIS instead of guessing when something material is unclear):`,
  `When the operator's request leaves a real fork in the road — different scopes, different files, different acceptance criteria — STOP and ask. Don't make a 50/50 guess and barrel ahead; that wastes the operator's turn and hides the choice from them.`,
  ``,
  `Format: emit ONE \`<ask-user>\` block somewhere in your reply, with a strict JSON body. The UI parses this and renders the options as tappable buttons; the operator can always type their own answer instead of picking. Keep the surrounding prose minimal — one short sentence of context above the block is enough.`,
  ``,
  `<ask-user>`,
  `{"id":"<stable-snake-case-id>","header":"<<=12 char chip>","question":"<single sentence ending with '?'>","options":[{"label":"<1-5 words>","description":"<one-line tradeoff>"},{"label":"<…>","description":"<…>"}]}`,
  `</ask-user>`,
  ``,
  `Rules:`,
  `- 2-5 options. Fewer than 2 isn't a question; more than 5 is a menu.`,
  `- Each label is 1-5 words. The description is the WHY/tradeoff in one line — what changes if they pick this.`,
  `- The options must be MEANINGFULLY different. Don't list "yes" / "yeah, sure" / "go for it".`,
  `- "Other" is implicit — the UI always offers a free-form text box, so don't add an "Other..." option yourself.`,
  `- Use \`<ask-user>\` ONLY when you genuinely can't proceed without the answer. If you can pick a reasonable default and call it out, do that instead — the operator can redirect.`,
  `- After the block, keep prose to a minimum and STOP. Don't pre-answer your own question; wait for the operator's reply.`,
  `- Never quote the raw \`<ask-user>\` markup in any other context — the parser strips it on display, and quoting it confuses future replies.`,
].join("\n");

const SLICE_BLOCK_INSTRUCTION = [
  `After the plan prose, append a fenced \`\`\`json-slices\`\`\` block whose body is a JSON array of {title, prompt} objects (with optional agent / model / thinkingLevel / permissionMode hints). Each entry becomes one task in a sibling chain that shares a single git branch and runs sequentially, so slices represent independent commits stacked on the same branch.`,
  ``,
  `Slice WHENEVER the plan has more than one self-contained step that could land as its own commit. The split is about commit boundaries and runner handoffs — NOT about specific domains. Anywhere the work changes shape (different files, different concerns, a clear "now we move on to…" beat) is a slice boundary. Use as many slices as the plan has natural beats — two, four, seven, whatever fits the work.`,
  ``,
  `Skip the block ONLY for genuinely single-step work — one tight change in one place. Even then, a single-slice block is fine and lets the operator tweak before spawning.`,
  ``,
  `Mirror the structure of your plan body exactly: one slice per step, in execution order. Don't collapse a multi-step plan into one slice; don't pad a single-step plan with fake slices.`,
  ``,
  `Each slice's \`prompt\` is the full standalone instruction that slice's runner will receive. Make it self-contained — it should make sense without seeing sibling slices, but it can reference "the previous slice's commits on this branch" since they share the worktree. Include the relevant files, the contract / shape to follow, and the acceptance criteria for that slice.`,
  ``,
  `Hint fields are OPTIONAL — the operator picks agent / model / thinking at spawn time and your suggestions are starting points, not lockdowns. Only set them when the slice has a strong reason (e.g. one slice obviously benefits from deeper reasoning, or from a model with a different strength). When in doubt, omit them and let the operator choose.`,
  ``,
  `Field rules: \`agent\` is "claude" or "codex". \`model\` is a free-form id ("opus", "sonnet", "haiku", "gpt-5-codex", or any id the operator's registry recognizes). \`thinkingLevel\` is "minimal" (codex-only) | "low" | "medium" | "high" | "xhigh" | "max" (claude-only); mismatches get clamped. \`permissionMode\` is "bypassPermissions" | "acceptEdits" | "plan".`,
  ``,
  `Generic shape (the closing \`\`\` fence is REQUIRED — never omit it, the parser strips the block by matching open + close):`,
  `\`\`\`json-slices`,
  `[`,
  `  {"title":"<short label>","prompt":"<full self-contained instruction for this step>"},`,
  `  {"title":"<short label>","prompt":"<full self-contained instruction; can reference earlier slices' commits>"}`,
  `]`,
  `\`\`\``,
].join("\n");

export function parseSlicesFromPlan(text: string): ParsedPlan {
  // Delegates to the canonical helper in @agentd/contracts so the
  // server, the web app, and any downstream consumer share one
  // source of truth for what counts as a slice block.
  const { plan, slices } = stripPlanSlicesBlock(text);
  return { plan, slices };
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
  /** Parsed slices from the trailing json-slices block, when present. */
  slices?: ParsedPlan["slices"];
  /**
   * Latest `<ask-user>` question the planner attached to this turn —
   * if it asked anything before drafting, the spawn sheet renders
   * the options as buttons instead of a plan body.
   */
  question?: IdeaQuestion | null;
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
    ASK_USER_INSTRUCTION,
    `When the idea has a real fork (e.g. two reasonable architectures, two scopes, two file layouts), STOP before drafting the plan and emit one \`<ask-user>\` block. Wait for the operator's pick and write the plan against that direction next turn. A wrong-direction 500-word plan is worse than a 5-second question.`,
    "",
    SLICE_BLOCK_INSTRUCTION,
    "",
    `The operator's idea:`,
    brief.slice(0, 2000),
  ].join("\n");

  const argv = buildAiHelperArgv(opts.helper ?? {}, ask, cwd);

  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn({
      cmd: argv,
      cwd,
      stdin: "ignore",
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
  // Streaming ask-user filter: agent emits `<ask-user>{json}</ask-user>`
  // somewhere in its reply when it needs the operator to pick a fork
  // before drafting. The splitter buffers tag boundaries so the JSON
  // never lands in the live text we yield to the operator's screen.
  // Parsed questions ride on the final PlanResult.
  const askSplitter = makeAskUserSplitter();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      raw += chunk;
      for (const ev of askSplitter.feed(chunk)) {
        if (ev.kind === "text") yield ev.delta;
      }
    }
    for (const ev of askSplitter.flush()) {
      if (ev.kind === "text") yield ev.delta;
    }
  } catch {
    // stream cancelled
  }
  await proc.exited;
  // Strip ask-user blocks from the captured body so the persisted
  // plan never carries raw markup; surface the LAST question on the
  // result so the UI can render option buttons.
  const askStrip = stripAskUserBlocks(raw);
  const cleaned = askStrip.text
    .trim()
    .replace(/^```[a-z]*\n?|```$/g, "")
    .trim();
  const question: IdeaQuestion | null =
    askStrip.questions.length > 0
      ? askStrip.questions[askStrip.questions.length - 1]!
      : null;
  if (!cleaned) {
    return {
      plan: "",
      source: "fallback-empty",
      ...(question ? { question } : {}),
    };
  }
  const parsed = parseSlicesFromPlan(cleaned);
  return {
    plan: parsed.plan,
    source: "claude",
    ...(parsed.slices.length > 0 ? { slices: parsed.slices } : {}),
    ...(question ? { question } : {}),
  };
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
  /**
   * For mode="validate" — the trailing `TITLE: <…>` line the agent
   * emits at the end of every reply, parsed off the body. The
   * brainstorm UI uses this to keep its save-button label fresh.
   */
  suggestedTitle?: string | null;
  /**
   * Plan slices parsed from the agent's tail json-slices block. Only
   * populated for `mode === "plan"` and when the agent actually emitted
   * the block. The chat-mode plan-update path also routes through
   * `parseSlicesFromPlan` so slices found there flow through too.
   */
  planSlices?: ParsedPlan["slices"];
  /**
   * Latest structured `<ask-user>` question the agent attached to
   * this turn — if it asked anything, the surfaces render the
   * options as buttons inline with the agent message. When the
   * agent emitted multiple blocks (rare) we keep the LAST one,
   * since later questions usually supersede earlier ones in the
   * same reply.
   */
  question?: IdeaQuestion | null;
}

export async function* streamIdeaConversation(
  cwd: string,
  args: {
    title: string;
    description?: string | null;
    planDraft?: string | null;
    history: IdeaChatTurn[];
    userMessage?: string;
    mode?: "chat" | "challenge" | "plan" | "validate";
    helper?: AiHelperOptions;
  },
): AsyncGenerator<HelperStreamEvent, IdeaChatResult, void> {
  const mode = args.mode ?? "chat";
  const isFirstValidate =
    mode === "validate" && args.history.length === 0;
  const directive =
    mode === "validate"
      ? isFirstValidate
        ? `The operator has an idea for this project. Use Read/Glob/Grep/Bash to ground yourself in the actual code when it'd sharpen your reply. Respond directly: how would this look here? what's the real shape of it? what's worth flagging? Cite specific files when you do. Keep it tight — under 200 words. No mandatory headings, no preamble. End with EXACTLY this trailing line: TITLE: <3-6 word title for this idea>`
        : `Continue the conversation. Reply directly. Use tools when grounding helps. Keep it short — under 150 words. No headings. End with EXACTLY this trailing line: TITLE: <3-6 word title that reflects the latest direction>`
      : mode === "challenge"
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
            ``,
            SLICE_BLOCK_INSTRUCTION,
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
    ASK_USER_INSTRUCTION,
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

  // Streaming filters — chained. ask-user runs FIRST so question JSON
  // never leaks into either the plan-update stream or the chat stream
  // regardless of where the agent placed the block. plan-update runs
  // after, splitting cleaned text into chat tokens vs plan tokens.
  const askSplitter = makeAskUserSplitter();
  const planSplitter = makePlanSplitter();
  const isPlanMode = mode === "plan";

  function* routeAskEvent(ev: HelperStreamEvent): Generator<HelperStreamEvent> {
    if (ev.kind === "text" && !isPlanMode) {
      yield* planSplitter.feed(ev.delta);
    } else {
      yield ev;
    }
  }

  try {
    while (true) {
      const next = await it.next();
      if (next.done) {
        final = next.value;
        break;
      }
      const ev = next.value;
      if (ev.kind === "text") {
        for (const askEv of askSplitter.feed(ev.delta)) {
          yield* routeAskEvent(askEv);
        }
      } else {
        yield ev;
      }
    }
    for (const askEv of askSplitter.flush()) {
      yield* routeAskEvent(askEv);
    }
    if (!isPlanMode) {
      for (const out of planSplitter.flush()) yield out;
    }
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
  // Pull any `<ask-user>` block out of the message body too — the
  // splitter already suppressed it from the live stream; this is the
  // belt-and-braces strip on persistence so the saved reply never
  // carries raw markup. We surface the LAST question on the result
  // so the UI pins the operative one when an agent (rarely) asks
  // multiple in the same turn.
  const askStripBody = stripAskUserBlocks(body);
  body = askStripBody.text;
  const askStripPlan = planContent
    ? stripAskUserBlocks(planContent)
    : { text: "", questions: [] };
  if (planContent) planContent = askStripPlan.text || null;
  const allQuestions = [...askStripBody.questions, ...askStripPlan.questions];
  const question: IdeaQuestion | null =
    allQuestions.length > 0 ? allQuestions[allQuestions.length - 1]! : null;
  const cleaned = cleanAssistantText(body);
  // Validate mode appends `TITLE: <suggested>` on the agent's trailing
  // line. Surface it on the result for the brainstorm UI's save
  // button — but DO NOT strip it from the persisted body. Keeping
  // the line in the message means the UI can re-parse + re-strip it
  // on every render after a reload (server-side state is the
  // source of truth; we don't need a separate column).
  let suggestedTitle: string | null = null;
  if (mode === "validate") {
    const tm = cleaned.match(/(^|\n)\s*TITLE:\s*([^\n]+?)\s*$/i);
    if (tm) suggestedTitle = (tm[2] ?? "").trim() || null;
  }
  // Plan slices: ALWAYS strip the json-slices block from whatever we
  // return, regardless of mode — the operator should never see the
  // raw fence in chat or plan. We pull slices from the plan body
  // first (mode === "plan"), then from any chat-mode plan-update
  // block, and finally a last-ditch sweep of the chat reply itself
  // for the rare turn where the agent emits slices in a non-plan
  // reply.
  let planSlices: ParsedPlan["slices"] | undefined;
  let finalReply = cleaned;
  if (mode === "plan") {
    const parsed = parseSlicesFromPlan(cleaned);
    finalReply = parsed.plan;
    if (parsed.slices.length > 0) planSlices = parsed.slices;
  } else {
    if (planContent) {
      const parsed = parseSlicesFromPlan(planContent);
      planContent = parsed.plan;
      if (parsed.slices.length > 0) planSlices = parsed.slices;
    }
    // Defensive strip on the chat body too — never let raw slice
    // markup leak into the message thread.
    const chatStrip = parseSlicesFromPlan(cleaned);
    finalReply = chatStrip.plan;
    if (!planSlices && chatStrip.slices.length > 0) planSlices = chatStrip.slices;
  }
  return {
    reply: finalReply,
    source: "claude",
    ...(planContent ? { planContent } : {}),
    ...(suggestedTitle ? { suggestedTitle } : {}),
    ...(planSlices ? { planSlices } : {}),
    ...(question ? { question } : {}),
  };
}

/**
 * "I have an idea" agentic flow — the operator types something they
 * want to build; the agent reads the repo (Read/Glob/Grep/Bash) and
 * streams back: (a) what it understood the idea to be, (b) how it
 * would look in this codebase (real files, real paths), (c) honest
 * critique. Ends with `TITLE: <suggested title>` on its own line so
 * the UI can populate a save-button label. The brainstorm view
 * renders this turn just like a brainstorm session: live tool
 * activity above, prose body, action row when finished.
 */
export interface ValidateIdeaResult {
  ok: boolean;
  critique: string;
  suggestedTitle: string;
  source: "claude" | "codex" | "fallback-empty" | "fallback-error";
  error?: string;
  /**
   * Latest `<ask-user>` question the agent attached to the validate
   * turn — if it asked anything, surfaces render the options as
   * buttons inline with the agent reply.
   */
  question?: IdeaQuestion | null;
}

export interface ValidateIdeaTurn {
  role: "user" | "agent";
  content: string;
}

export async function* streamValidateIdea(
  cwd: string,
  args: {
    text: string;
    history?: ValidateIdeaTurn[];
    helper?: AiHelperOptions;
  },
): AsyncGenerator<HelperStreamEvent, ValidateIdeaResult, void> {
  const text = args.text.trim();
  if (!text) {
    return {
      ok: false,
      critique: "",
      suggestedTitle: "",
      source: "fallback-empty",
      error: "no idea text provided",
    };
  }

  const isFirstTurn = !args.history || args.history.length === 0;
  const transcript = (args.history ?? [])
    .map((m) =>
      m.role === "user" ? `[operator] ${m.content}` : `[agent] ${m.content}`,
    )
    .join("\n\n");

  // Tight, no-fluff prompt. The operator wants a thinking partner,
  // not a structured report. Use tools when grounding helps; reply
  // direct, short, no headings unless they're load-bearing.
  const directive = isFirstTurn
    ? `The operator has an idea for THIS project. Use Read/Glob/Grep/Bash to ground yourself in the actual code when it'd sharpen your reply. Respond directly: how would this look here? what's the real shape of it? what's worth flagging? Cite specific files when you do. Keep it tight — under 200 words. No mandatory headings, no preamble.`
    : `Continue the conversation. Reply directly to what they just said. Use tools when grounding helps. Keep it short — under 150 words. No headings.`;

  const ask = [
    directive,
    ``,
    ASK_USER_INSTRUCTION,
    ``,
    `End your reply with this line, exactly:`,
    `TITLE: <3-6 word title for this idea>`,
    ``,
    `Never prefix your reply with "Agent:", "Assistant:", or "[agent]" — the UI handles attribution.`,
    ``,
    transcript ? `Conversation so far:\n${transcript}\n` : "",
    `Operator's latest message:`,
    text,
  ]
    .filter(Boolean)
    .join("\n");

  const it = runHelperWithEvents(cwd, ask, args.helper ?? {});
  let final: { text: string; source: string; error?: string } | null = null;
  // Filter ask-user blocks out of the live text stream so the
  // brainstorm "I have an idea" surface never shows raw markup —
  // the parsed question rides on the result envelope and the UI
  // pins it as buttons under the agent reply.
  const askSplitter = makeAskUserSplitter();
  try {
    while (true) {
      const next = await it.next();
      if (next.done) {
        final = next.value;
        break;
      }
      const ev = next.value;
      if (ev.kind === "text") {
        for (const askEv of askSplitter.feed(ev.delta)) yield askEv;
      } else {
        yield ev;
      }
    }
    for (const askEv of askSplitter.flush()) yield askEv;
  } catch {
    // stream cancelled
  }

  if (!final || !final.text.trim()) {
    return {
      ok: false,
      critique: "",
      suggestedTitle: "",
      source: (final?.source as ValidateIdeaResult["source"]) ?? "fallback-empty",
      ...(final?.error ? { error: final.error } : {}),
    };
  }

  // Strip any `<ask-user>` blocks from the persisted body too — the
  // splitter already suppressed the live deltas; this is the safety
  // net so the saved reply never carries raw markup.
  const askStrip = stripAskUserBlocks(final.text);
  const stripped = askStrip.text;
  const question: IdeaQuestion | null =
    askStrip.questions.length > 0
      ? askStrip.questions[askStrip.questions.length - 1]!
      : null;
  // Pull the trailing TITLE: line out of the body so the UI can
  // suggest a save title without surfacing the marker in the prose.
  const body = cleanAssistantText(stripped);
  const m = body.match(/(^|\n)\s*TITLE:\s*([^\n]+?)\s*$/i);
  const suggestedTitle = (m?.[2] ?? "").trim();
  const critique = m
    ? body.slice(0, m.index).trim()
    : body.trim();

  return {
    ok: true,
    critique,
    suggestedTitle:
      suggestedTitle ||
      // Fallback: first 6 words of the operator's idea, title-case.
      text
        .split(/\s+/)
        .slice(0, 6)
        .join(" "),
    source: "claude",
    ...(question ? { question } : {}),
  };
}

/**
 * Conversational turn for the project-instructions workshop. The
 * agent has full codebase access (Read/Glob/Grep/Bash) so it can
 * actually look at the project before suggesting rules. Each reply
 * may include an `<instructions>FULL UPDATED TEXT</instructions>`
 * block when the agent wants to revise the draft; the splitter
 * routes those chunks to a separate event stream so the workshop
 * can update its right-side preview live without polluting the chat.
 */
export interface InstructionsChatTurn {
  role: "user" | "agent";
  content: string;
}

export interface InstructionsChatResult {
  reply: string;
  source: "claude" | "codex" | "fallback-empty" | "fallback-error";
  instructions?: string | null;
  error?: string;
}

export async function* streamInstructionsConversation(
  cwd: string,
  args: {
    projectName: string;
    currentDraft: string;
    history: InstructionsChatTurn[];
    userMessage: string;
    helper?: AiHelperOptions;
  },
): AsyncGenerator<HelperStreamEvent, InstructionsChatResult, void> {
  const transcript = args.history
    .map((m) =>
      m.role === "user" ? `[operator] ${m.content}` : `[agent] ${m.content}`,
    )
    .join("\n\n");

  const draftBlock = args.currentDraft.trim()
    ? `Current instructions draft:\n${args.currentDraft.trim()}`
    : `Current instructions draft: (empty — operator hasn't written anything yet)`;

  const ask = [
    `You are helping the operator craft "project instructions" — a short`,
    `agent-facing rules block that gets prepended to every coding-agent`,
    `task spawned in this project. Think tight AGENTS.md / CLAUDE.md.`,
    ``,
    `Use your tools (Read, Glob, Grep, Bash) to actually look at the`,
    `project before suggesting rules. Cite real files, real conventions,`,
    `real tooling. Do NOT make rules up from generic advice.`,
    ``,
    `Project name: ${args.projectName}`,
    `Project path (cwd): ${cwd}`,
    ``,
    draftBlock,
    ``,
    `Format of every reply:`,
    `- Conversational chat first — explain what you found, what you're`,
    `  proposing to add/remove, what trade-offs you see. Brief and direct.`,
    `- THEN, if (and only if) this turn should change the draft, emit`,
    `  the FULL revised instructions inside <instructions>…</instructions>`,
    `  tags. NOT a diff — the whole replacement, ready to save as-is.`,
    `- Inside the tags, format as bullet lines starting with "- ", each`,
    `  rule one imperative sentence under 110 chars. 4-12 lines total.`,
    `- Don't emit the tags for purely conversational turns ("ok will look",`,
    `  questions to the operator, etc.).`,
    `- NEVER prefix your reply with "Agent:", "Assistant:", "[agent]" —`,
    `  the UI handles attribution.`,
    ``,
    transcript ? `Conversation so far:\n${transcript}` : "",
    `\nOperator's latest message:\n${args.userMessage}`,
    ``,
    `Respond now.`,
  ]
    .filter(Boolean)
    .join("\n");

  const it = runHelperWithEvents(cwd, ask, args.helper ?? {});
  let final: { text: string; source: string; error?: string } | null = null;

  const splitter = makeInstructionsSplitter();

  try {
    while (true) {
      const next = await it.next();
      if (next.done) {
        final = next.value;
        break;
      }
      const ev = next.value;
      if (ev.kind === "text") {
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
      source: (final?.source as InstructionsChatResult["source"]) ?? "fallback-empty",
      ...(final?.error ? { error: final.error } : {}),
    };
  }

  let instructions: string | null = null;
  let body = final.text;
  const m = body.match(/<instructions>([\s\S]*?)<\/instructions>/);
  if (m) {
    instructions = m[1]!.trim() || null;
    body = body.replace(/<instructions>[\s\S]*?<\/instructions>/g, "").trim();
  }
  const cleaned = cleanAssistantText(body);
  return {
    reply: cleaned,
    source: "claude",
    ...(instructions ? { instructions } : {}),
  };
}

/**
 * Streaming-safe tag splitter. Feeds in text deltas and yields a
 * sequence of `text` events plus a chosen `kind` for content found
 * inside the tag. Tolerates tag boundaries that span multiple
 * deltas — buffers up to N-1 trailing chars where N is the longest
 * tag length so it can match a partial tag once more chars arrive.
 */
function makeTagSplitter(
  startTag: string,
  endTag: string,
  insideKind: "plan_delta" | "instructions_delta",
) {
  const KEEP = Math.max(startTag.length, endTag.length) - 1;
  let buf = "";
  let inside = false;

  function* drain(): Generator<HelperStreamEvent> {
    while (true) {
      if (!inside) {
        const i = buf.indexOf(startTag);
        if (i >= 0) {
          if (i > 0) yield { kind: "text", delta: buf.slice(0, i) };
          buf = buf.slice(i + startTag.length);
          inside = true;
          continue;
        }
        const safe = Math.max(0, buf.length - KEEP);
        if (safe > 0) {
          yield { kind: "text", delta: buf.slice(0, safe) };
          buf = buf.slice(safe);
        }
        return;
      }
      const j = buf.indexOf(endTag);
      if (j >= 0) {
        if (j > 0) yield { kind: insideKind, delta: buf.slice(0, j) };
        buf = buf.slice(j + endTag.length);
        inside = false;
        continue;
      }
      const safe = Math.max(0, buf.length - KEEP);
      if (safe > 0) {
        yield { kind: insideKind, delta: buf.slice(0, safe) };
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
      // Drain whatever's left. If we're still inside the tag with no
      // closing match, treat the remainder as inside content (safer
      // than dropping).
      if (buf.length > 0) {
        if (inside) {
          yield { kind: insideKind, delta: buf };
        } else {
          yield { kind: "text", delta: buf };
        }
        buf = "";
      }
    },
  };
}

function makePlanSplitter() {
  return makeTagSplitter("<plan-update>", "</plan-update>", "plan_delta");
}

/**
 * Streaming-safe extractor for `<ask-user>{json}</ask-user>` blocks.
 * Suppresses the JSON body from the live text deltas (so the chat
 * thread never shows raw markup) and emits a `question` event the
 * moment a complete block parses. Mirrors the boundary-tolerant
 * buffering of `makeTagSplitter` — tags can land mid-chunk.
 */
const ASK_USER_OPEN = "<ask-user>";
const ASK_USER_CLOSE = "</ask-user>";

function deriveQuestionId(question: string): string {
  let h = 0;
  for (let i = 0; i < question.length; i++) {
    h = (h * 31 + question.charCodeAt(i)) >>> 0;
  }
  return `q_${h.toString(36)}`;
}

function parseAskUserBody(body: string): IdeaQuestion | null {
  const trimmed = body
    .trim()
    .replace(/^```(?:json)?\s*\n?|\n?```\s*$/g, "")
    .trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (
    parsed &&
    typeof parsed === "object" &&
    !(parsed as { id?: unknown }).id &&
    typeof (parsed as { question?: unknown }).question === "string"
  ) {
    (parsed as { id: string }).id = deriveQuestionId(
      (parsed as { question: string }).question,
    );
  }
  const safe = IdeaQuestionSchema.safeParse(parsed);
  return safe.success ? safe.data : null;
}

function makeAskUserSplitter() {
  const KEEP = Math.max(ASK_USER_OPEN.length, ASK_USER_CLOSE.length) - 1;
  let buf = "";
  let inside = false;
  let inner = "";

  function* drain(): Generator<HelperStreamEvent> {
    while (true) {
      if (!inside) {
        const i = buf.indexOf(ASK_USER_OPEN);
        if (i >= 0) {
          if (i > 0) yield { kind: "text", delta: buf.slice(0, i) };
          buf = buf.slice(i + ASK_USER_OPEN.length);
          inside = true;
          inner = "";
          continue;
        }
        const safe = Math.max(0, buf.length - KEEP);
        if (safe > 0) {
          yield { kind: "text", delta: buf.slice(0, safe) };
          buf = buf.slice(safe);
        }
        return;
      }
      const j = buf.indexOf(ASK_USER_CLOSE);
      if (j >= 0) {
        inner += buf.slice(0, j);
        buf = buf.slice(j + ASK_USER_CLOSE.length);
        const q = parseAskUserBody(inner);
        inner = "";
        inside = false;
        if (q) yield { kind: "question", question: q };
        // Malformed blocks are silently swallowed — the operator never
        // sees raw markup and the agent will recover on the next turn.
        continue;
      }
      // Stash all but the last KEEP chars into `inner` so we can match
      // a close tag that lands across deltas. Don't flush as text —
      // we never want JSON leaking into the chat.
      const safe = Math.max(0, buf.length - KEEP);
      if (safe > 0) {
        inner += buf.slice(0, safe);
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
      // Flush any text outside a tag. If we ended mid-tag, drop the
      // partial body silently — better to lose a malformed question
      // than to leak raw markup into the persisted reply.
      if (!inside && buf.length > 0) {
        yield { kind: "text", delta: buf };
        buf = "";
      } else if (inside) {
        inner = "";
        inside = false;
        buf = "";
      }
    },
  };
}

function makeInstructionsSplitter() {
  return makeTagSplitter(
    "<instructions>",
    "</instructions>",
    "instructions_delta",
  );
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
      thinkingLevel?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
    }
  | {
      action: "custom";
      prompt: string;
      agent?: "claude" | "codex";
      model?: string;
      thinkingLevel?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
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
      stdin: "ignore",
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
  source: "claude" | "codex" | "fallback";
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
      stdin: "ignore",
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
          source: opts.helper?.agent ?? "claude",
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

/**
 * Conventional branch prefixes the auto-namer is allowed to choose from.
 * Kept tight on purpose — the prefix is a coarse hint, not a taxonomy.
 * The web prefix-chip UI mirrors this list (plus a manual `wip` chip
 * the AI never picks for itself).
 */
export const BRANCH_PREFIXES = ["feature", "fix", "refactor", "chore"] as const;
export type BranchPrefix = (typeof BRANCH_PREFIXES)[number];

export interface BranchNameResult {
  /** Conventional prefix inferred from the prompt (feature/fix/…). */
  prefix: BranchPrefix;
  /** Generated kebab-case slug, no prefix (e.g. "worktree-option"). */
  slug: string;
  source: "claude" | "codex" | "fallback";
  error?: string;
}

/**
 * Cheap heuristic prefix: "fix the X bug" → fix, "refactor Y" → refactor,
 * "chore: bump deps" → chore, anything else → feature. Used both as the
 * fallback when the AI helper is unavailable AND as a sanity-check
 * against an AI response that returns an off-list prefix.
 */
function heuristicPrefix(prompt: string): BranchPrefix {
  const p = prompt.toLowerCase();
  if (/\b(fix|bug|broken|crash|regression|hotfix|patch)\b/.test(p)) return "fix";
  if (/\brefactor(?:ing)?\b|\brewrite\b|\brestructure\b|\bcleanup\b/.test(p))
    return "refactor";
  if (/\bchore\b|\bbump\b|\bdeps?\b|\bdependenc(?:y|ies)\b|\bupgrade\b/.test(p))
    return "chore";
  return "feature";
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
 * Stream a draft set of "project instructions" — concise, agent-facing
 * guidance lines an operator can persist on a project. Either greenfield
 * (from a one-line description) or "improve" mode (start from existing
 * draft + a tweak request). Yields raw stdout chunks so the UI can render
 * progressively; returns the full text on completion.
 */
export async function* streamProjectInstructionsDraft(
  cwd: string,
  opts: {
    description: string;
    existing?: string;
    helper?: AiHelperOptions;
  },
): AsyncGenerator<string, { text: string; source: string }, void> {
  const desc = opts.description.trim().slice(0, 1200);
  const existing = (opts.existing ?? "").trim().slice(0, 2000);
  const mode = existing ? "improve" : "draft";
  const lines = [
    `You are drafting "project instructions" — short, agent-facing rules`,
    `that will be prepended to every coding-agent task spawned in this`,
    `project. Think AGENTS.md / CLAUDE.md but tighter.`,
    ``,
    `OUTPUT FORMAT — strict:`,
    `  - 4 to 10 bullet lines, each starting with "- ".`,
    `  - Each bullet: one rule, imperative, under 110 chars, no fluff.`,
    `  - No preamble, no headers, no closing summary. Bullets only.`,
    `  - Cover what matters: tooling/runtimes, conventions to respect,`,
    `    things to never do, when to ask before acting, test/lint`,
    `    expectations. Skip anything obvious from the code itself.`,
    ``,
    mode === "improve"
      ? `Current draft (revise; keep what's good, drop weak rules, tighten phrasing, add gaps):\n${existing}\n`
      : ``,
    `Operator's description of the project / what matters here:`,
    desc || "(none provided — infer from cwd path)",
    ``,
    `cwd: ${cwd}`,
  ];
  const ask = lines.filter(Boolean).join("\n");
  const argv = buildAiHelperArgv(opts.helper ?? {}, ask);
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn({
      cmd: argv,
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: process.env as Record<string, string>,
    });
  } catch (e) {
    return { text: "", source: `error:${(e as Error).message}` };
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
  // Strip code-fence wrappers and stray pre/post text — keep only the
  // bullet block. The model occasionally adds a one-liner intro.
  const cleaned = raw
    .replace(/^```[a-zA-Z]*\n?|```$/gm, "")
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0)
    .join("\n")
    .trim();
  return { text: cleaned, source: mode };
}

/**
 * Ask Claude for a tight branch name in `<prefix>/<slug>` form. The prefix
 * is constrained to the conventional set ({@link BRANCH_PREFIXES}) so the
 * caller can trust it without further validation. Falls back to a
 * heuristic-prefixed deterministic slug when Claude is unavailable or
 * returns garbage.
 */
export async function generateBranchName(
  prompt: string,
  opts: { helper?: AiHelperOptions } = {},
): Promise<BranchNameResult> {
  const trimmed = prompt.trim();
  if (!trimmed) return { prefix: "feature", slug: "task", source: "fallback" };
  const ask =
    `Suggest a conventional git branch name for this task in the form <prefix>/<slug>.\n\n` +
    `Rules:\n` +
    `  - prefix MUST be exactly one of: feature, fix, refactor, chore.\n` +
    `      • fix      — bug fixes, regressions, broken behavior\n` +
    `      • refactor — restructuring without behavior change\n` +
    `      • chore    — deps bumps, tooling, housekeeping\n` +
    `      • feature  — anything else (new functionality, enhancements)\n` +
    `  - slug is kebab-case, 2-5 words, under 35 chars, lowercase letters/digits/hyphens only.\n` +
    `  - Output ONLY <prefix>/<slug>. No quotes, no backticks, no extra text.\n\n` +
    `Task: ${trimmed.slice(0, 800)}`;
  const argv = buildAiHelperArgv(opts.helper ?? {}, ask);
  const fallbackPrefix = heuristicPrefix(trimmed);
  try {
    const proc = Bun.spawn({
      cmd: argv,
      cwd: process.cwd(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: process.env as Record<string, string>,
    });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) {
      return {
        prefix: fallbackPrefix,
        slug: deterministicSlug(trimmed),
        source: "fallback",
        error: `helper exited ${code}`,
      };
    }
    const raw = out
      .trim()
      .replace(/^```[a-z]*\n?|```$/g, "")
      .replace(/^["'`]|["'`]$/g, "")
      .trim()
      .toLowerCase();
    // Split off the prefix if the model gave us one. We accept any
    // single-segment prefix, then validate it against the allowlist —
    // anything off-list (or no prefix at all) defers to the heuristic.
    const slashIdx = raw.indexOf("/");
    let aiPrefix: string | null = null;
    let slugPart = raw;
    if (slashIdx > 0) {
      aiPrefix = raw.slice(0, slashIdx);
      slugPart = raw.slice(slashIdx + 1);
    }
    const prefix: BranchPrefix = (BRANCH_PREFIXES as readonly string[]).includes(
      aiPrefix ?? "",
    )
      ? (aiPrefix as BranchPrefix)
      : fallbackPrefix;
    const cleaned = slugPart
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
    if (!cleaned)
      return {
        prefix: fallbackPrefix,
        slug: deterministicSlug(trimmed),
        source: "fallback",
      };
    return { prefix, slug: cleaned, source: opts.helper?.agent ?? "claude" };
  } catch (e) {
    return {
      prefix: fallbackPrefix,
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
