# Quickstart

Five minutes from clean machine to a remote-controllable agent.

## 1. Install the agent CLIs you want

```bash
# Claude (recommended)
brew install --cask claude        # or download from claude.com
claude auth login

# Codex (optional)
npm install -g @openai/codex
codex login
```

## 2. Install agentd

```bash
curl -fsSL https://bun.sh/install | bash       # bun
git clone https://github.com/meszmate/agentd ~/agentd
cd ~/agentd
bun install
```

No separate web build step needed — the daemon auto-builds the React bundle
the first time it starts.

## 3. (Optional) Tailscale

So you can reach the daemon from your phone without exposing it publicly.

```bash
brew install tailscale
sudo tailscale up
tailscale ip -4   # note this address
```

## 4. Start the daemon

One command. One process. Web UI + HTTP API + WebSocket bus, all on one port.

```bash
# local-only
bun start

# or "deploy on a little server" — bind every interface and print the
# reachable URLs so you can hit it from another device
bun serve

# or a specific tailnet IP
bun start -- --host $(tailscale ip -4)
```

It prints a one-time pairing token + QR code on every startup (unless you
pass `--no-pair`).

## 5. Pair a device

**CLI on the host:**
```bash
bun apps/cli/src/index.ts pair --server http://127.0.0.1:3773 --token <token>
```

**Browser (any device on your tailnet):** open `http://<host>:3773/`, paste token.

**Phone:** scan the QR code with the Tailscale-aware browser.

## 6. Spawn your first task

```bash
bun apps/cli/src/index.ts new --repo /path/to/some/git/repo \
  "add a Makefile target 'lint' that runs prettier --check"
```

Watch it from the web UI's task list, or:
```bash
bun apps/cli/src/index.ts attach <task-id>
```

When it's done, agentd auto-commits the changes on a new branch
`agentd/<slug>-xxxxxx`. Use the web UI's diff or log tab — or
```bash
git -C ~/.agentd/worktrees/<task-id> log --oneline
```

## 7. (Optional) Push + open a PR automatically

```bash
gh auth login                                                 # one-time
bun apps/cli/src/index.ts new --repo /path/to/repo --pr "rewrite README"
```

## 8. (Optional) Telegram / Discord

```bash
# Telegram (talk to @BotFather to get a token)
bun apps/cli/src/index.ts plugin enable telegram \
  --token <bot-token> --allow-user <your-tg-user-id>

# Discord (developer portal → bot)
bun apps/cli/src/index.ts plugin enable discord \
  --token <bot-token> --allow-user <your-discord-user-id>
```

In a private DM with the bot:
- Telegram: `/whoami` to confirm you're allowed; `/new <repo> <prompt>` to spawn.
- Discord: `!whoami`, `!new <repo> <prompt>`.

## 9. (Optional) Templates + schedules

```bash
# Save a reusable prompt
bun apps/cli/src/index.ts template add deps-check \
  --repo /path/to/repo \
  "Run npm outdated. Open a PR bumping minor versions only. Don't touch majors."

# Run it on demand
bun apps/cli/src/index.ts template run deps-check

# Or every Monday at 9am
bun apps/cli/src/index.ts schedule add weekly-deps \
  --cron "0 9 * * 1" --template deps-check
```

That's it.
