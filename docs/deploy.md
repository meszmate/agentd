# Deploy on a server

How to run `agentd` as a long-lived background service that survives reboots,
shell logouts, and `ssh` disconnects.

## Skip the manual setup: `agentd setup`

For the common case, you do not need anything in this doc except this:

```bash
# linux (system-level systemd unit, daily auto-update timer)
sudo -E env "PATH=$PATH" agentd setup --public

# macos (per-user LaunchAgent, no sudo)
agentd setup --public
```

`agentd setup` detects your OS, writes the appropriate unit file (systemd
service / LaunchAgent), enables it on boot, installs a daily auto-update
timer, starts the daemon, and prints the URL + pairing token. To remove:
`agentd setup --uninstall`. Your data at `--data-dir` is preserved.

Flags worth knowing:

- `--data-dir <path>` — default `/var/lib/agentd` on linux, `~/.agentd` on
  macos. Bind a stable path on production servers.
- `--port <n>` — default `3773`.
- `--public` — bind `0.0.0.0` instead of `127.0.0.1`. Required for any
  other machine to reach it; pair with Tailscale or a firewall.
- `--no-auto-update` — skip the daily npm-update timer/agent if you want
  to pin and update by hand.
- `--dry-run` — print the unit files + commands without writing anything.

The rest of this doc is the manual recipe — useful if you want to tweak
the unit, learn what `agentd setup` actually does, or run on a platform
the setup command doesn't support (BSDs, alpine + openrc, Windows).

---

## Prerequisites

- `agentd` on `PATH`. Either:
  - `npm i -g @meszmate/agentd` (also requires `bun` ≥ 1.3 on the box), or
  - A git clone with `bun install` already run.
- A pick of where state lives. Default is `~/.agentd/`; for a system service
  point it at `/var/lib/agentd/` or similar so it's not tied to a personal
  home directory.

---

## Linux: systemd (recommended)

Drop the unit at `/etc/systemd/system/agentd.service`:

```ini
[Unit]
Description=agentd — coding-agent orchestrator
After=network-online.target
Wants=network-online.target

[Service]
Type=simple

# Run as your user, not root. The daemon spawns shells / agent CLIs in your
# environment and writes worktrees on your filesystem — root would put all of
# that under root and break tooling like nvm/mise/asdf.
User=meszmate
Group=meszmate

# Where agentd keeps its DB, worktrees, config. Pick something stable that
# survives reboots and that your user owns.
Environment=AGENTD_ROOT=/var/lib/agentd
Environment=PATH=/usr/local/bin:/usr/bin:/bin:/home/meszmate/.bun/bin

WorkingDirectory=/home/meszmate

# `--public` binds 0.0.0.0 so the tailnet / LAN can reach it. Drop the flag
# if you only want localhost (e.g. behind a reverse proxy on the same box).
ExecStart=/home/meszmate/.bun/bin/agentd serve --public --root /var/lib/agentd

Restart=on-failure
RestartSec=5
KillSignal=SIGINT
TimeoutStopSec=20

# Stdout/stderr to journald — `journalctl -u agentd -f` to tail.
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Two paths above probably need tweaking for your box:

- `User=` / `Group=` / `WorkingDirectory=` — your username and home dir.
- `Environment=PATH=…` — must include the dir where `bun` and `agentd` live
  (`~/.bun/bin` for a default Bun install) plus wherever agent CLIs live
  (`claude`, `codex`, `gh`, `git`, your shell). systemd starts with a
  minimal PATH; if `agentd` runs an agent that can't find `claude`, this
  is why.

One-time bootstrap (create the data dir first so the service user owns it):

```bash
sudo mkdir -p /var/lib/agentd
sudo chown $USER:$USER /var/lib/agentd

sudo systemctl daemon-reload
sudo systemctl enable agentd        # start on boot
sudo systemctl start agentd

