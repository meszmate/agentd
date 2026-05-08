import type { Trigger } from "@agentd/contracts";
import {
  type Db,
  listTriggers,
  setTriggerError,
  clearTriggerError,
} from "@agentd/core";

/**
 * Concurrency cap for github-poll evaluations in a single tick. A user
 * with 100 github triggers shouldn't fire 100 parallel `gh` calls and
 * burn the rate-limit budget — chunk them small. Datetime/webhook
 * checks are pure-memory so they don't count.
 */
const GITHUB_EVAL_CONCURRENCY = 8;

export interface TriggerEvaluatorDeps {
  db: Db;
  /** Wall-clock used as the reference for datetime/webhook checks. */
  now?: number;
}

/**
 * Returns the trigger ids that are ready to fire on this tick. Caller
 * is responsible for spawning tasks and recording the fire.
 *
 * Per-trigger evaluation is wrapped in try/catch — a single bad
 * github call must not poison the whole pass. Errors increment the
 * trigger's `errorCount`; once a threshold is reached the trigger
 * auto-disables (handled inside `setTriggerError`).
 */
export async function evaluateTriggers(
  deps: TriggerEvaluatorDeps,
): Promise<string[]> {
  const { db } = deps;
  const now = deps.now ?? Date.now();
  const all = listTriggers(db).filter((t) => t.enabled);

  const ready: string[] = [];

  // Datetime / webhook checks are O(1) — just look at the row.
  const githubQueue: Trigger[] = [];
  for (const t of all) {
    const cfg = t.predicateConfig;
    if (cfg.kind === "datetime") {
      if (now >= cfg.fireAt) ready.push(t.id);
      continue;
    }
    if (cfg.kind === "webhook") {
      if (cfg.readyAt != null) ready.push(t.id);
      continue;
    }
    if (
      cfg.kind === "github_pr_merged" ||
      cfg.kind === "github_issue_closed"
    ) {
      githubQueue.push(t);
      continue;
    }
  }

  // Run github polls in bounded-concurrency batches so a long list
  // doesn't fan out to hundreds of `gh` subprocesses at once.
  for (let i = 0; i < githubQueue.length; i += GITHUB_EVAL_CONCURRENCY) {
    const batch = githubQueue.slice(i, i + GITHUB_EVAL_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (t) => {
        try {
          const fired = await evalGithub(t);
          if (fired) {
            // Successful eval — clear any prior error so a transient
            // failure doesn't hold the auto-disable threshold open.
            clearTriggerError(db, t.id);
            return t.id;
          }
          if (t.lastError) clearTriggerError(db, t.id);
          return null;
        } catch (e) {
          setTriggerError(db, t.id, (e as Error).message);
          return null;
        }
      }),
    );
    for (const id of results) {
      if (id) ready.push(id);
    }
  }

  return ready;
}

async function evalGithub(t: Trigger): Promise<boolean> {
  const cfg = t.predicateConfig;
  if (cfg.kind === "github_pr_merged") {
    const state = await ghPrState(cfg.owner, cfg.repo, cfg.number);
    return state === "MERGED";
  }
  if (cfg.kind === "github_issue_closed") {
    const state = await ghIssueState(cfg.owner, cfg.repo, cfg.number);
    return state === "CLOSED";
  }
  return false;
}

async function ghPrState(
  owner: string,
  repo: string,
  number: number,
): Promise<string> {
  const out = await runGh([
    "pr",
    "view",
    String(number),
    "--repo",
    `${owner}/${repo}`,
    "--json",
    "state",
  ]);
  const parsed = JSON.parse(out) as { state?: string };
  return parsed.state ?? "";
}

async function ghIssueState(
  owner: string,
  repo: string,
  number: number,
): Promise<string> {
  const out = await runGh([
    "issue",
    "view",
    String(number),
    "--repo",
    `${owner}/${repo}`,
    "--json",
    "state",
  ]);
  const parsed = JSON.parse(out) as { state?: string };
  return parsed.state ?? "";
}

async function runGh(args: string[]): Promise<string> {
  let proc;
  try {
    proc = Bun.spawn({
      cmd: ["gh", ...args],
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: process.env,
    });
  } catch (e) {
    throw new Error(`gh not available: ${(e as Error).message}`);
  }
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `gh exited ${exitCode}`);
  }
  return stdout;
}
