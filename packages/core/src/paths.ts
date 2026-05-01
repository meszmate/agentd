import { homedir } from "node:os";
import { join } from "node:path";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";

export interface AgentdPaths {
  root: string;
  data: string;
  worktrees: string;
  db: string;
  /** PATH-prepend dir for tools the daemon exposes to agent subprocesses. */
  bin: string;
}

export function resolvePaths(rootOverride?: string): AgentdPaths {
  const root = rootOverride ?? join(homedir(), ".agentd");
  const data = join(root, "data");
  const worktrees = join(root, "worktrees");
  const db = join(data, "agentd.db");
  const bin = join(root, "bin");
  return { root, data, worktrees, db, bin };
}

export function ensurePaths(p: AgentdPaths): void {
  mkdirSync(p.data, { recursive: true });
  mkdirSync(p.worktrees, { recursive: true });
  mkdirSync(p.bin, { recursive: true });
  writeAgentdProgressScript(p.bin);
}

/**
 * Write the `agentd-progress` shell wrapper into the daemon's bin
 * directory. Agent subprocesses get this dir prepended to their PATH so
 * they can always run `agentd-progress "<note>"` regardless of where
 * (or whether) the agentd CLI is installed on the host.
 *
 * The script reads AGENTD_TASK_ID / AGENTD_DAEMON_URL / AGENTD_TOKEN
 * from the environment (the daemon injects them at spawn time) and
 * POSTs to /api/tasks/:id/progress. `--done` flips the `done` flag.
 *
 * Overwriting on every daemon start is intentional — keeps the script
 * in lockstep with this codebase if it ever changes.
 */
function writeAgentdProgressScript(binDir: string): void {
  const path = join(binDir, "agentd-progress");
  const body = `#!/usr/bin/env bash
# agentd progress reporter — invoked by the running agent after every
# meaningful step. Quietly no-ops when the env vars aren't set so the
# script is safe to run from a regular shell.
#
# Usage: agentd-progress "<one-line summary>" [--done]
set -e
text=""
done="false"
for arg in "$@"; do
  case "$arg" in
    --done) done="true" ;;
    *) if [ -z "$text" ]; then text="$arg"; else text="$text $arg"; fi ;;
  esac
done
if [ -z "$text" ]; then
  echo "agentd-progress: usage: agentd-progress \\"<summary>\\" [--done]" >&2
  exit 2
fi
if [ -z "\${AGENTD_TASK_ID:-}" ] || [ -z "\${AGENTD_DAEMON_URL:-}" ] || [ -z "\${AGENTD_TOKEN:-}" ]; then
  echo "agentd-progress: AGENTD_TASK_ID / AGENTD_DAEMON_URL / AGENTD_TOKEN not set; skipping" >&2
  exit 0
fi
# JSON-escape: backslash, double-quote, newline. tab. carriage return.
escaped=\$(printf '%s' "\$text" | python3 -c 'import sys,json; sys.stdout.write(json.dumps(sys.stdin.read()))' 2>/dev/null) || \\
  escaped=\$(printf '%s' "\$text" | sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g' -e ':a;N;\$!ba;s/\\n/\\\\n/g')
curl -fsS -X POST \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer \${AGENTD_TOKEN}" \\
  -d "{\\"text\\":\${escaped},\\"done\\":\${done}}" \\
  "\${AGENTD_DAEMON_URL%/}/api/tasks/\${AGENTD_TASK_ID}/progress" >/dev/null || {
  echo "agentd-progress: post failed" >&2
  exit 0
}
`;
  writeFileSync(path, body);
  try {
    chmodSync(path, 0o755);
  } catch {
    // Best effort — Windows doesn't support chmod; the script still
    // runs through bash on WSL or Git Bash.
  }
}
