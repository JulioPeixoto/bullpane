# Railway build of the dashboard: the `runner` target of /Dockerfile, reshaped
# for two Railway constraints.
#
#  1. Railway cannot choose a build target and builds the LAST stage. The root
#     Dockerfile ends with `simulator`, so building it as-is ships the traffic
#     generator instead of the dashboard.
#  2. Railway only accepts cache mounts whose id carries the service id
#     (`id=s/<service id>-<path>`, docs.railway.com/builds/dockerfiles), which a
#     repository cannot know in advance. No cache mounts here.
#
# Installs are selected with `--filter <pkg>...` over the whole workspace rather
# than copying each package.json by hand, so a package added upstream does not
# silently fall out of the image.

ARG NODE_IMAGE=node:22-alpine
ARG PNPM_VERSION=10.4.1

FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile --filter "@bullpane/web..."
RUN pnpm --filter @bullpane/web build

FROM base AS runner
COPY . .
# tsx and typescript are devDependencies and run the server (see the root
# Dockerfile header), so NODE_ENV=production is set only after the install.
RUN pnpm install --frozen-lockfile --filter "@bullpane/server..."
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    WEB_DIST=/app/apps/web/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
RUN addgroup -S bullpane && adduser -S bullpane -G bullpane && chown -R bullpane:bullpane /app
USER bullpane
EXPOSE 3000
# tsx directly, not `pnpm start`: corepack's pnpm lives in root's cache, so as
# `bullpane` it would be downloaded again on every boot, and pnpm would sit
# between Railway's SIGTERM and the server's graceful shutdown.
WORKDIR /app/apps/server
CMD ["node_modules/.bin/tsx", "src/index.ts"]
