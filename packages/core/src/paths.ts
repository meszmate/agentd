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
  writeAgentdShareScript(p.bin);
  writeAgentdAskScript(p.bin);
  writeAgentdInstructionsScript(p.bin);
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

/**
 * `agentd-share` — non-blocking thought broadcast. The agent calls it
 * when it wants the operator to see what it's *considering* before
 * committing to an action.
 *
 *   agentd-share "thinking we should refactor X first then Y"
 */
function writeAgentdShareScript(binDir: string): void {
  const path = join(binDir, "agentd-share");
  const body = `#!/usr/bin/env bash
# agentd thought broadcast — non-blocking.
set -e
text=""
for arg in "$@"; do
  if [ -z "$text" ]; then text="$arg"; else text="$text $arg"; fi
done
if [ -z "$text" ]; then
  echo "agentd-share: usage: agentd-share \\"<thought>\\"" >&2
  exit 2
fi
if [ -z "\${AGENTD_TASK_ID:-}" ] || [ -z "\${AGENTD_DAEMON_URL:-}" ] || [ -z "\${AGENTD_TOKEN:-}" ]; then
  echo "agentd-share: env not set; skipping" >&2
  exit 0
fi
escaped=\$(printf '%s' "\$text" | python3 -c 'import sys,json; sys.stdout.write(json.dumps(sys.stdin.read()))' 2>/dev/null) || \\
  escaped=\$(printf '%s' "\$text" | sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g' -e ':a;N;\$!ba;s/\\n/\\\\n/g')
curl -fsS -X POST \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer \${AGENTD_TOKEN}" \\
  -d "{\\"text\\":\${escaped}}" \\
  "\${AGENTD_DAEMON_URL%/}/api/tasks/\${AGENTD_TASK_ID}/share" >/dev/null || true
`;
  writeFileSync(path, body);
  try {
    chmodSync(path, 0o755);
  } catch {
    // best effort
  }
}

/**
 * `agentd-ask` — blocking decision request. The agent stops and waits
 * for the operator to pick a numbered option (or write a free-form
 * answer). When the operator replies via chat or web, the script
 * unblocks and prints the chosen text on stdout for the agent to read.
 *
 *   answer=$(agentd-ask "Which approach?" "rewrite" "refactor" "feature flag")
 *
 * Times out after 1h by default; override with AGENTD_ASK_TIMEOUT (sec).
 */
function writeAgentdAskScript(binDir: string): void {
  const path = join(binDir, "agentd-ask");
  const body = `#!/usr/bin/env bash
# agentd decision request — blocks until the operator picks an option.
# Writes the chosen text to stdout so the agent can capture it.
set -e
if [ "$#" -lt 1 ]; then
  echo "agentd-ask: usage: agentd-ask \\"<prompt>\\" [option1] [option2] ..." >&2
  exit 2
fi
prompt="$1"; shift
if [ -z "\${AGENTD_TASK_ID:-}" ] || [ -z "\${AGENTD_DAEMON_URL:-}" ] || [ -z "\${AGENTD_TOKEN:-}" ]; then
  echo "agentd-ask: env not set; skipping (default: first option or empty)" >&2
  if [ "$#" -gt 0 ]; then echo "$1"; fi
  exit 0
fi
# Build the JSON body via python (robust escaping for the prompt + each option).
body=\$(python3 -c '
import json, sys
prompt = sys.argv[1]
opts = sys.argv[2:]
print(json.dumps({"prompt": prompt, "options": opts}))
' "$prompt" "$@" 2>/dev/null)
if [ -z "$body" ]; then
  # Fallback if python3 missing — escape conservatively.
  body="{\\"prompt\\":\\"\${prompt//\\\\/\\\\\\\\}\\",\\"options\\":[]}"
fi
timeout=\${AGENTD_ASK_TIMEOUT:-3600}
resp=\$(curl -fsS --max-time "\$timeout" -X POST \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer \${AGENTD_TOKEN}" \\
  -d "\$body" \\
  "\${AGENTD_DAEMON_URL%/}/api/tasks/\${AGENTD_TASK_ID}/ask")
if [ -z "\$resp" ]; then
  echo "agentd-ask: empty response; assuming default" >&2
  if [ "$#" -gt 0 ]; then echo "$1"; fi
  exit 0
fi
# Pull the answer field out of the JSON.
echo "\$resp" | python3 -c 'import sys, json; print(json.loads(sys.stdin.read())["answer"])' 2>/dev/null || \\
  echo "\$resp" | sed -n 's/.*"answer":"\\([^"]*\\)".*/\\1/p'
`;
  writeFileSync(path, body);
  try {
    chmodSync(path, 0o755);
  } catch {
    // best effort
  }
}

/**
 * `agentd-instructions` — read or write the project's free-text
 * guidance (like an AGENTS.md but stored in the daemon DB so it
 * doesn't get committed). The agent uses this to persist learnings
 * for future runs of the same project.
 *
 *   agentd-instructions read
 *   agentd-instructions write "<markdown text>"
 */
function writeAgentdInstructionsScript(binDir: string): void {
  const path = join(binDir, "agentd-instructions");
  const body = `#!/usr/bin/env bash
# agentd project instructions — read/write the project's persisted
# guidance for the current task's project.
set -e
if [ "$#" -lt 1 ]; then
  echo "agentd-instructions: usage: agentd-instructions read | write \\"<text>\\"" >&2
  exit 2
fi
sub="$1"; shift
if [ -z "\${AGENTD_TASK_ID:-}" ] || [ -z "\${AGENTD_DAEMON_URL:-}" ] || [ -z "\${AGENTD_TOKEN:-}" ]; then
  echo "agentd-instructions: env not set" >&2
  exit 1
fi
case "$sub" in
  read)
    resp=\$(curl -fsS \\
      -H "Authorization: Bearer \${AGENTD_TOKEN}" \\
      "\${AGENTD_DAEMON_URL%/}/api/tasks/\${AGENTD_TASK_ID}/project-instructions") || {
      echo "agentd-instructions: read failed" >&2
      exit 1
    }
    echo "\$resp" | python3 -c 'import sys, json; print(json.loads(sys.stdin.read()).get("instructions", ""))' 2>/dev/null
    ;;
  write)
    text=""
    for arg in "$@"; do
      if [ -z "$text" ]; then text="$arg"; else text="$text $arg"; fi
    done
    if [ -z "$text" ]; then
      echo "agentd-instructions: write needs a body" >&2
      exit 2
    fi
    escaped=\$(printf '%s' "\$text" | python3 -c 'import sys,json; sys.stdout.write(json.dumps(sys.stdin.read()))' 2>/dev/null) || \\
      escaped=\$(printf '%s' "\$text" | sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g' -e ':a;N;\$!ba;s/\\n/\\\\n/g')
    curl -fsS -X PUT \\
      -H "Content-Type: application/json" \\
      -H "Authorization: Bearer \${AGENTD_TOKEN}" \\
      -d "{\\"instructions\\":\${escaped}}" \\
      "\${AGENTD_DAEMON_URL%/}/api/tasks/\${AGENTD_TASK_ID}/project-instructions" >/dev/null || {
      echo "agentd-instructions: write failed" >&2
      exit 1
    }
    ;;
  *)
    echo "agentd-instructions: unknown subcommand '\$sub' (expected: read | write)" >&2
    exit 2
    ;;
esac
`;
  writeFileSync(path, body);
  try {
    chmodSync(path, 0o755);
  } catch {
    // best effort
  }
}
