#!/bin/sh
set -e

cd /app

STATE_DIR="${POLARIS_STATE_DIR:-/app/state}"
ENV_FILE="$STATE_DIR/.env"

mkdir -p "$STATE_DIR/data/backups" "$STATE_DIR/public/uploads"
touch "$ENV_FILE"

if [ -s "$ENV_FILE" ]; then
  set -a
  . "$ENV_FILE"
  set +a
fi

if [ -n "${DATABASE_URL:-}" ]; then
  echo "[entrypoint] Applying Prisma migrations..."
  if ! npx --no-install prisma migrate deploy; then
    echo "[entrypoint] WARN: prisma migrate deploy failed; continuing anyway." >&2
  fi
else
  echo "[entrypoint] No DATABASE_URL set — first-run setup wizard will start."
fi

exec node --env-file="$ENV_FILE" dist/index.js
