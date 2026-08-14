#!/usr/bin/env bash
# Full conformance run against a local docker-compose novamem.
# For the bench oracle instead, skip this script and run:
#   NOVAMEM_URL=... NOVAMEM_AUTH_MODE=user NOVAMEM_ORIGIN=... \
#   NOVAMEM_TEST_TOKEN=... NOVAMEM_ADMIN_TOKEN=... \
#   NOVAMEM_ADMIN_EMAIL=... NOVAMEM_ADMIN_PASSWORD=... pnpm conformance
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose up -d
trap 'docker compose down' EXIT
URL="${NOVAMEM_URL:-http://localhost:7778}"
for i in $(seq 1 60); do
  curl -fsS "$URL/ready" >/dev/null 2>&1 && break
  sleep 2
  [ "$i" = 60 ] && { echo "server never became ready" >&2; exit 1; }
done
NOVAMEM_URL="$URL" pnpm --filter @azrtydxb/novamem-conformance test
