# Contributing

Thanks for taking a look. agentd is a small project; the contribution surface is
deliberately narrow.

## Local setup

```bash
git clone <fork-url> ~/agentd
cd ~/agentd
bun install
bun --filter @agentd/web build
bun --filter '*' typecheck
```

Then in three terminals (or split panes):

```bash
# 1. Daemon
bun apps/daemon/src/index.ts --root /tmp/agentd-dev

# 2. Web (Vite dev server with HMR; proxies API/WS to the daemon)
bun --filter @agentd/web dev

# 3. CLI (against the daemon you just started)
bun apps/cli/src/index.ts pair --server http://127.0.0.1:3773 --token <token-from-daemon>
bun apps/cli/src/index.ts ls
```

## Project layout

A full tour lives in [README.md](./README.md). The guiding principles:

- **Workspace packages** under `packages/` are pure libraries. They never import from
  apps/.
- **Apps** under `apps/` are the deployables. They depend on packages but not on each
  other (`@agentd/client` is the one shared cross-app surface; the daemon spawns the
  bots as subprocesses, not by import).
- **`@agentd/contracts`** is the single source of truth for cross-package types. If you
  add a new entity (a new kind of object the API talks about), define it as a zod schema
  there first.

## Adding a new agent runner

1. Implement the `AgentRunner` interface in `packages/agent-runner/src/<your>.ts`.
2. **Always emit `kind: "status", status: "done"|"failed"` BEFORE `kind: "exit"`.** The
   TaskManager unsubscribes on exit, so any event after exit is silently lost.
3. Add the runner to `createRunner()` in `packages/agent-runner/src/index.ts` and to the
   `AgentKind` enum in `packages/contracts/src/index.ts`.
4. Spawn the underlying CLI with whatever flag combination produces a stream of
   structured events (JSON-per-line is easiest); parse them in your runner and emit
   `AgentEvent`s.

## Adding an API endpoint

1. Add the request schema to `packages/contracts/src/index.ts`.
2. Add a method to `AgentdClient` in `packages/client/src/index.ts`.
3. Add the route in `apps/daemon/src/server.ts` under the `api` router (so it's behind
   `requireSession`).
4. If a CLI surface makes sense, wire it in `apps/cli/src/index.ts`.
5. If the web UI should expose it, add it to the relevant view in `apps/web/src/views/`.

## Code style

- TypeScript strict mode with `noUncheckedIndexedAccess`.
- Comments explain *why*, not what. If a fix is non-obvious from the diff, leave a
  comment for the next reader.
- Error handling: bubble errors with context (`throw new Error("git push failed: " + …)`).
  Don't silently swallow unless there's a comment explaining why.
- Logs: prefix with the source (e.g. `[scheduler]`, `[telegram:stderr]`) so they're easy
  to filter when multiple subprocesses are interleaved.

## Tests

There aren't formal tests yet (this project ships ahead of its harness). When adding new
behaviour, smoke-test it end-to-end against a throwaway daemon (use `--root /tmp/...`).

## Commits

Conventional-ish: imperative mood, ≤72 char subject, body explains *why*. We're not
strict about a particular `feat:`/`fix:` prefix.

Don't include AI-attribution trailers (`Co-Authored-By:`, `Generated with`, etc.) in
commit messages. The agent system prompt agentd ships is configured to suppress them in
its own output too.

## Reporting bugs

Include:

- What you ran (`bun apps/cli/src/index.ts ...`).
- The daemon log (`<root>/agentd.db.wal` + console output).
- The output of `agentd plugin status` and `agentd settings show` if relevant.

Token-bearing fields are: `botToken`, `pluginSessionToken`, `sessionToken`. Redact those
before pasting.
