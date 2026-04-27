# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────────────────
# /agentd — multi-stage image
#
#   Stage 1 (build):    install deps + compile the React/Vite bundle.
#   Stage 2 (runtime):  slim bun image with git, gh, the agent CLIs.
#
# The runtime image expects state to be persisted via a volume mounted at
# /data. Repos to spawn agents against should be mounted under /repos and
# passed by absolute path when creating tasks.
# ─────────────────────────────────────────────────────────────────────────

ARG BUN_VERSION=1.3.13

# ───────────── build stage ─────────────
FROM oven/bun:${BUN_VERSION} AS build
WORKDIR /build

# Copy lockfile + workspace manifests first so dep installs cache between
# code-only changes.
COPY package.json bun.lock tsconfig.base.json ./
COPY apps/cli/package.json        apps/cli/
COPY apps/daemon/package.json     apps/daemon/
COPY apps/discord/package.json    apps/discord/
COPY apps/telegram/package.json   apps/telegram/
COPY apps/web/package.json        apps/web/
COPY packages/agent-runner/package.json packages/agent-runner/
COPY packages/client/package.json       packages/client/
COPY packages/contracts/package.json    packages/contracts/
COPY packages/core/package.json         packages/core/

RUN bun install --frozen-lockfile

# Now copy the source and build the web bundle.
COPY apps/      ./apps/
COPY packages/  ./packages/
RUN bun --filter @agentd/web build

# ───────────── runtime stage ─────────────
FROM oven/bun:${BUN_VERSION} AS runtime

# git is needed for worktrees, ca-certificates + curl for fetching gh/agent
# CLIs, gnupg + apt-utils for the gh apt repo, jq is genuinely useful for
# debugging /api responses from inside the container.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        gnupg \
        jq \
        tini \
    && rm -rf /var/lib/apt/lists/*

# gh CLI (needed for auto-PR; falls back to a plain push if you don't auth it)
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        | gpg --dearmor -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Agent CLIs. Both are npm-installable and resolve `claude` and `codex` on
# PATH respectively. Authentication is via env (ANTHROPIC_API_KEY,
# OPENAI_API_KEY) or by mounting their config dirs — see docs/docker.md.
RUN bun install -g @anthropic-ai/claude-code @openai/codex

WORKDIR /app

# Copy installed deps and built source from the build stage. We deliberately
# copy node_modules wholesale rather than re-installing, so we avoid the
# 'npm install in two places' overhead and the runtime image stays
# bit-for-bit consistent with what `bun install` produced.
COPY --from=build /build/node_modules           ./node_modules
COPY --from=build /build/package.json           ./
COPY --from=build /build/bun.lock               ./
COPY --from=build /build/tsconfig.base.json     ./
COPY --from=build /build/apps                   ./apps
COPY --from=build /build/packages               ./packages

# Default git author for the auto-commit machinery; override in compose.
ENV GIT_AUTHOR_NAME=agentd \
    GIT_AUTHOR_EMAIL=agentd@local \
    GIT_COMMITTER_NAME=agentd \
    GIT_COMMITTER_EMAIL=agentd@local \
    AGENTD_ROOT=/data \
    AGENTD_HOST=0.0.0.0 \
    AGENTD_PORT=3773

# Persistent state. Mount a named volume here in compose.
VOLUME ["/data"]

EXPOSE 3773

# tini reaps zombie subprocesses (we spawn lots of children: claude, codex,
# git, the bot bridges). Without it, killed agents hang around as zombies.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "apps/daemon/src/index.ts"]

HEALTHCHECK --interval=15s --timeout=4s --start-period=8s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${AGENTD_PORT:-3773}/health" || exit 1
