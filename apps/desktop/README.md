# @agentd/desktop

Electron wrapper around the existing `@agentd/web` UI. Same React app, same
look — just chrome around it so you can launch agentd as a real desktop app
on macOS / Windows / Linux instead of a browser tab.

## How it works

On launch, the desktop app picks a daemon to talk to in this order:

1. `AGENTD_DESKTOP_URL` env var, if set (used by `bun run dev`).
2. The URL the operator previously saved via the in-app connect page
   (persisted to `app.getPath('userData')/connection.json`).
3. A local daemon on `http://127.0.0.1:3773`. If `/health` doesn't
   respond, it spawns `bun apps/daemon/src/index.ts` from the repo root
   and waits up to 30s for the daemon to come up.

Any daemon the desktop app spawns is torn down on quit.

If no local daemon is reachable and Bun isn't installed, the app opens a
small connect window where you can paste in a daemon URL pointing at
another host (e.g. `http://nas.tailnet:3773`). The URL is validated
against `/health` before being saved, and stored so subsequent launches
attach automatically. "Retry local" clears the saved URL and re-runs
the bootstrap flow — handy after installing Bun.

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
| `AGENTD_DESKTOP_URL` | (unset) | Override the URL loaded into the window. When set, no daemon is spawned and no health-check runs. Trumps any URL saved via the connect page. Used by `bun run dev`. |
| `AGENTD_DESKTOP_NO_SPAWN` | `0` | Set to `1` to disable the auto-spawn behavior. The window will still try to attach to a running daemon. |

The connect-page URL is stored in `app.getPath('userData')/connection.json`.
Delete that file (or click "Retry local" in the connect window) to clear
it.

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
