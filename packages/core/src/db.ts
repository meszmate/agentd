import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
  sqliteTable,
  text,
  integer,
} from "drizzle-orm/sqlite-core";

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  agent: text("agent").notNull(),
  repoPath: text("repo_path").notNull(),
  worktreePath: text("worktree_path").notNull(),
  branch: text("branch").notNull(),
  baseBranch: text("base_branch").notNull(),
  status: text("status").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  templateId: text("template_id"),
  scheduleId: text("schedule_id"),
  projectId: text("project_id"),
  autoPush: integer("auto_push").notNull().default(0),
  autoPr: integer("auto_pr").notNull().default(0),
  /**
   * Whether the post-turn hook should auto-commit any uncommitted
   * work at the end of every agent turn. Defaults to 1 (true) to
   * preserve historical behavior — disable when the operator wants
   * to hand-craft the commit themselves.
   */
  autoCommit: integer("auto_commit").notNull().default(1),
  prUrl: text("pr_url"),
  /**
   * Codex thread/session id — captured on the first codex turn from
   * the `thread.started` stream event, then passed to subsequent
   * `codex exec resume <id>` calls so each steer keeps the prior
   * context instead of re-initializing.
   */
  codexThreadId: text("codex_thread_id"),
  totalInputTokens: integer("total_input_tokens").notNull().default(0),
  totalOutputTokens: integer("total_output_tokens").notNull().default(0),
  totalCacheReadTokens: integer("total_cache_read_tokens").notNull().default(0),
  totalCacheWriteTokens: integer("total_cache_write_tokens").notNull().default(0),
  totalCostUsd: text("total_cost_usd"),
  skillsJson: text("skills_json").notNull().default("[]"),
  permissionMode: text("permission_mode").notNull().default("bypassPermissions"),
  workspaceMode: text("workspace_mode").notNull().default("worktree"),
  thinkingLevel: text("thinking_level").notNull().default("high"),
  model: text("model").notNull().default(""),
  mirrorTo: text("mirror_to"),
  councilId: text("council_id"),
  closedAt: integer("closed_at"),
  closedReason: text("closed_reason"),
  /**
   * Operator-defined sort order. Tasks with NULL sortOrder fall
   * back to updatedAt-based ordering. Drag-drop reorder in the
   * sidebar persists explicit values here.
   */
  sortOrder: integer("sort_order"),
  /**
   * Timestamp of the last `/compact`. Used by the web to draw a
   * "context compacted at HH:MM" divider in the timeline so the
   * operator can see which messages are still in the agent's
   * working memory vs. ones that have been summarized away.
   */
  lastCompactedAt: integer("last_compacted_at"),
  /**
   * Discord thread spawned for this task when the parent project
   * has `autoTaskThread` enabled. Cleared on archive.
   */
  discordThreadId: text("discord_thread_id"),
  /**
   * When set, the task waits for `dependsOnTaskId` to reach status
   * `done` before its runner spawns. Powers plan-slice chains: each
   * sibling executes after the previous one commits + pushes on the
   * shared branch.
   */
  dependsOnTaskId: text("depends_on_task_id"),
  /**
   * Group key shared by every sibling task that came from the same
   * plan-slice spawn. NULL for solo tasks.
   */
  planGroupId: text("plan_group_id"),
  /**
   * Tokens from the runner's most recent `usage` event. Replaced (not
   * summed) on every turn — this is the live context-size indicator
   * the web app uses for the compact-banner. The cumulative
   * `totalInputTokens` / `totalOutputTokens` columns above are the
   * billing-style running totals.
   */
  latestTurnInputTokens: integer("latest_turn_input_tokens"),
  latestTurnOutputTokens: integer("latest_turn_output_tokens"),
  /**
   * When the task came from a GitHub issue, the issue number. Surfaced
   * in the task header as a deep-link back to the issue and (alongside
   * `githubPr`) keys the PR action bar visibility.
   */
  githubIssue: integer("github_issue"),
  /**
   * When the task came from a GitHub PR, the PR number. Triggers a
   * `gh pr checkout <n>` step during worktree setup so the agent lands
   * on the PR's branch, and unlocks the PR action bar (Comment /
   * Approve / Request changes / Merge) on the task detail view.
   */
  githubPr: integer("github_pr"),
  /**
   * Live PR state ("OPEN" / "CLOSED" / "MERGED") refreshed from
   * `gh pr view` on spawn, after each PR action, and on github tab
   * reload. NULL when the task isn't a PR task or hasn't been refreshed
   * yet. Drives the lifecycle icon shown next to the task title.
   */
  githubPrState: text("github_pr_state"),
  /** True when the PR is marked draft on github.com. */
  githubPrIsDraft: integer("github_pr_is_draft"),
  /** Live issue state ("OPEN" / "CLOSED"); same refresh triggers as PR state. */
  githubIssueState: text("github_issue_state"),
});

