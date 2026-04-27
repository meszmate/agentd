import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export interface AgentdPaths {
  root: string;
  data: string;
  worktrees: string;
  db: string;
}

export function resolvePaths(rootOverride?: string): AgentdPaths {
  const root = rootOverride ?? join(homedir(), ".agentd");
  const data = join(root, "data");
  const worktrees = join(root, "worktrees");
  const db = join(data, "agentd.db");
  return { root, data, worktrees, db };
}

export function ensurePaths(p: AgentdPaths): void {
  mkdirSync(p.data, { recursive: true });
  mkdirSync(p.worktrees, { recursive: true });
}
