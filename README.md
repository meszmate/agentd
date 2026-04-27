# agentd

A self-hosted orchestrator for coding agents. Spawn parallel agents, each in its own
git worktree; chat with them from a web UI, terminal, Telegram, or Discord; auto-commit
their work, auto-push, auto-open a PR; schedule recurring runs with cron.

Designed for one operator with many devices. Reachable from anywhere over Tailscale
(or any other private network) without exposing your repos to the public internet.

## Features

- **Multi-agent**: Claude Code and Codex (OpenAI) supported, picked per task or per template.
- **Per-task git worktrees** so multiple agents work on the same repo without colliding.
- **Auto-commit, auto-push, auto-PR** — every agent run produces a discrete revertable
  commit; opt in to push the branch and open a PR via the `gh` CLI.
- **Templates**: named prompts with `{placeholder}` substitution and stored agent / repo /
  flags defaults.
- **Cron schedules**: fire any template on a 5-field cron expression (the daemon ticks
  once per minute).
- **Web UI**: Vite + React, served by the daemon, with chat, file tree, syntax-coloured
  diff, commit log + one-click revert, and an embedded terminal in the worktree.
- **Telegram & Discord bridges** as managed plugins, with two-axis user-ID + chat/channel-ID
  allowlists. The daemon spawns and supervises them; restart-with-backoff on crash.
- **Cost tracking**: token usage and USD cost captured per task from the agent's stream.
- **Configurable agent system prompt + commit / PR templates**, with defaults that
  suppress model self-references and attribution trailers in any output.
- **Pairing-token auth** for browsers / CLIs / additional devices; long-lived session
  tokens stored hashed.
- **No public exposure required**: bots dial out, web/CLI bind to your tailnet IP.

## Requirements

