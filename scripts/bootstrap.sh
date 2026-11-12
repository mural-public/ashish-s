#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# ---- Preflight ----------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "✗ Node.js not found. Install Node 20+: https://nodejs.org"
  exit 1
fi
NODE_MAJOR=$(node --version | sed 's/^v//' | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "✗ Node $(node --version) detected. This project requires Node 20+."
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "✗ Docker not found. Install Docker Desktop: https://www.docker.com/products/docker-desktop"
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "✗ Docker daemon is not running. Start Docker Desktop and re-run."
  exit 1
fi

# ---- Env ----------------------------------------------------------------
if [ ! -f .env ]; then
  echo "✗ .env not found. Run:"
  echo "    cp .env.example .env"
  echo "  Then append the three credentials your interviewer pasted in chat,"
  echo "  then re-run npm run bootstrap."
  exit 1
fi

if ! grep -qE '^MURAL_API_KEY=.+' .env; then
  echo "✗ MURAL_API_KEY is missing from .env."
  echo "  Append the heredoc block your interviewer pasted in chat, then re-run."
  exit 1
fi

echo "→ Installing npm dependencies..."
npm install --silent

echo "→ Bringing up Postgres via Docker..."
docker compose up -d postgres

echo "→ Waiting for Postgres to be ready..."
PG_READY=0
for i in $(seq 1 30); do
  if docker compose exec -T postgres pg_isready -U postgres > /dev/null 2>&1; then
    PG_READY=1
    break
  fi
  sleep 1
done
if [ "$PG_READY" -ne 1 ]; then
  echo "✗ Postgres did not become ready within 30s. Recent container logs:"
  docker compose logs --tail 40 postgres
  exit 1
fi

# A postgres image upgrade under an existing data volume can leave every
# database with a libc collation version mismatch. Postgres then rejects
# CREATE DATABASE (which prisma db push relies on) with:
#   ERROR: template database "template1" has a collation version mismatch
# Detect the warning and refresh the recorded collation versions in place.
if docker compose exec -T postgres psql -U postgres -d template1 -tAc "SELECT 1" 2>&1 | grep -qi "collation version mismatch"; then
  echo "→ Detected collation version mismatch; refreshing collation versions..."
  for db in $(docker compose exec -T postgres psql -U postgres -tAc "SELECT datname FROM pg_database WHERE datname <> 'template0'"); do
    docker compose exec -T postgres psql -U postgres -d postgres \
      -c "ALTER DATABASE \"$db\" REFRESH COLLATION VERSION;"
  done
fi

echo "→ Generating Prisma client..."
npx prisma generate

echo "→ Syncing database schema..."
if ! npx prisma db push --skip-generate --accept-data-loss; then
  echo "✗ Database schema sync failed. Recent Postgres server logs:"
  docker compose logs --tail 40 postgres
  echo "  If the logs mention a collation version mismatch, the data volume was"
  echo "  initialized by an older postgres image. Reset it with:"
  echo "    docker compose down -v && npm run bootstrap"
  exit 1
fi

echo "→ Seeding contractors..."
npm run db:seed

echo
echo "✓ Bootstrap complete."
echo "  Run 'npm run doctor'  to verify Mural connectivity."
echo "  Run 'npm run dev'     to start the server."