/**
 * Project-scoped idea library. An idea is a first-class object with
 * a lifecycle (draft → refining → validated → spawned/archived) and
 * its own conversation thread (`ideaMessages` table) where the
 * operator and the agent can question and refine the idea before it
 * turns into a real task. Brainstorm options auto-create draft
 * ideas; the operator can also create freeform ideas by hand.
 *
 * Table name is `saved_ideas` for migration compatibility — the
 * column has been growing in place since v1.
 */
export const savedIdeas = sqliteTable("saved_ideas", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  /** Suggestion the idea was starred from, when applicable. */
  suggestionId: text("suggestion_id"),
  /** Index inside the parent suggestion's options[]. NULL when freeform. */
  optionIndex: integer("option_index"),
  /** One-line title — the searchable, sortable headline. */
  text: text("text").notNull(),
  /**
   * Longer body the operator (or agent) refined. Optional. When
   * empty, the workshop falls back to `text` as the description.
   */
  description: text("description"),
  /**
   * Workflow status. `draft` is the default for brand-new ideas,
   * `refining` once a conversation has started, `validated` when the
   * operator has decided to ship it, `spawned` after a task fires,
   * and `archived` for rejected / superseded ideas.
   */
  status: text("status").notNull().default("draft"),
  /** Comma-separated tag list — kept simple to avoid a join table. */
  tagsCsv: text("tags_csv"),
  /** Optional pre-generated plan blob the operator hand-edited and stashed. */
  planDraft: text("plan_draft"),
  /**
   * JSON-encoded `PlanSlice[]`. NULL when the operator hasn't split
   * the plan into executable slices yet. The planner can pre-fill
   * this; the operator can edit before spawning. Empty array means
   * "explicitly cleared" — same UI behavior as NULL.
   */
  planSlices: text("plan_slices"),
  savedAt: integer("saved_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  /** Filled when the operator finally spawned a task from this idea. */
  spawnedTaskId: text("spawned_task_id"),
  spawnedAt: integer("spawned_at"),
});

/**
 * One message in an idea's conversation thread. Conversational
 * refinement: the operator asks questions ("what's the risk here?",
 * "compare this to X"), the agent answers (streamed, repo-aware),
 * the agent can also self-critique on demand. Messages are append-
 * only and ordered by createdAt.
 */
export const ideaMessages = sqliteTable("idea_messages", {
  id: text("id").primaryKey(),
  ideaId: text("idea_id").notNull(),
  role: text("role").notNull(), // "user" | "agent" | "system"
  content: text("content").notNull(),
  /**
   * Tool-call events captured during the agent's turn — persisted as
   * a JSON array of `HelperStreamEvent`. Lets the workshop replay
   * the activity timeline (Read/Glob/Grep/Bash) even after a reload,
   * matching how task timelines show their history.
   */
  eventsJson: text("events_json"),
  createdAt: integer("created_at").notNull(),
});

