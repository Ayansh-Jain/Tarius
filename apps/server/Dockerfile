# syntax=docker/dockerfile:1
#
# ICE server image — @ice/server (Hocuspocus realtime + Hono REST + SQLite).
#
# Multi-stage:
#   1. `deps`  — corepack pnpm, install the WHOLE monorepo from the frozen lockfile
#                so the workspace symlink farm (apps/server -> packages/shared) is wired
#                up exactly the way `pnpm install` produces it locally.
#   2. runtime — slim node:22 image that carries the pruned workspace sources plus the
#                pnpm virtual store, and runs the server with `tsx` (the server's start
#                script). `@ice/shared` is consumed as TypeScript source via `workspace:*`,
#                so there is no compile step for the server — tsx loads .ts directly.
#
# Build context MUST be the repo root (see docker-compose.yml `context: ..`), because we
# need the root manifests, the lockfile, and the `packages/shared` workspace dependency.

# ---------------------------------------------------------------------------
# Stage 1: install dependencies for the whole workspace (cached on manifests).
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS deps
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Pin the pnpm version declared by the repo's packageManager field.
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app

# Copy only what `pnpm install` needs first, so this layer caches across source edits.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/server/package.json ./apps/server/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/shared/package.json ./packages/shared/package.json

# Frozen install of the entire workspace. We keep web's deps too because the lockfile is
# a single graph; a partial `--filter` install would still hydrate the shared store, and
# keeping it whole keeps the install reproducible against the committed lockfile.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# Bring in the rest of the sources the server needs at runtime (tsx reads TS directly).
COPY tsconfig.base.json ./tsconfig.base.json
COPY packages/shared ./packages/shared
COPY apps/server ./apps/server
COPY scripts ./scripts

# ---------------------------------------------------------------------------
# Stage 2: runtime.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

# `tini` gives us a real init for clean signal handling; our shell entrypoint also execs,
# but tini protects against zombie reaping if tsx spawns helpers.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Carry over the fully-installed workspace (node_modules + pnpm virtual store + sources).
# Copying the whole /app tree preserves pnpm's symlink farm so `@ice/shared` resolves.
COPY --from=deps /app /app

# Persisted runtime state (SQLite db, generated secret, git repos) lives here and is a
# named volume in docker-compose. Declared so the path exists even without compose.
RUN mkdir -p /app/data
VOLUME ["/app/data"]

# Zero required configuration: the entrypoint generates + persists ICE_SESSION_SECRET on
# first boot if the operator did not supply one.
ENV PORT=8080
ENV ICE_DATA_DIR=/app/data
ENV DATABASE_URL=file:/app/data/ice.sqlite
ENV ICE_GIT_ROOT=/app/data/repos
EXPOSE 8080

COPY --from=deps /app/scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# tini -> entrypoint (resolves secret) -> pnpm start (tsx src/index.ts).
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["pnpm", "--filter", "@ice/server", "start"]
