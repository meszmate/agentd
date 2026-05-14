# Agent guide

This file is the canonical guide for any AI coding agent (Claude Code,
Codex, etc.) working in this repo. `CLAUDE.md` is a symlink to this file
so Claude Code picks it up automatically.

Keep edits surgical. The codebase is small and uniform — match what's
already there before introducing a new pattern.

## Project shape

Bun monorepo. Two top-level dirs that matter:

```
packages/    pure libraries (no app imports)
  contracts/    zod schemas — single source of truth for cross-package types
  client/       browser/Node HTTP+WS client to the daemon
  core/         db, paths, config, git, worktrees, skills, repo-context
  agent-runner/ Bun.spawn() wrappers around `claude` and `codex` CLIs
apps/        deployables (depend on packages, not on each other)
  daemon/    Hono HTTP+WS server. Owns the event bus + state.
  web/       Vite + React frontend served by the daemon.
  desktop/   Electron wrapper around the web UI (loads the daemon URL).
  cli/       agentd CLI (pair, ls, run, settings, plugin enable, …).
  telegram/  Telegram bot plugin (subprocess of daemon).
  discord/   Discord bot plugin (subprocess of daemon).
```

Architectural rule: `packages/` never imports from `apps/`. `apps/` only
share code via `@agentd/client` (HTTP) and `@agentd/contracts` (types).
The daemon spawns plugin apps as subprocesses, never imports them.

## Bedrock conventions

- **`@agentd/contracts` is the source of truth.** Adding or changing a
  field on a Task / Project / Skill / Schedule / config block means
  editing the zod schema in `packages/contracts/src/index.ts` first,
  then propagating to `packages/core/src/db.ts` (drizzle schema + raw
  SQL + idempotent ALTER) and the read/write helpers in `tasks.ts` /
  similar.
- **Migrations are idempotent.** Every column add lives as one entry
  in `COLUMN_ADDITIONS` in `packages/core/src/db.ts` wrapped in a
  per-statement try/catch. Never edit the existing entries — append
  new ones. Old installs run the `CREATE TABLE` (no-op if present)
  and every ALTER (no-op once applied).
- **Config schema is permissive.** `AgentdConfig` uses `.default(...)`
  on every field and silently strips unknown keys. Removing a config
  field is a non-breaking change for old `config.json`s; adding a
  field is non-breaking the other direction. Don't ever require a
  field that older builds wouldn't have written.
- **Cross-device state goes on the server.** Anything operators
  expect to see across devices — task chat, ideas, conversations,
  drafts, settings, history, anything that survives a reload —
  lives in the daemon DB and syncs via `/ws`. Never reach for
  `localStorage` or `sessionStorage` for content state. Operator
  preferences (last-used model / agent / permission mode / etc.)
  go in `cfg.prefs` (the `UserPrefs` block), served by `GET/PATCH
  /api/prefs` and consumed via `usePrefs()` / `usePatchPrefs()` in
  the web app. The ONLY things that may stay in `localStorage` are
  strict per-device concerns the server can't know: the auth token,
  theme, OS notification permission. Everything else: server +
  WebSocket. If you find yourself caching a conversation, draft,
  or list locally to "survive reload", stop and add a table.
- **Every state change is realtime.** When a row mutates (task,
  project, todo, suggestion, terminal session, anything operators
  see across surfaces), publish a system event through the
  `EventBus` so the `/ws` fan-out reaches every connected web /
  telegram / discord / CLI client. Adding a new mutation endpoint
  means: pick the right `pubXxx*` helper at the top of
  `apps/daemon/src/server.ts` (or add one), call it after the DB
  write, extend `WsServerEvent` in `packages/contracts/src/index.ts`
  if the kind is new, and patch the cache in
  `apps/web/src/realtime.tsx` so React Query reflects the change
  without a refetch. Operators routinely drive the same task from
  several surfaces at once — one of them mutating a row and the
  others not seeing it for 30s is a bug, not a UX detail. Don't
  ever solve "the other surface didn't update" with polling.
- **Never hardcode model versions.** The model registry in
  `packages/core/src/config.ts` ships with claude family aliases only
  (`opus` / `sonnet` / `haiku`) — claude's CLI resolves these to the
  latest version at request time. Codex's list is auto-discovered
  from `~/.codex/models_cache.json` (read in
  `loadCodexModelsFromCache()` and surfaced via `GET /api/models`).
  Don't add `claude-opus-4-7`, `gpt-5.4`, or any other version-pinned
  string anywhere in code, tests, defaults, or UI placeholders. The
  one exception is operator overrides in `~/.agentd/config.json`'s
  `models.{claude,codex}` array — that's their call.

## Running the stack

```bash
bun install
bun --filter @agentd/web build         # produces apps/web/dist
bun --filter '*' typecheck              # all 11 packages must pass
bun apps/daemon/src/index.ts            # listens on 127.0.0.1:3773
```

Web dev with HMR (proxies to daemon):
```bash
bun --filter @agentd/web dev
```

Desktop app (Electron, loads the daemon URL — same UI, native window):
```bash
bun --filter @agentd/desktop start      # auto-spawns daemon if none running
bun --filter @agentd/desktop dev        # points at Vite on :5173 for HMR
```