export const todos = sqliteTable("todos", {
  id: text("id").primaryKey(),
  projectId: text("project_id"),
  taskId: text("task_id"),
  text: text("text").notNull(),
  status: text("status").notNull().default("pending"),
  source: text("source").notNull().default("user"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  completedAt: integer("completed_at"),
});

export const suggestions = sqliteTable("suggestions", {
  id: text("id").primaryKey(),
  templateId: text("template_id"),
  projectId: text("project_id"),
  title: text("title").notNull(),
  prompt: text("prompt").notNull(),
  optionsJson: text("options_json").notNull().default("[]"),
  status: text("status").notNull().default("pending"),
  createdAt: integer("created_at").notNull(),
  resolvedAt: integer("resolved_at"),
  chosenIndex: integer("chosen_index"),
  chosenText: text("chosen_text"),
  spawnedTaskId: text("spawned_task_id"),
  /**
   * Tool-call events the agent fired while drafting these options
   * (Read / Glob / Grep / Bash). Persisted so the brainstorm view
   * can replay "what the agent did" after reload, not just during
   * the live stream. Same shape as `idea_messages.events_json`.
   */
  eventsJson: text("events_json"),
  /**
   * Second-opinion scores from other AI raters. Each entry: agent +
   * model + index-aligned scores. Lets the operator triangulate
   * across raters; the workshop sorts / filters using the average
   * across all available raters (original + validations).
   */
  validationsJson: text("validations_json"),
  /** Wall-clock duration of the brainstorm helper run in ms. */
  durationMs: integer("duration_ms"),
  /** Tokens the helper consumed across the whole turn (claude only). */
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
});

export const councils = sqliteTable("councils", {
  id: text("id").primaryKey(),
  projectId: text("project_id"),
  repoPath: text("repo_path").notNull(),
  baseBranch: text("base_branch").notNull(),
  prompt: text("prompt").notNull(),
  status: text("status").notNull().default("running"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  winnerTaskId: text("winner_task_id"),
  judgeExplanation: text("judge_explanation"),
});

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  path: text("path").notNull().unique(),
  color: text("color"),
  createdAt: integer("created_at").notNull(),
  lastActiveAt: integer("last_active_at").notNull(),
  /**
   * Per-project free-text guidance — like an AGENTS.md file but
   * stored in the daemon DB so it never gets committed. Prepended
   * to every task's appendSystemPrompt for this project. Editable
   * from the web UI and from the agent itself via
   * `agentd-instructions write "<text>"`.
   */
  instructions: text("instructions"),
  /**
   * When 0, the project's instructions are kept in the DB but NOT
   * prepended to spawn prompts. Lets the operator turn instructions
   * off for a while without losing the draft. Defaults to 1.
   */
  instructionsEnabled: integer("instructions_enabled").notNull().default(1),
  /**
   * 1 = brainstorm suggestions get pushed to the chat plugins
   * (telegram / discord) for this project. Default 0: chats stay
   * quiet unless the operator explicitly opts in. Plugin commands
   * (`/brainstorm`, `/plan`, …) work regardless of this flag —
   * those are user-initiated, not auto-pushes.
   */
  notifySuggestions: integer("notify_suggestions").notNull().default(0),
  /** Per-project Telegram bot — separate DM channel per project. */
  telegramBotToken: text("telegram_bot_token"),
  telegramChatId: text("telegram_chat_id"),
  /** Per-project Discord channel — single bot, channel-routed. */
  discordChannelId: text("discord_channel_id"),
  /** When 1, every task in this project spawns its own Discord thread. */
  autoTaskThread: integer("auto_task_thread").notNull().default(0),
  /**
   * Per-project auto-brainstorm config. JSON blob of `BrainstormAuto`
   * (see contracts) — generator agent/model, validator list, score
   * threshold, cron schedule. NULL means auto-brainstorm is off for
   * this project. The cron tick reads it once per minute.
   */
  brainstormAutoJson: text("brainstorm_auto_json"),
  /**
   * Resolved `owner/repo` from `gh repo view --json nameWithOwner`.
   * Cached on the row the first time the GitHub status probe runs so
   * subsequent issue/PR calls don't re-query gh just to learn the slug.
   * NULL means either the repo has no GitHub remote or `gh` hasn't
   * resolved one yet.
   */
  githubRepo: text("github_repo"),
  /**
   * Cached open issue / PR counts for the GitHub remote. NULL until the
   * first `gh` probe. Refreshed on the `github/refresh` endpoint, on PR
   * actions, on spawn, and lazily when the projects list is fetched.
   * Surfaced as tiny badges on each sidebar project row.
   */
  openIssueCount: integer("open_issue_count"),
  openPrCount: integer("open_pr_count"),
  githubCountsAt: integer("github_counts_at"),
});