systemctl status agentd
journalctl -u agentd -f             # tail the log; look for the pairing token + URL
```

Pair your first device:

```bash
# print a fresh pairing token (10-minute TTL, QR code in the log)
sudo systemctl reload agentd 2>/dev/null || true   # noop if reload isn't wired
journalctl -u agentd --since="1 minute ago" | grep token
```

…or from the laptop you want to pair from:

```bash
agentd pair --server http://<server-ip>:3773 --token <token-from-journal>
```

Common tweaks:

- **Don't print the pairing banner on every restart.** Add `--no-pair` to
  `ExecStart` once you're paired. Re-issue tokens later via `agentd settings`.
- **Different port.** Add `--port 8080`. If you're behind a reverse proxy,
  also drop `--public` and bind localhost.
- **Auto-update on the box.** Cron / timer that runs `bun install -g
  @meszmate/agentd@latest && systemctl restart agentd`. Tag-pinned is
  safer for a server (`@0.0.5`); `@latest` will pick up breaking changes.

---

## macOS: launchd

Drop the plist at `~/Library/LaunchAgents/sh.bun.agentd.plist` (replace
`meszmate` with your username):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>sh.bun.agentd</string>

  <key>ProgramArguments</key>
  <array>
    <string>/Users/meszmate/.bun/bin/agentd</string>
    <string>serve</string>
    <string>--root</string>
    <string>/Users/meszmate/.agentd</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/Users/meszmate/.bun/bin</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>/Users/meszmate/.agentd/agentd.out.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/meszmate/.agentd/agentd.err.log</string>
</dict>
</plist>
```

```bash
launchctl load -w ~/Library/LaunchAgents/sh.bun.agentd.plist     # enable + start
launchctl list | grep agentd                                     # confirm running
tail -f ~/.agentd/agentd.out.log                                 # watch the log

# stop / disable
launchctl unload -w ~/Library/LaunchAgents/sh.bun.agentd.plist
```

`KeepAlive=true` makes launchd respawn the daemon if it crashes. `RunAtLoad`
+ a LaunchAgent (not Daemon) means it starts on login, not at boot — which
is what you want, because agentd needs to share your user environment to
find `claude`, `codex`, your nvm/mise shims, your SSH keys, etc.

---

## Docker (already supported)

If you'd rather isolate the daemon from the host, use the bundled
`docker-compose.yml`. Full details in
[docs/docker.md](./docker.md); the short version:

```bash
cp .env.example .env       # set AGENTD_HOST / PORT / volume paths if needed
docker compose up -d       # detached, auto-restart on failure / reboot
docker compose logs -f
```

Tradeoff vs systemd: the container has its own filesystem and `$PATH`, so
your host's nvm/mise/asdf shims are NOT visible inside. If your agents need
toolchains, you bake them into the image or mount them in. The systemd /
launchd routes "just work" because the daemon runs as your user with your
real environment. Use Docker for a shared host / CI / "throwaway" setup;
use systemd for "this is my coding-agent server."

---

## Quick & dirty (nohup / tmux)

For a one-off "I just want to leave this running until I reboot":

```bash
# detach via nohup, log to file
nohup agentd serve --public > ~/.agentd/agentd.log 2>&1 &
echo $! > ~/.agentd/agentd.pid
disown

tail -f ~/.agentd/agentd.log

# stop it
kill "$(cat ~/.agentd/agentd.pid)"
```

Or, in a tmux session that you can detach from and reattach to later:

```bash
tmux new -s agentd 'agentd serve --public'
# detach: Ctrl-b d        reattach: tmux attach -t agentd
```

Neither survives reboot. Use only for trials.

---

## Updating

Manual:

```bash
bun install -g @meszmate/agentd@latest      # or: npm i -g @meszmate/agentd@latest
sudo systemctl restart agentd               # linux
launchctl kickstart -k gui/$UID/sh.bun.agentd   # macos
docker compose pull && docker compose up -d # docker
```

State lives in `--root` (default `~/.agentd/`), not in the install. Upgrading
the binary doesn't touch your DB, worktrees, or config. Downgrades are
generally safe too — config and migrations are designed to be permissive
across versions (see `CLAUDE.md` → "Bedrock conventions").

### Auto-update (systemd timer)

A nightly job that pulls the latest npm release and restarts the service.
Two files: a oneshot service that does the upgrade, and a timer that fires it.

`/etc/systemd/system/agentd-update.service`:

