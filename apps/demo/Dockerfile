# syntax=docker/dockerfile:1.7
#
# Bullpane public demo — everything in one image, for Cloudflare Containers
# (one container per instance, no compose): the dashboard, Redis and
# the simulator that keeps Redis busy, on SQLite (no database server).
# Build context is the repository root.
#
# Runs the FREE edition with BULLPANE_READ_ONLY=true: no login, every write
# refused by the server, and the only connection comes from
# BULLPANE_CONNECTIONS, so visitors cannot point it at anybody else's Redis.
# Nothing persists: every cold start is a fresh Redis and a fresh database,
# and start.sh caps a container's life so a demo never runs stale for days.

ARG NODE_IMAGE=node:22-alpine
ARG PNPM_VERSION=10.4.1

FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY apps/server/package.json    apps/server/
COPY apps/web/package.json       apps/web/
COPY apps/simulator/package.json apps/simulator/
COPY packages/shared/package.json          packages/shared/
COPY packages/inspector/package.json       packages/inspector/
COPY packages/redis-inspector/package.json packages/redis-inspector/
COPY packages/pg-inspector/package.json    packages/pg-inspector/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY packages ./packages
COPY apps/web ./apps/web
RUN pnpm --filter @bullpane/web build

FROM base AS runner
RUN apk add --no-cache redis tini
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    WEB_DIST=/app/apps/web/dist \
    BULLPANE_DATA_DIR=/tmp/bullpane \
    BULLPANE_READ_ONLY=true \
    BULLPANE_CONNECTIONS='[{"name":"Demo Redis","url":"redis://127.0.0.1:6379","prefix":"bull","cluster":false}]' \
    REDIS_URL=redis://127.0.0.1:6379 \
    BULL_PREFIX=bull \
    SIM_INTENSITY=1 \
    SIM_RESET=true
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY apps/server/package.json    apps/server/
COPY apps/web/package.json       apps/web/
COPY apps/simulator/package.json apps/simulator/
COPY packages/shared/package.json          packages/shared/
COPY packages/inspector/package.json       packages/inspector/
COPY packages/redis-inspector/package.json packages/redis-inspector/
COPY packages/pg-inspector/package.json    packages/pg-inspector/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter '!@bullpane/web'
COPY packages ./packages
COPY apps/server ./apps/server
COPY apps/simulator ./apps/simulator
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY apps/demo/start.sh /start.sh
RUN chmod +x /start.sh
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/start.sh"]