export const templates = sqliteTable("templates", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  agent: text("agent").notNull(),
  /**
   *   task     — schedule fires → spawn an agent task.
   *   ideation — schedule fires → run an AI helper, parse N options,
   *              ask the operator (chat + web inbox) to pick one.
   */
  kind: text("kind").notNull().default("task"),
  /**
   * Either a saved project's id (preferred — repoPath stays in sync if
   * the project is renamed/relocated) or empty + a literal repoPath.
   * Templates resolve repoPath at run time: project lookup wins.
   */
  projectId: text("project_id"),
  repoPath: text("repo_path").notNull(),
  baseBranch: text("base_branch").notNull(),
  promptTemplate: text("prompt_template").notNull(),
  autoPush: integer("auto_push").notNull().default(0),
  autoPr: integer("auto_pr").notNull().default(0),
  /** Per-task knobs the template carries forward; same vocab as Task. */
  permissionMode: text("permission_mode").notNull().default("bypassPermissions"),
  thinkingLevel: text("thinking_level").notNull().default("high"),
  model: text("model").notNull().default(""),
  workspaceMode: text("workspace_mode").notNull().default("worktree"),
  branchMode: text("branch_mode").notNull().default("new"),
  pullLatest: integer("pull_latest").notNull().default(0),
  skillsJson: text("skills_json").notNull().default("[]"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const schedules = sqliteTable("schedules", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  cron: text("cron").notNull(),
  templateId: text("template_id").notNull(),
  templateArgsJson: text("template_args_json").notNull().default("{}"),
  enabled: integer("enabled").notNull().default(1),
  lastRunAt: integer("last_run_at"),
  lastTaskId: text("last_task_id"),
  nextRunAt: integer("next_run_at"),
  createdAt: integer("created_at").notNull(),
});

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
  role: text("role").notNull(),
  content: text("content").notNull(),
  ts: integer("ts").notNull(),
});

export const permissionRequests = sqliteTable("permission_requests", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
  tool: text("tool").notNull(),
  argsJson: text("args_json").notNull(),
  status: text("status").notNull(),
  decidedAt: integer("decided_at"),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  deviceLabel: text("device_label").notNull(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at"),
  lastSeenAt: integer("last_seen_at"),
});

export const pairingTokens = sqliteTable("pairing_tokens", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  consumedAt: integer("consumed_at"),
});