```ini
[Unit]
Description=agentd auto-update
After=network-online.target

[Service]
Type=oneshot
User=meszmate
Environment=PATH=/usr/local/bin:/usr/bin:/bin:/home/meszmate/.bun/bin

# Compare installed vs registry; only restart if the version actually changed,
# so we don't bounce the daemon for no reason. The `|| exit 0` keeps a
# transient registry hiccup from emailing you about a failed timer.
ExecStart=/bin/sh -c '\
  set -eu; \
  CURRENT=$(/home/meszmate/.bun/bin/bun pm ls -g 2>/dev/null | awk "/@meszmate\\/agentd/ {print \\$NF}" | head -1) || exit 0; \
  LATEST=$(/usr/bin/curl -fsSL https://registry.npmjs.org/@meszmate/agentd/latest | /usr/bin/python3 -c "import json,sys;print(json.load(sys.stdin)[\\"version\\"])") || exit 0; \
  if [ "$CURRENT" = "$LATEST" ]; then echo "agentd $CURRENT is current"; exit 0; fi; \
  echo "upgrading agentd: $CURRENT -> $LATEST"; \
  /home/meszmate/.bun/bin/bun install -g @meszmate/agentd@$LATEST; \
  /usr/bin/sudo /bin/systemctl restart agentd'
```

For that last `sudo systemctl restart` to work without a password prompt,
add a narrow sudoers rule (`sudo visudo -f /etc/sudoers.d/agentd-update`):

```
meszmate ALL=(root) NOPASSWD: /bin/systemctl restart agentd
```

`/etc/systemd/system/agentd-update.timer`:

```ini
[Unit]
Description=agentd nightly auto-update

[Timer]
# Run at 04:17 every day. The odd minute spreads load across users who all
# copy-paste the same recipe at 04:00.
OnCalendar=*-*-* 04:17:00
# If the box was off at the scheduled time, run on next boot.
Persistent=true
RandomizedDelaySec=10m

[Install]
WantedBy=timers.target
```

Enable:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now agentd-update.timer
systemctl list-timers | grep agentd        # confirm next-fire time
journalctl -u agentd-update -f             # watch what it does
```

**Recommended pin:** for a server you actually depend on, pin to a minor
version (`@meszmate/agentd@0.0`) in the upgrade command. Then the timer
auto-applies patches but never silently jumps a minor version on you.

### Auto-update (macOS via launchd)

Add a second LaunchAgent at
`~/Library/LaunchAgents/sh.bun.agentd-update.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>sh.bun.agentd-update</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>/Users/meszmate/.bun/bin/bun install -g @meszmate/agentd@latest &amp;&amp; /bin/launchctl kickstart -k gui/$UID/sh.bun.agentd</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/Users/meszmate/.bun/bin</string>
  </dict>

  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>4</integer>
    <key>Minute</key><integer>17</integer>
  </dict>

  <key>StandardOutPath</key>
  <string>/Users/meszmate/.agentd/agentd-update.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/meszmate/.agentd/agentd-update.log</string>
</dict>
</plist>
```

```bash
launchctl load -w ~/Library/LaunchAgents/sh.bun.agentd-update.plist
```

### Docker (Watchtower or `docker compose pull`)

If you publish a container image alongside the npm package (or use the
bundled `Dockerfile`), the standard "self-updating container" trick is
[Watchtower](https://containrrr.dev/watchtower/). One-line setup:

```bash
docker run -d --name watchtower \
  --restart unless-stopped \
  -v /var/run/docker.sock:/var/run/docker.sock \
  containrrr/watchtower agentd --interval 86400
```

It polls Docker Hub once a day, pulls a newer image tag, and re-creates the
agentd container. Simpler alternative: a cron that runs
`docker compose pull && docker compose up -d` at the same hour each day.

### Disabling auto-update

If you'd rather pin a version and update by hand:

```bash
# linux
sudo systemctl disable --now agentd-update.timer

# macos
launchctl unload -w ~/Library/LaunchAgents/sh.bun.agentd-update.plist
```

### Caveats

- Auto-updaters will eventually pull a breaking change. Pinning to a minor
  (`@0.0`) is the safe middle ground until the project hits 1.x and ships
  semver guarantees.
- The first run after a major upgrade may take longer because the migration
  log applies any new `COLUMN_ADDITIONS` against your DB. Don't kill the
  daemon during startup if the log shows DB work in progress.
- If the upgrade pulls a Bun-runtime requirement bump (`engines.bun`),
  you'll also need to upgrade Bun: `curl -fsSL https://bun.sh/install | bash`.
  The auto-update recipes above do NOT auto-upgrade Bun, on purpose — Bun
  upgrades are a host-level decision and should be deliberate.