There are no automated tests yet. Verify behavior end-to-end against
the daemon and curl the health endpoint:
```bash
curl -s http://127.0.0.1:3773/health
```

## Commit + PR style

- **Conventional commit, single-line subject.** `feat:`, `fix:`,
  `refactor:`, `docs:`, `chore:`, `style:`, `test:`, `perf:`, `ci:`,
  `build:`. Lowercase, imperative, under 70 chars.
- **No scope unless it's obvious from the diff.** `feat: add steer
  queue` not `feat(taskmgr): add steer queue` if the change spans
  several places.
- **PR body is a tight bullet list.** No `## Test plan` heading. Use
  the streaming PR generator (Ship → Open PR) when in doubt.
- The user's free-form `commitInstructions` / `prInstructions` from
  Settings are appended to the helper prompt — respect them.

## Working with tasks

- The agent commits + pushes its own work via the system-prompt
  directive in `apps/daemon/src/taskManager.ts > spawnRunner`. The
  daemon-side `maybeAutoCommit` post-hook is a safety net and
  becomes a no-op when the agent already committed.
- Auto-PR is opt-in (`task.autoPr`). Don't open PRs without it.
- Branches are named `<prefix>/<ai-suggested-slug>` (no task-id suffix),
  where the prefix is one of `feature`, `fix`, `refactor`, `chore` —
  the AI helper picks it from the prompt's intent (a "fix the X bug"
  prompt becomes `fix/...` rather than `feature/...`). Override at
  spawn time via the workspace setup's branch field.
- Per-task `model` and `thinkingLevel` columns let the user override
  defaults from `cfg.defaultModel` and `cfg.defaultThinking`. Pass
  through the runner's `--model` / `--effort` flags.

## Web app conventions

- **Tailwind only.** No CSS modules, no styled-components. Reuse the
  `cn` helper for conditional classes.
- **Lazy-load route components** in `App.tsx` via `lazy(() => import())`
  to keep the initial bundle small.
- **Realtime via `realtime.tsx`.** A single `/ws` subscription that
  invalidates / patches react-query caches on push. Don't poll lists —
  trust the bus.
- **No TanStack Mutation `onError` toasts** unless the caller can't
  surface the error itself; the toast is the caller's job.
- **Typecheck is part of the deal.** Run `bun --filter @agentd/web
  typecheck` before declaring a UI change done.

## Daemon conventions

- **One Hono app, one event bus, one DB.** `apps/daemon/src/server.ts`
  is intentionally one big file (currently ~6k lines). Keep new
  endpoints there unless you have a real reason to split.
- **WebSocket fan-out via `EventBus`.** Publish task events through
  the bus; the `/ws` upgrade handler subscribes per session. Never
  push directly to a websocket from a request handler.
- **PTY work runs in a Node subprocess** (`apps/daemon/src/pty-worker.cjs`)
  because `node-pty` misbehaves under Bun. Don't attempt to use
  `node-pty` from the daemon process directly.

## Desktop app conventions

- **Thin wrapper, no UI of its own — except the bootstrap connect page.**
  `apps/desktop` is a single `BrowserWindow` pointed at the daemon's HTTP
  UI. Every product UI change belongs in `apps/web`. The one allowed
  exception is `apps/desktop/src/connect.html` — a small static page
  shown only when no daemon is reachable, so the operator can type in a
  remote daemon URL without learning env vars. Don't grow it into a
  general settings panel; if a setting can be edited once a daemon is
  reachable, it belongs in the React app's Settings, not here.
- **`main.cjs` is plain CommonJS.** Electron's main runs in Node, not Bun.
  Match the existing `pty-worker.cjs` pattern. No new TypeScript build
  step. The connect page is plain HTML + a small inline script — no
  framework, no bundler.
- **Daemon spawn is opt-out, not opt-in.** Open the app and it tries to
  attach to a running daemon, then spawns `bun apps/daemon/src/index.ts`
  if none is reachable on `127.0.0.1:3773`. Respect
  `AGENTD_DESKTOP_NO_SPAWN=1` and `AGENTD_DESKTOP_URL` overrides.
- **Bootstrap URL is the one local-only setting.** The URL the operator
  picks in the connect page is persisted to
  `app.getPath('userData')/connection.json`. This is the single
  exception to the "cross-device state goes on the server" rule,
  because the URL *is* which server to talk to — chicken-and-egg. Don't
  add other settings to this file. `AGENTD_DESKTOP_URL` (env) trumps
  the saved URL; "Retry local" in the connect page clears it.
- **Don't bypass the HTTP boundary.** The renderer talks to the daemon
  the same way a browser does (HTTP+WS over 127.0.0.1). Don't expose
  Node APIs through the main-window preload to "make it faster" —
  `contextIsolation` stays on, `nodeIntegration` stays off. The
  connect window has its own `connect-preload.cjs` exposing only the
  bootstrap IPC channels (`agentd-connect:*`); never reuse it for the
  main window.
- **Packaging via electron-builder.** Config lives in
  `apps/desktop/electron-builder.yml`. `.github/workflows/desktop.yml`
  builds the macOS / Windows / Linux artifacts on `v*` tags.

## When in doubt

Read the closest existing example before inventing. The patterns in
this repo are deliberately uniform — picking one means inheriting
how it interacts with the realtime bus, react-query cache,
contracts schema, and migration system.
