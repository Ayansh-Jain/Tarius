# syntax=docker/dockerfile:1
#
# ICE web image — @ice/web (React 19 + Vite SPA) served by nginx.
#
# Multi-stage:
#   1. `build`   — corepack pnpm, frozen-lockfile install of the workspace, then
#                  `pnpm --filter @ice/web build` (tsc typecheck + `vite build`).
#                  Vite emits the static bundle to apps/web/dist.
#   2. runtime   — nginx:alpine serving that bundle on :3000 and reverse-proxying
#                  /api + /sync to the `server` service (see scripts/web-nginx.conf).
#
# Build context MUST be the repo root (docker-compose.yml `context: ..`) so the
# lockfile and the `packages/shared` workspace dependency are available.

# ---------------------------------------------------------------------------
# Stage 1: build the static bundle.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app

# Manifests first for layer caching.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json ./apps/web/package.json
COPY apps/server/package.json ./apps/server/package.json
COPY packages/shared/package.json ./packages/shared/package.json

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# Sources needed to build the web bundle (web app + its shared workspace dep + tsconfig).
COPY tsconfig.base.json ./tsconfig.base.json
COPY packages/shared ./packages/shared
COPY apps/web ./apps/web

# Produce the production bundle -> /app/apps/web/dist
RUN pnpm --filter @ice/web build

# ---------------------------------------------------------------------------
# Stage 2: static runtime (nginx).
# ---------------------------------------------------------------------------
FROM nginx:1.27-alpine AS runtime

# Replace the stock site with our SPA + reverse-proxy config.
# COPY source is relative to the build context (the repo root).
RUN rm -f /etc/nginx/conf.d/default.conf
COPY scripts/web-nginx.conf /etc/nginx/conf.d/ice.conf

# Ship the built SPA.
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

EXPOSE 3000
# nginx:alpine's default CMD already runs nginx in the foreground (`daemon off;`).
