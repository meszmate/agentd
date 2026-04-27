# Running agentd in Docker

The repo ships a multi-stage `Dockerfile`, a production `docker-compose.yml`,
and a `docker-compose.dev.yml` override for Vite hot-reload.

## Quick start

```bash
cp .env.example .env       # fill in your API keys + repos dir
docker compose up -d --build
docker compose logs -f agentd
```

The daemon will print a one-time pairing token to its log on first start. Pair
your CLI / browser against it as usual:

```bash
TOKEN=$(docker compose logs agentd | grep -oE 'token:  [A-Za-z0-9_-]+' | awk '{print $2}' | head -1)
curl -X POST http://localhost:3773/pair \
  -H "content-type: application/json" \
  -d "{\"pairingToken\":\"$TOKEN\",\"deviceLabel\":\"mac\"}"
```

Or just open `http://localhost:3773/` and paste the token into the login card.

## Volumes

| Volume / mount             | What it holds                                          |
|----------------------------|--------------------------------------------------------|
| `agentd-data` → `/data`    | SQLite (WAL), worktrees, `config.json` (bot tokens). Treat as a secret store. |
| `${REPOS_DIR}` → `/repos`  | Bind-mount of the host directory containing the git repos you want agents to operate on. Reference repos by their in-container path (`/repos/myproject`) when creating tasks. |

If you delete the `agentd-data` volume you lose every task, message, schedule,
template, and pairing — but agents working in `/repos/...` write to your host
files directly, so their commits survive.

## Authenticating the agent CLIs

Two paths:

### A. API keys via env (simplest)

Populate `ANTHROPIC_API_KEY` and / or `OPENAI_API_KEY` in `.env`. Both CLIs
(`claude`, `codex`) read these on launch and skip their interactive auth flow.

### B. Mount your host's CLI configs

If you've already done `claude auth login` and `codex login` on the host, you
can share the resulting credentials by adding mounts to `docker-compose.yml`:

```yaml
    volumes:
      - agentd-data:/data
      - "${REPOS_DIR:-./repos}:/repos"
      - "${HOME}/.claude:/root/.claude:ro"
      - "${HOME}/.codex:/root/.codex:ro"
```

Read-only is fine — both CLIs only read from these directories at startup.

## Authenticating `gh` for auto-PR

Set `GH_TOKEN` in `.env` to a GitHub personal access token with the `repo`
scope. The `gh` CLI inside the container picks it up automatically. Without
this set, tasks with `--pr` will auto-commit and auto-push but the PR creation
step will fail with a clear error in the task's system messages.

## Networking

The container binds to `0.0.0.0:3773` inside, mapped to whatever you set as
`AGENTD_PORT` on the host (default `3773`). Reach it from:

- **Same machine:** `http://localhost:3773/`
- **Another device on the LAN:** `http://<host-ip>:3773/`
- **Anywhere via Tailscale:** install Tailscale on the *host* (not the
  container), then reach `http://<host-tailnet-ip>:3773/` from any tailnet
  device. Running Tailscale inside the container is possible (`tailscale/tailscale`
  sidecar) but rarely worth it for a personal install.

The daemon does not implement TLS. Don't expose the port to the public
internet directly — sit it behind Tailscale, Cloudflare Tunnel, or a reverse
proxy that handles TLS.

## Plugins (Telegram / Discord) inside Docker

`agentd plugin enable telegram --token <bot-token> --allow-user <id>`
works the same way it does on the host. The PluginManager spawns the bot as a
child `bun` process inside the container; stdout/stderr is interleaved into
the container log with a `[telegram:stderr]` / `[discord:stderr]` prefix.

```bash
# from your host, talking to the daemon over the published port
TOKEN=$(docker compose exec agentd cat /data/cli-token 2>/dev/null) || true
# easier: pair via the web UI or `agentd pair` first, then:
agentd plugin enable telegram --token <bot-token> --allow-user 123456789
```

## Dev mode

With Vite running for hot reload:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up
```

This bind-mounts `apps/` and `packages/` into the container, runs the daemon
under `bun --watch`, and starts a second `web-dev` service on port 5173 with
the Vite dev server. The dev server proxies `/api`, `/ws`, `/pty`, `/pair`,
and `/health` to the daemon, so the browser still talks to one origin.

## Image size

The runtime image clocks in around ~1.1 GB. The bulk is bun (~150 MB), the
`gh` CLI (~50 MB), plus the npm-installed `claude` and `codex` CLIs (each
~200–300 MB because they bundle their own runtimes). If you don't need both
agents, edit the Dockerfile's `bun install -g` line to drop one.

## Building for ARM (Apple Silicon, Raspberry Pi)

The `oven/bun` base image is multi-arch, so:

```bash
docker buildx build --platform linux/arm64 -t agentd:arm64 .
```

works without any extra setup. For multi-arch in one go:

```bash
docker buildx build --platform linux/amd64,linux/arm64 -t ghcr.io/meszmate/agentd:latest --push .
```

## Common operations

```bash
# tail the log
docker compose logs -f agentd

# shell in
docker compose exec agentd bash

# inspect persistent state
docker volume inspect agentd-data
docker run --rm -v agentd-data:/data -it busybox ls -la /data

# blow it all away
docker compose down -v
```

## Limitations

- **No real PTY**: the embedded terminal in the web UI uses a non-tty bash
  shell (`TERM=dumb`). Line-oriented commands work, full TUIs (vim, htop)
  don't render properly. Same as on bare metal.
- **Repos must be inside `/repos`**: paths outside the bind-mount aren't
  reachable from the container.
- **Pairing tokens** print only to the container log on startup. If you miss
  the first one, exec in and mint a new one:
  `docker compose exec agentd bun apps/cli/src/index.ts plugin status`
  (any authenticated CLI command), or hit `POST /api/admin/pair` from an
  already-paired session.
