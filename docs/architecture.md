# Architecture

## Process model

```
                  ┌─────────────────────────────────────────┐
                  │  Host (your laptop / VPS / Mac mini)    │
                  │                                         │
                  │  ┌─────────────────────────────────┐    │
   tailnet  ─────▶│  apps/daemon (Bun + Hono + ws)   │    │
                  │  │                                 │    │
                  │  │  ├─ TaskManager                 │    │
                  │  │  ├─ Scheduler  (1-min tick)    │    │
                  │  │  ├─ PluginManager ──┬─▶ apps/telegram (subprocess)
                  │  │  ├─ EventBus       └─▶ apps/discord  (subprocess)
                  │  │  └─ SQLite (WAL)                │    │
                  │  └─────┬───────────────────────────┘    │
                  │        │                                 │
                  │        ▼  spawns one per task            │
                  │   ┌──────────────────┐                   │
                  │   │ ClaudeRunner /    │                   │
                  │   │ CodexRunner       │ ── writes ──▶ git worktree
                  │   │ (child process)   │                   │
                  │   └──────────────────┘                   │
                  └─────────────────────────────────────────┘

   Clients (any number, any device on the tailnet):
     - Web UI (apps/web/dist served by daemon)
     - apps/cli over HTTP+WS
     - Telegram bot (subprocess) → outbound to Telegram, inbound from your phone
     - Discord bot (subprocess) → outbound to Discord, inbound from your phone
```

The daemon is the only stateful process. Bots, the web UI, and the CLI are all clients
of the same HTTP+WS surface (`@agentd/client`). Plugins (Telegram/Discord) happen to
live inside the daemon's supervision tree, but they talk to it over the same API a
remote browser would.

## Data flow for a single task

```
1. POST /api/tasks { agent, repoPath, prompt, autoPush?, autoPr? }
       │
       ▼
2. TaskManager.create:
       ├─ git worktree add <root>/worktrees/<task-id> -b agentd/<slug> <base>
       ├─ INSERT INTO tasks
       ├─ APPEND user message
       └─ spawnRunner(task, prompt, resume=false)
       │
       ▼
3. Runner spawns the agent CLI (claude --output-format stream-json …) in the worktree.
       │
       ▼
4. Each line of stdout → parsed → emitted as AgentEvent via runner.on()
       │
       ▼
5. TaskManager.handleEvent:
       ├─ persists chat / tool / status to DB
       ├─ accumulates token usage on the task row
       └─ publishes envelope to EventBus
            │
            ▼
6. EventBus listeners:
       ├─ WS /ws subscribers (web UI live chat, CLI `attach`)
       └─ PluginManager-spawned bots can subscribe and notify their chats
       │
       ▼
7. Runner exits → status: done|failed → exit event
       │
       ▼
8. TaskManager.runCompletionHooks(taskId):
       ├─ maybeAutoCommit  (git add -A && git commit)
       ├─ maybePush        (git push -u origin <branch>)         if autoPush
       └─ maybeOpenPr      (gh pr create)                        if autoPr
```

## Key design decisions

### Worktree per task
Two parallel agents trying to edit the same checkout would step on each other and
corrupt the working tree. By giving every task its own worktree on its own branch, we
get true isolation with negligible disk cost (worktrees share the bare repo's object
store).

### One DB
Everything — tasks, messages, templates, schedules, sessions, pairing tokens, plugin
config — lives in a single SQLite file in WAL mode. Simple, atomic, easy to back up.

### Pairing → session, not API keys
A pairing token is one-time and short-lived (10 min). Exchanging it mints a long-lived
session token stored hashed in the DB. Devices and bots all use the same auth shape;
the only difference is plugins get their session minted by the daemon itself
(`createSystemSession`) and the value stashed in `<root>/config.json`.

### EventBus
Single in-process pub/sub. Two subscription modes (`subscribeAll` and `subscribeTask`)
are enough for the current frontends. If we ever need cross-host fan-out, the EventBus
is the obvious place to tee into Redis pub/sub, but for one-host operation in-process is
fine.

### `--append-system-prompt` for agent instructions
The agent CLI has its own system prompt; we append rather than replace, so the instructions
stack: agent's defaults + agentd's privacy-respecting overlay. Editable via
`agentd settings set agentInstructions "..."` so you can swap policy at runtime.

### Status before exit (always)
Every runner emits `{ kind: "status", status: "done"|"failed" }` **before**
`{ kind: "exit", code }`. TaskManager unsubscribes the runner listener on `exit`, so
status emitted after exit would be lost. This is the most subtle bug to avoid when
adding a new runner.

### Plugin process supervision
Bots are full-blown subprocesses, not in-process listeners, for two reasons:
1. They have ugly transport dependencies (grammY pulls a lot, discord.js even more) we
   don't want in the core daemon's bundle.
2. A bot crash (network timeout, malformed update) shouldn't take the daemon down. The
   PluginManager restarts them with exponential backoff and gives up after 8 crashes
   per hour.

## File map

See [README.md § Layout](../README.md#layout). Cross-referencing:

- `packages/contracts` — types only. No runtime work.
- `packages/core` — DB and pure helpers. Imported by daemon and from inside packages.
  Never imports from `apps/`.
- `packages/agent-runner` — process management for agents.
- `packages/client` — HTTP+WS client used by all consumers.
- `apps/daemon` — owns SQLite, schedules, plugins, agent runners.
- `apps/cli` — single binary CLI; thin wrapper around `@agentd/client`.
- `apps/web` — Vite + React; built to `apps/web/dist/` and served by the daemon.
- `apps/telegram`, `apps/discord` — managed by the daemon's PluginManager.
