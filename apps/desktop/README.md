# @agentd/desktop

Electron wrapper around the existing `@agentd/web` UI. Same React app, same
look — just chrome around it so you can launch agentd as a real desktop app
on macOS / Windows / Linux instead of a browser tab.

## How it works

1. On launch the window tries to reach `http://127.0.0.1:3773/health`.
2. If a daemon is already running, it attaches.
3. If not, it spawns `bun apps/daemon/src/index.ts` from the repo root and
   waits up to 30s for `/health` to come up before loading the window.
4. On quit, any daemon the desktop app spawned is torn down.

If no local daemon is reachable and Bun isn't installed, the app shows a
warning dialog with two paths: install Bun, or relaunch with
`AGENTD_DESKTOP_URL=http://other-host:3773` to point at a daemon running on
another machine. The daemon doesn't have to run on the same host as the
desktop app.

The renderer always loads the daemon's HTTP UI; nothing in the React app
needs to know it's running inside Electron.

## Run from source

```bash
bun install
bun --filter @agentd/web build      # produce apps/web/dist (served by the daemon)
bun --filter @agentd/desktop start
```

If you want HMR while iterating on the web app, run the daemon and Vite
dev server yourself, then point the desktop window at Vite:

```bash
# terminal 1
bun apps/daemon/src/index.ts

# terminal 2
bun --filter @agentd/web dev

# terminal 3
bun --filter @agentd/desktop dev    # AGENTD_DESKTOP_URL=http://127.0.0.1:5173
```

## Environment variables

| Variable | Default | Effect |
|---|---|---|
| `AGENTD_DESKTOP_PORT` | `3773` | Daemon port the window connects to. |
| `AGENTD_DESKTOP_URL` | (unset) | Override the URL loaded into the window. When set, no daemon is spawned and no health-check runs. Used by `bun run dev`. |
| `AGENTD_DESKTOP_NO_SPAWN` | `0` | Set to `1` to disable the auto-spawn behavior. The window will still try to attach to a running daemon. |

## Packaging

```bash
bun --filter @agentd/desktop build:linux   # AppImage + deb
bun --filter @agentd/desktop build:mac     # dmg + zip, x64 and arm64
bun --filter @agentd/desktop build:win     # nsis + zip
```

Output lands in `apps/desktop/dist/`. CI builds these artifacts via
`.github/workflows/desktop.yml` when a `v*` tag is pushed.

Packaged builds bundle the daemon source under `resources/daemon/` and the
built web bundle under `resources/web-dist/`, but they still need
[Bun](https://bun.sh) installed on the user's machine to actually run the
daemon. Native daemon bundling (no Bun required) is intentionally out of
scope for v1.