- [Bun](https://bun.sh) ≥ 1.3 (`curl -fsSL https://bun.sh/install | bash`).
- `git` ≥ 2.30.
- One or more agent CLIs:
  - [Claude Code](https://claude.com/claude-code) — install + `claude auth login`.
  - [Codex CLI](https://github.com/openai/codex) — `npm i -g @openai/codex` + `codex login`.
- [`gh`](https://cli.github.com) if you want auto-PR (`gh auth login`).
- (Recommended) [Tailscale](https://tailscale.com) for remote access.

## Install

```bash
git clone https://github.com/meszmate/agentd ~/agentd
cd ~/agentd
bun install
bun --filter @agentd/web build
```

## Run

```bash
# local-only (default 127.0.0.1:3773)
bun apps/daemon/src/index.ts

# remote (bind to tailnet IP)
bun apps/daemon/src/index.ts --host $(tailscale ip -4)

# alternative bind options
bun apps/daemon/src/index.ts --host 0.0.0.0 --port 8080 --root /var/lib/agentd
```

The daemon prints a one-time pairing token + QR code on startup. Pair the CLI:

```bash
bun apps/cli/src/index.ts pair --server http://127.0.0.1:3773 --token <token>
```

Open the same URL in a browser to pair the web UI (paste the token).

## Spawning a task

```bash
bun apps/cli/src/index.ts new --repo /path/to/repo "fix the parser bug"
bun apps/cli/src/index.ts new --repo /path/to/repo --pr "rewrite README"
```

Each task gets its own worktree under `<root>/worktrees/<task-id>` on a branch named
`agentd/<slug>`. When the agent exits cleanly and the worktree has changes, agentd commits
them automatically. With `--push` the branch is pushed; with `--pr` the branch is pushed
and a PR is opened via `gh pr create`.

## Templates

```bash
bun apps/cli/src/index.ts template add review-pr \
  --repo /path/to/repo --pr \
  "Review PR #{pr} carefully. Comment on every changed file. Suggest concrete fixes."

bun apps/cli/src/index.ts template run review-pr --arg pr=4231
```

## Schedules

```bash
bun apps/cli/src/index.ts schedule add nightly-tests \
  --cron "0 3 * * *" --template run-tests
```

The daemon's scheduler ticks once per minute, dedupes by minute floor, and fires matching
schedules as new tasks. Standard 5-field cron (minute / hour / day-of-month / month /
day-of-week), with `*`, `*/N`, ranges, and lists.

## Plugins (Telegram & Discord)

The daemon owns the bot lifecycle. Configure them once and the daemon restarts them on
crash and exposes their status in the web UI / `agentd plugin status`.

```bash
# Telegram (find your user id with /whoami in the bot)
bun apps/cli/src/index.ts plugin enable telegram \
  --token <botfather-token> \
  --allow-user 123456789 \
  --default-repo /path/to/repo

# Discord (find ids with !whoami)
bun apps/cli/src/index.ts plugin enable discord \
  --token <discord-bot-token> \
  --allow-user 998877665544332211 \
  --allow-channel 123456789012345678 \
  --default-repo /path/to/repo
```

Both bots support `/new`, `/ls`, `/use`, `/show`, `/in`, `/stop`, `/diff`, `/log`, `/tpl`,
`/run`, `/sched`, `/whoami` (Telegram) and the corresponding `!`-prefixed commands on
Discord. Free text in a channel becomes input to the focused task.

**Allowlist semantics:** if both user-id and chat/channel-id allowlists are configured,
**both** must match (so you can use the bot in a shared room while still gating by user).
With only one configured, that one alone gates. With neither, everything is denied.

## Settings

Edit the system prompt every agent sees, plus commit/PR templates:

```bash
bun apps/cli/src/index.ts settings show
bun apps/cli/src/index.ts settings set commitPrefix "auto: "
bun apps/cli/src/index.ts settings set agentInstructions "..."
```

The default `agentInstructions` already suppresses model self-references and attribution
trailers — override if you want different policy.

## Layout

```
apps/daemon       Bun + Hono server. HTTP+WS API, owns SQLite,
                  scheduler, plugin manager.
apps/cli          The `agentd` command. pair / ls / new / show / input / attach /
                  stop / rm / template / schedule / plugin / settings.
apps/web          Vite + React UI served by the daemon at /. Tasks, templates,
                  schedules, plugins, settings; embedded terminal via WS PTY.
apps/telegram     grammY bridge (managed by the daemon).
apps/discord      discord.js bridge (managed by the daemon).
packages/contracts  zod schemas — Task, Template, Schedule, AgentEvent, requests.
packages/client     AgentdClient — HTTP+WS surface; used by CLI, bots, web UI.
packages/core       drizzle/SQLite schema, paths, eventbus, worktrees, auth,
                  tasks, git, config, templates, schedules, cron.
packages/agent-runner  ClaudeRunner + CodexRunner. Each spawns its CLI in
                  stream-json mode and normalizes the output to AgentEvent.
```

## Data on disk

- `<root>/agentd.db` — SQLite (WAL mode). All tasks, messages, templates, schedules,
  sessions.
- `<root>/worktrees/<task-id>/` — git worktrees, one per task.
- `<root>/config.json` — plugin tokens, agentInstructions, etc. **Mode 0600.**
- `~/.agentd/cli.json` — local CLI saved server URL + session token.

Default `<root>` is `~/.agentd`; override with `--root` or `AGENTD_ROOT`.

## Security notes

- Bot tokens and the long-lived plugin session live in `<root>/config.json` with mode
  0600. Treat the directory as a secret store.
- Don't expose the daemon to the public internet directly. Use Tailscale (recommended),
  Cloudflare Tunnel, or an SSH tunnel. The daemon itself does not implement TLS.
- The default permission mode for Claude is `bypassPermissions` so agents complete
  autonomously. Per-task overrides exist on the runner; surface them in the create-task
  request if you want stricter modes.
- Auto-commit means an agent's mistakes are recorded as commits on a branch, not
  silently mutated working state. Use `git revert <sha>` (or the web UI's revert button)
  to undo.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT — see [LICENSE](./LICENSE).
