<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/logo-dark.svg">
    <img src="./assets/logo.svg" alt="agnt" width="380">
  </picture>

  <p>
    <strong>A self-hosted orchestrator for coding agents.</strong><br>
    Spawn parallel agents, each in its own git worktree.<br>
    Chat from web, terminal, Telegram, or Discord.<br>
    Auto-commit, auto-push, auto-PR. Cron schedules. Templates.<br>
    Run on your host so agents see your real toolchain.<br>
  </p>

  <p>
    <a href="https://www.npmjs.com/package/@meszmate/agentd"><img src="https://img.shields.io/npm/v/@meszmate/agentd?color=cb3837&logo=npm&label=%40meszmate%2Fagentd" alt="npm: @meszmate/agentd"></a>
    <a href="https://github.com/meszmate/agentd/actions/workflows/ci.yml"><img src="https://github.com/meszmate/agentd/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
    <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="License: MIT"></a>
    <img src="https://img.shields.io/badge/runtime-bun-000000?logo=bun&logoColor=white" alt="Bun">
    <img src="https://img.shields.io/badge/typescript-strict-3178c6?logo=typescript&logoColor=white" alt="TypeScript">
    <a href="https://github.com/meszmate/agentd/stargazers"><img src="https://img.shields.io/github/stars/meszmate/agentd?style=flat&color=yellow" alt="Stars"></a>
  </p>

  <p>
    <a href="./docs/quickstart.md">Quickstart</a> ·
    <a href="./docs/deploy.md">Deploy on a server</a> ·
    <a href="./docs/docker.md">Docker</a> ·
    <a href="./docs/architecture.md">Architecture</a> ·
    <a href="./CONTRIBUTING.md">Contributing</a>
  </p>
</div>

---

Designed for one operator with many devices. Reachable from anywhere over Tailscale
(or any other private network) without exposing your repos to the public internet.

## Quick start

```bash
npm i -g @meszmate/agentd        # or: bun install -g @meszmate/agentd
agentd serve                     # local-only, http://127.0.0.1:3773
agentd serve --public            # bind every interface, print reachable URLs
```

That's the whole setup. One command starts the daemon, the WebSocket bus, and
the web UI on the same port — open the URL it prints, pair your first device
with the token shown in the terminal, and you're in. Bun is required at
runtime; everything else is bundled into the npm package.

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
- **Desktop app**: optional Electron wrapper (`apps/desktop`) around the same web UI,
  packaged for macOS / Windows / Linux. Auto-spawns the daemon if none is running.
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

Two ways. Pick whichever fits — both put the `agentd` command on your PATH.

### npm (one-liner, no clone)

```bash
bun install -g @meszmate/agentd        # or: npm i -g @meszmate/agentd
agentd serve                           # local-only, 127.0.0.1:3773
agentd serve --public                  # bind every interface; print reachable URLs
```

Bun is required at runtime (the daemon and CLI are Bun scripts). The
published tarball ships the pre-built web bundle, so there's no extra build
step after install.

### From source

```bash
git clone https://github.com/meszmate/agentd ~/agentd
cd ~/agentd
bun install
```

That's it — no separate web build step. The daemon serves the React UI from
the same port and auto-builds the bundle the first time it starts.

## Run

One process. One command. The HTTP API, the WebSocket bus, and the web UI all
live on the same port — you don't run "web" and "daemon" separately. **Pick
host-direct or Docker depending on what the box is for.**

### Host-direct (recommended for dev — and for "drop on a little server")

```bash
# local-only (default 127.0.0.1:3773)
bun start                            # or: agentd serve

# server mode — bind every interface so you can hit it from another machine
bun serve                            # or: agentd serve --public
                                     # ↑ binds 0.0.0.0; prints the reachable URLs

# bind a specific IP / port / root
agentd serve --host $(tailscale ip -4)
agentd serve --public --port 8080 --root /var/lib/agentd
```

`bun start` and `agentd serve` are equivalent — the CLI subcommand exists so a
globally-installed `agentd` binary works the same way. The very first run
compiles the web bundle (`apps/web/dist`) automatically; subsequent runs reuse
it.

For a real server (auto-start on boot, background, auto-update from npm), see
[docs/deploy.md](./docs/deploy.md) — has copy-paste systemd, launchd, and
Watchtower recipes.

The daemon runs as your user, on your filesystem, with your `$PATH`. That
means **everything you do in the web tmux is a real shell on your machine**:
`cargo`, `rustc`, `docker compose`, `pnpm`, `python`, your nvm/mise/asdf
shims — all just work, because you already installed them. Worktrees live
under `~/.agentd/worktrees/`. Agents inherit your `~/.claude/`,
`~/.codex/`, `~/.gh/`, `~/.gitconfig` — no need to mount or copy anything.

This is the right mode if you want agentd to do real development work for
you on this machine.

### Docker (clean-room deploy)

```bash
cp .env.example .env       # fill in API keys + repos dir
docker compose up -d --build
```

State persists in the `agentd-data` volume; mount your repos at
`${REPOS_DIR}` and reference them inside the container by `/repos/<name>`.
Full instructions, including dev compose with Vite hot reload, multi-arch
build, and the auth options, are in [docs/docker.md](./docs/docker.md).

The container ships only what agentd itself needs (bun, git, gh, tmux,
node-pty, claude/codex CLIs). **It does not see your host's `cargo`,
`docker`, `pnpm`, etc.** Web tmux sessions are shells inside the container.
That's the right trade for an isolated deployment (a tailnet box you don't
develop on, a shared host, CI), but it's not what you want if the goal is
"the agent runs my projects on my machine". For that, use host-direct
above.

You can switch between modes any time: `docker compose down` and then
`bun start`. The two have separate state directories (`/data` volume vs
`~/.agentd/`) so they don't collide.

### Desktop app (optional)

Same UI, native window. Useful if you'd rather click an app icon than
keep a browser tab pinned.

```bash
bun --filter @agentd/desktop start       # opens an Electron window
```

On launch the desktop app:

1. tries to attach to a daemon on `127.0.0.1:3773`,
2. spawns `bun start` (the daemon) if none is reachable — building the web
   bundle on the fly if it isn't there yet,
3. tears that spawned daemon down on quit.

If Bun isn't installed and no local daemon is running, the app opens a
small connect window where you can paste in a remote daemon URL (e.g.
the daemon on another tailnet machine). The URL is saved and reused on
the next launch.

Set `AGENTD_DESKTOP_NO_SPAWN=1` if you'd rather start the daemon
yourself, or `AGENTD_DESKTOP_URL=http://...` to point at a different
host without going through the connect page (the env var trumps any
saved URL).

Packaged installers (DMG / NSIS / AppImage / deb) are built by the
`desktop` GitHub Actions workflow on `v*` tags. To build locally:

```bash
bun --filter @agentd/desktop build:linux
bun --filter @agentd/desktop build:mac
bun --filter @agentd/desktop build:win
```

Output lands in `apps/desktop/dist/`. Packaged builds still rely on
[Bun](https://bun.sh) being installed on the user's machine to run the
spawned daemon.

### Pairing

The daemon prints a one-time pairing token + QR code on startup. Pair the
CLI:

```bash
bun apps/cli/src/index.ts pair --server http://127.0.0.1:3773 --token <token>
```

Open the same URL in a browser to pair the web UI (paste the token).
Pairing tokens last 10 minutes; the resulting session token is stored on
the device. Issue more pairings later from the web `Devices` page or
`agentd plugin pair`.

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
apps/desktop      Electron wrapper around apps/web (loads the daemon URL).
                  Optional; auto-spawns the daemon if none is running.
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
