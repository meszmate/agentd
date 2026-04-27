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
  updated_at INTEGER NOT NULL
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

export type Db = ReturnType<typeof drizzle>;

export function openDb(path: string): { sqlite: Database; db: Db } {
  const sqlite = new Database(path);
  sqlite.exec("PRAGMA journal_mode = WAL;");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  sqlite.exec(SCHEMA_SQL);
  const db = drizzle(sqlite);
  return { sqlite, db };
}
