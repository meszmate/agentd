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
  prUrl: text("pr_url"),
  totalInputTokens: integer("total_input_tokens").notNull().default(0),
  totalOutputTokens: integer("total_output_tokens").notNull().default(0),
  totalCacheReadTokens: integer("total_cache_read_tokens").notNull().default(0),
  totalCacheWriteTokens: integer("total_cache_write_tokens").notNull().default(0),
  totalCostUsd: text("total_cost_usd"),
  skillsJson: text("skills_json").notNull().default("[]"),
  permissionMode: text("permission_mode").notNull().default("bypassPermissions"),
});

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  path: text("path").notNull().unique(),
  color: text("color"),
  createdAt: integer("created_at").notNull(),
  lastActiveAt: integer("last_active_at").notNull(),
});

export const templates = sqliteTable("templates", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  agent: text("agent").notNull(),
  repoPath: text("repo_path").notNull(),
  baseBranch: text("base_branch").notNull(),
  promptTemplate: text("prompt_template").notNull(),
  autoPush: integer("auto_push").notNull().default(0),
  autoPr: integer("auto_pr").notNull().default(0),
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
  total_input_tokens INTEGER NOT NULL DEFAULT 0,
  total_output_tokens INTEGER NOT NULL DEFAULT 0,
  total_cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  total_cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  total_cost_usd TEXT,
  skills_json TEXT NOT NULL DEFAULT '[]',
  project_id TEXT,
  permission_mode TEXT NOT NULL DEFAULT 'bypassPermissions'
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  color TEXT,
  created_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  agent TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  prompt_template TEXT NOT NULL,
  auto_push INTEGER NOT NULL DEFAULT 0,
  auto_pr INTEGER NOT NULL DEFAULT 0,
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