export const chatLinks = sqliteTable("chat_links", {
  id: text("id").primaryKey(),
  platform: text("platform").notNull(),
  externalUserId: text("external_user_id").notNull(),
  sessionId: text("session_id").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const providerRateLimits = sqliteTable("provider_rate_limits", {
  provider: text("provider").primaryKey(),
  windowsJson: text("windows_json").notNull().default("{}"),
  updatedAt: integer("updated_at").notNull(),
});

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  agent TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  branch TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  template_id TEXT,
  schedule_id TEXT,
  auto_push INTEGER NOT NULL DEFAULT 0,
  auto_pr INTEGER NOT NULL DEFAULT 0,
  pr_url TEXT,
  codex_thread_id TEXT,
  total_input_tokens INTEGER NOT NULL DEFAULT 0,
  total_output_tokens INTEGER NOT NULL DEFAULT 0,
  total_cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  total_cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  total_cost_usd TEXT,
  skills_json TEXT NOT NULL DEFAULT '[]',
  project_id TEXT,
  permission_mode TEXT NOT NULL DEFAULT 'bypassPermissions',
  workspace_mode TEXT NOT NULL DEFAULT 'worktree',
  thinking_level TEXT NOT NULL DEFAULT 'high',
  model TEXT NOT NULL DEFAULT '',
  mirror_to TEXT,
  council_id TEXT,
  closed_at INTEGER,
  closed_reason TEXT,
  sort_order INTEGER,
  last_compacted_at INTEGER
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  color TEXT,
  created_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,
  instructions TEXT,
  instructions_enabled INTEGER NOT NULL DEFAULT 1,
  notify_suggestions INTEGER NOT NULL DEFAULT 0,
  telegram_bot_token TEXT,
  telegram_chat_id TEXT,
  discord_channel_id TEXT
);

CREATE TABLE IF NOT EXISTS councils (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  repo_path TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  winner_task_id TEXT,
  judge_explanation TEXT
);

CREATE TABLE IF NOT EXISTS todos (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  task_id TEXT,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  source TEXT NOT NULL DEFAULT 'user',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS todos_project_idx ON todos(project_id);
CREATE INDEX IF NOT EXISTS todos_task_idx ON todos(task_id);

CREATE TABLE IF NOT EXISTS suggestions (
  id TEXT PRIMARY KEY,
  template_id TEXT,
  project_id TEXT,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  options_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  chosen_index INTEGER,
  chosen_text TEXT,
  spawned_task_id TEXT
);

CREATE TABLE IF NOT EXISTS saved_ideas (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  suggestion_id TEXT,
  option_index INTEGER,
  text TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  tags_csv TEXT,
  plan_draft TEXT,
  saved_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT 0,
  spawned_task_id TEXT,
  spawned_at INTEGER
);

CREATE TABLE IF NOT EXISTS idea_messages (
  id TEXT PRIMARY KEY,
  idea_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  events_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  agent TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'task',
  project_id TEXT,
  repo_path TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  prompt_template TEXT NOT NULL,
  auto_push INTEGER NOT NULL DEFAULT 0,
  auto_pr INTEGER NOT NULL DEFAULT 0,
  permission_mode TEXT NOT NULL DEFAULT 'bypassPermissions',
  thinking_level TEXT NOT NULL DEFAULT 'high',
  model TEXT NOT NULL DEFAULT '',
  workspace_mode TEXT NOT NULL DEFAULT 'worktree',
  branch_mode TEXT NOT NULL DEFAULT 'new',
  pull_latest INTEGER NOT NULL DEFAULT 0,
  skills_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  cron TEXT NOT NULL,
  template_id TEXT NOT NULL,
  template_args_json TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at INTEGER,
  last_task_id TEXT,
  next_run_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_task_idx ON messages(task_id, ts);

CREATE TABLE IF NOT EXISTS permission_requests (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  args_json TEXT NOT NULL,
  status TEXT NOT NULL,
  decided_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  device_label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  last_seen_at INTEGER
);

CREATE TABLE IF NOT EXISTS pairing_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE TABLE IF NOT EXISTS chat_links (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  external_user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(platform, external_user_id)
);

CREATE TABLE IF NOT EXISTS provider_rate_limits (
  provider TEXT PRIMARY KEY,
  windows_json TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
);
`;

// Idempotent column additions for installs that pre-date a column.
// Each statement is wrapped in its own try/catch in `migrate()`.
const COLUMN_ADDITIONS: string[] = [
  "ALTER TABLE tasks ADD COLUMN template_id TEXT",
  "ALTER TABLE tasks ADD COLUMN schedule_id TEXT",
  "ALTER TABLE tasks ADD COLUMN auto_push INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE tasks ADD COLUMN auto_pr INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE tasks ADD COLUMN pr_url TEXT",
  "ALTER TABLE tasks ADD COLUMN total_input_tokens INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE tasks ADD COLUMN total_output_tokens INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE tasks ADD COLUMN total_cache_read_tokens INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE tasks ADD COLUMN total_cache_write_tokens INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE tasks ADD COLUMN total_cost_usd TEXT",
  "ALTER TABLE tasks ADD COLUMN skills_json TEXT NOT NULL DEFAULT '[]'",
  "ALTER TABLE tasks ADD COLUMN project_id TEXT",
  "ALTER TABLE tasks ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'bypassPermissions'",
  "ALTER TABLE tasks ADD COLUMN workspace_mode TEXT NOT NULL DEFAULT 'worktree'",
  "ALTER TABLE tasks ADD COLUMN thinking_level TEXT NOT NULL DEFAULT 'high'",
  "ALTER TABLE tasks ADD COLUMN model TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE tasks ADD COLUMN mirror_to TEXT",
  "ALTER TABLE tasks ADD COLUMN council_id TEXT",
  "ALTER TABLE tasks ADD COLUMN closed_at INTEGER",
  "ALTER TABLE tasks ADD COLUMN closed_reason TEXT",
  "ALTER TABLE templates ADD COLUMN project_id TEXT",
  "ALTER TABLE templates ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'bypassPermissions'",
  "ALTER TABLE templates ADD COLUMN thinking_level TEXT NOT NULL DEFAULT 'high'",
  "ALTER TABLE templates ADD COLUMN model TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE templates ADD COLUMN workspace_mode TEXT NOT NULL DEFAULT 'worktree'",
  "ALTER TABLE templates ADD COLUMN branch_mode TEXT NOT NULL DEFAULT 'new'",
  "ALTER TABLE templates ADD COLUMN pull_latest INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE templates ADD COLUMN skills_json TEXT NOT NULL DEFAULT '[]'",
  "ALTER TABLE templates ADD COLUMN kind TEXT NOT NULL DEFAULT 'task'",
  "ALTER TABLE tasks ADD COLUMN sort_order INTEGER",
  "ALTER TABLE projects ADD COLUMN instructions TEXT",
  "ALTER TABLE tasks ADD COLUMN last_compacted_at INTEGER",
  "ALTER TABLE projects ADD COLUMN telegram_bot_token TEXT",
  "ALTER TABLE projects ADD COLUMN telegram_chat_id TEXT",
  "ALTER TABLE projects ADD COLUMN discord_channel_id TEXT",
  "ALTER TABLE projects ADD COLUMN auto_task_thread INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE tasks ADD COLUMN discord_thread_id TEXT",
  "ALTER TABLE idea_messages ADD COLUMN events_json TEXT",
  "ALTER TABLE saved_ideas ADD COLUMN description TEXT",
  "ALTER TABLE saved_ideas ADD COLUMN status TEXT NOT NULL DEFAULT 'draft'",
  "ALTER TABLE saved_ideas ADD COLUMN tags_csv TEXT",
  "ALTER TABLE saved_ideas ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE suggestions ADD COLUMN events_json TEXT",
  "ALTER TABLE suggestions ADD COLUMN validations_json TEXT",
  "ALTER TABLE projects ADD COLUMN brainstorm_auto_json TEXT",
  "ALTER TABLE suggestions ADD COLUMN duration_ms INTEGER",
  "ALTER TABLE suggestions ADD COLUMN input_tokens INTEGER",
  "ALTER TABLE suggestions ADD COLUMN output_tokens INTEGER",
  "ALTER TABLE tasks ADD COLUMN auto_commit INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE projects ADD COLUMN instructions_enabled INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE tasks ADD COLUMN codex_thread_id TEXT",
  "ALTER TABLE projects ADD COLUMN notify_suggestions INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE saved_ideas ADD COLUMN plan_slices TEXT",
  "ALTER TABLE tasks ADD COLUMN depends_on_task_id TEXT",
  "ALTER TABLE tasks ADD COLUMN plan_group_id TEXT",
  "ALTER TABLE tasks ADD COLUMN latest_turn_input_tokens INTEGER",
  "ALTER TABLE tasks ADD COLUMN latest_turn_output_tokens INTEGER",
  "ALTER TABLE projects ADD COLUMN github_repo TEXT",
  "ALTER TABLE tasks ADD COLUMN github_issue INTEGER",
  "ALTER TABLE tasks ADD COLUMN github_pr INTEGER",
  "ALTER TABLE projects ADD COLUMN open_issue_count INTEGER",
  "ALTER TABLE projects ADD COLUMN open_pr_count INTEGER",
  "ALTER TABLE projects ADD COLUMN github_counts_at INTEGER",
  "ALTER TABLE tasks ADD COLUMN github_pr_state TEXT",
  "ALTER TABLE tasks ADD COLUMN github_pr_is_draft INTEGER",
  "ALTER TABLE tasks ADD COLUMN github_issue_state TEXT",
];

function migrate(sqlite: Database): void {
  for (const stmt of COLUMN_ADDITIONS) {
    try {
      sqlite.exec(stmt);
    } catch (e) {
      const msg = (e as Error).message;
      if (!/duplicate column name/i.test(msg)) throw e;
    }
  }
}

export type Db = ReturnType<typeof drizzle>;

export function openDb(path: string): { sqlite: Database; db: Db } {
  const sqlite = new Database(path);
  sqlite.exec("PRAGMA journal_mode = WAL;");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  sqlite.exec(SCHEMA_SQL);
  migrate(sqlite);
  const db = drizzle(sqlite);
  return { sqlite, db };
}
