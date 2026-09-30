# Railway

Two services in one Railway project: the dashboard (this repository) and MySQL.
Redis is yours, usually already running in the same project.

A Railway domain is public, and the free edition has no login, so this setup
puts HTTP Basic auth in front of everything (`BULLPANE_BASIC_AUTH_*`, see
`apps/server/src/auth/basic.ts`). It is one shared credential, not accounts:
per-person users, roles and the audit trail are the Pro `users` feature.

## 1. MySQL

**New → Database → MySQL.** Nothing to configure; the dashboard creates its
tables on boot.

## 2. The dashboard

**New → GitHub Repo →** this repository.

No `railway.json` on purpose: Railway stops reading Config as Code files on
2026-12-01, and without it the build would fall back to the root Dockerfile,
which ends on the simulator. The two settings below live on the service instead:

- Variable `RAILWAY_DOCKERFILE_PATH` = `deploy/railway/Dockerfile` (see its
  header for why not the root one).
- **Settings → Deploy → Healthcheck Path** = `/api/health`, so a deploy only
  takes traffic once MySQL is reachable and migrations ran.

Variables, with `MySQL` and `Redis` being your services' names:

| Variable | Value | Why |
|---|---|---|
| `RAILWAY_DOCKERFILE_PATH` | `deploy/railway/Dockerfile` | Build the dashboard, not the simulator |
| `DATABASE_URL` | `${{MySQL.MYSQL_URL}}` | Private network, no egress |
| `BULLPANE_BASIC_AUTH_USER` | e.g. `ops` | Without both of these the dashboard is open to anyone with the URL |
| `BULLPANE_BASIC_AUTH_PASSWORD` | 32+ random characters | |
| `BULLPANE_READ_ONLY` | `true` | Start read-only (`docs/PRODUCTION-TRIAL.md`) |
| `BULLPANE_CONNECTIONS` | `[{"name":"Production","url":"${{Redis.REDIS_URL}}?family=0","prefix":"bull"}]` | Seeds the connection at boot, no click needed |
| `PUBLIC_URL` | `https://${{RAILWAY_PUBLIC_DOMAIN}}` | Used in alert links |

- `?family=0` lets ioredis resolve the private hostname over IPv4 or IPv6;
  Railway's private DNS may answer IPv6 only, and ioredis looks up IPv4 by default.
- `prefix` must match the `prefix` your BullMQ queues use (`bull` is BullMQ's default).
- `BULLPANE_CONNECTIONS` creates a connection only when none of that name exists;
  changing the variable later does not update it. Rename the entry, or edit it in
  the UI with read-only off.
- `PORT` is injected by Railway and honoured by the image.

Then **Settings → Networking → Generate Domain**.

## 3. Check

- `GET /api/health` answers 200 without credentials (the healthcheck needs that).
- Opening the domain makes the browser ask for the user and password.
- The boot banner says `auth    : HTTP Basic auth (BULLPANE_BASIC_AUTH_*)`.

## Redis connections

The dashboard keeps one Redis connection per configured connection (its read
client), plus one per queue the first time a write reaches that queue. On a
Redis with a low `maxclients`, check `INFO clients` before adding it.
