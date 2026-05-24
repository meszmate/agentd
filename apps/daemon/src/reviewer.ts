import type { AgentKind, ReviewReport, Task } from "@agentd/contracts";
import { ReviewReport as ReviewReportSchema } from "@agentd/contracts";
import {
  diffAgainst,
  loadConfig,
  runHelperOneshot,
  type AgentdPaths,
  type AiHelperOptions,
} from "@agentd/core";

const REVIEW_SYSTEM_PROMPT = `You are an adversarial code reviewer.

A different AI agent just committed work onto a task branch. Your job is to
read the diff, think hard about correctness, design, security, and
regressions, and emit a structured verdict.

You are NOT the implementer. Do not propose code. Do not write files. Do
not run commands. Read the diff that follows in this prompt and write a
review.

Be specific. Cite file paths and line numbers when flagging an issue.
Surface security risks, hidden behaviour changes, and regressions before
stylistic nits.

Verdict semantics:
  approved         — diff is correct and ready to ship as-is
  request_changes  — non-blocking concerns the operator should know
  blocked          — a hard problem; do not open a PR until fixed
  error            — reserved for the daemon; never emit this yourself

End your reply with a fenced JSON code block (and nothing after it) that
matches this shape exactly:

\`\`\`json
{
  "verdict": "approved | request_changes | blocked",
  "summary": "one-line summary suitable for a badge popover",
  "blockingIssues": ["..."],
  "suggestions": ["..."]
}
\`\`\`

Rules for the JSON block:
  - "verdict" MUST be one of the three literal strings above.
  - "blockingIssues" MUST be empty when verdict is "approved".
  - Keep "summary" under 240 characters.
  - "blockingIssues" and "suggestions" are arrays of plain strings.

Write your reasoning above the JSON block in prose. The JSON block must
be the LAST content in your reply.`;

interface RunReviewParams {
  task: Task;
  paths: AgentdPaths;
}

export interface RunReviewResult {
  report: ReviewReport;
  agent: AgentKind;
  model: string;
}

/**
 * Spawn the adversarial reviewer against the committed diff and return
 * a parsed verdict. Never throws — failure modes resolve as
 * `verdict: "error"` so the caller can persist a row and let the
 * operator decide whether to override.
 */
export async function runAdversarialReview({
  task,
  paths,
}: RunReviewParams): Promise<RunReviewResult> {
  const cfg = loadConfig(paths.root);
  const review = cfg.review;
  const agent: AgentKind = review.agent;
  const model = review.model.trim() || cfg.defaultModel?.[agent] || "";

  let diffSection = "(no diff available)";
  let truncated = false;
  try {
    const baseRef = task.baseCommitSha || task.baseBranch || "HEAD";
    const result = await diffAgainst(task.worktreePath, baseRef);
    let diff = result.diff || "";
    if (diff.length > review.maxDiffBytes) {
      diff = diff.slice(0, review.maxDiffBytes);
      truncated = true;
    }
    if (diff.trim().length === 0) {
      diffSection = `(no diff against ${baseRef}; the auto-commit hook ran but produced nothing for the reviewer to read)`;
    } else {
      diffSection = diff;
    }
  } catch (e) {
    diffSection = `(failed to compute diff: ${(e as Error).message})`;
  }

  const prompt = [
    REVIEW_SYSTEM_PROMPT,
    "",
    `Task title: ${task.title}`,
    `Branch: ${task.branch} (base: ${task.baseBranch})`,
    truncated
      ? `Diff (TRUNCATED at ${review.maxDiffBytes} bytes — flag this in your verdict if the truncation hides critical context):`
      : "Diff:",
    "",
    diffSection,
  ].join("\n");

  const helper: AiHelperOptions = {
    agent,
    effort: review.thinkingLevel,
  };
  if (model) helper.model = model;

  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  let timedOut = false;
  try {
    const r = await runHelperOneshot({
      helper,
      prompt,
      cwd: task.worktreePath,
      timeoutMs: review.timeoutMs,
    });
    stdout = r.stdout;
    stderr = r.stderr;
    exitCode = r.exitCode;
    timedOut = r.timedOut;
  } catch (e) {
    return {
      report: {
        verdict: "error",
        summary: `reviewer crashed: ${(e as Error).message}`,
        blockingIssues: [],
        suggestions: [],
      },
      agent,
      model,
    };
  }

  if (timedOut) {
    return {
      report: {
        verdict: "error",
        summary: `reviewer timed out after ${Math.round(review.timeoutMs / 1000)}s`,
        blockingIssues: [],
        suggestions: [],
      },
      agent,
      model,
    };
  }

  if (exitCode !== 0 && !stdout.trim()) {
    return {
      report: {
        verdict: "error",
        summary: `reviewer exited with code ${exitCode}: ${stderr.trim().slice(0, 200)}`,
        blockingIssues: [],
        suggestions: [],
      },
      agent,
      model,
    };
  }

  const parsed = parseReviewReport(stdout);
  if (!parsed) {
    return {
      report: {
        verdict: "error",
        summary: "reviewer produced no parseable JSON verdict",
        blockingIssues: [],
        suggestions: [],
      },
      agent,
      model,
    };
  }
  return { report: parsed, agent, model };
}

/**
 * Pull the LAST fenced ```json``` block out of the reviewer's reply and
 * validate it against `ReviewReport`. Tolerant of trailing whitespace
 * after the closing fence; rejects anything that doesn't schema-match.
 *
 * Exported for unit-style testing.
 */
export function parseReviewReport(text: string): ReviewReport | null {
  if (!text) return null;
  const fenced = /```json\s*\n([\s\S]*?)\n?```/gi;
  let last: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = fenced.exec(text)) !== null) {
    if (m[1]) last = m[1];
  }
  let candidate = last;
  if (!candidate) {
    // Some models forget the language tag — try a plain ``` block.
    const plain = /```\s*\n([\s\S]*?)\n?```/gi;
    while ((m = plain.exec(text)) !== null) {
      if (m[1] && m[1].includes('"verdict"')) candidate = m[1];
    }
  }
  if (!candidate) {
    // Last-ditch fallback: scan for a trailing JSON object literal.
    const start = text.lastIndexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end > start) candidate = text.slice(start, end + 1);
  }
  if (!candidate) return null;
  let json: unknown;
  try {
    json = JSON.parse(candidate.trim());
  } catch {
    return null;
  }
  const safe = ReviewReportSchema.safeParse(json);
  if (!safe.success) return null;
  if (safe.data.verdict === "approved") {
    safe.data.blockingIssues = [];
  }
  return safe.data;
}
