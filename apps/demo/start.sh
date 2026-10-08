#!/bin/sh
# Boots the demo's three processes in dependency order. tini is PID 1 and reaps;
# if any process dies the container exits and Cloudflare starts a fresh one.
set -eu

# Redis: in memory only, capped, noeviction (evicting a job hash corrupts a queue).
redis-server --bind 127.0.0.1 --save "" --appendonly no \
  --maxmemory 192mb --maxmemory-policy noeviction --daemonize no &
REDIS_PID=$!

until redis-cli -h 127.0.0.1 ping >/dev/null 2>&1; do sleep 0.2; done

cd /app
pnpm --filter @bullpane/simulator start &
SIM_PID=$!
pnpm --filter @bullpane/server start &
APP_PID=$!

# Exit as soon as any of them exits, so a half-dead demo is replaced, not served.
# Also exit after DEMO_MAX_LIFETIME_S: bots keep the container awake past
# sleepAfter, and days of simulated traffic pile up failures and backlogs. The
# next request then boots a fresh demo (Redis refills in ~30 s).
started=$(date +%s)
while kill -0 "$REDIS_PID" "$SIM_PID" "$APP_PID" 2>/dev/null; do
  if [ $(( $(date +%s) - started )) -ge "${DEMO_MAX_LIFETIME_S:-7200}" ]; then
    echo "demo reached its max lifetime; stopping for a fresh one" >&2
    exit 0
  fi
  sleep 2
done
echo "a demo process exited; stopping the container" >&2
exit 1
