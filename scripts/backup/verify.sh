#!/usr/bin/env bash
set -euo pipefail

: "${NOVAMEM_DATABASE_URL:?set NOVAMEM_DATABASE_URL to the source database}"
BACKUP_DIR=${NOVAMEM_BACKUP_DIR:-./backups}
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
command -v initdb >/dev/null || { echo 'initdb is required' >&2; exit 1; }
command -v pg_ctl >/dev/null || { echo 'pg_ctl is required' >&2; exit 1; }
command -v pg_restore >/dev/null || { echo 'pg_restore is required' >&2; exit 1; }
command -v createdb >/dev/null || { echo 'createdb is required' >&2; exit 1; }
command -v go >/dev/null || { echo 'go is required' >&2; exit 1; }
command -v psql >/dev/null || { echo 'psql is required' >&2; exit 1; }
if command -v sha256sum >/dev/null; then
	sha256() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null; then
	sha256() { shasum -a 256 "$1" | awk '{print $1}'; }
else
	echo 'sha256sum or shasum is required' >&2
	exit 1
fi

backup=$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'novamem-*.dump' -print | sort | tail -n 1)
[[ -n "$backup" ]] || { echo "no backup found in $BACKUP_DIR" >&2; exit 1; }
manifest="$backup.json"
[[ -f "$manifest" ]] || { echo "missing manifest: $manifest" >&2; exit 1; }
expected_sha=$(sed -nE 's/.*"sha256":"([0-9a-f]{64})".*/\1/p' "$manifest")
expected_size=$(sed -nE 's/.*"size_bytes":([0-9]+).*/\1/p' "$manifest")
expected_schema=$(sed -nE 's/.*"schema_version":([0-9]+).*/\1/p' "$manifest")
[[ -n "$expected_sha" && -n "$expected_size" && -n "$expected_schema" ]] || { echo "invalid backup manifest: $manifest" >&2; exit 1; }
actual_sha=$(sha256 "$backup")
actual_size=$(wc -c < "$backup" | tr -d '[:space:]')
[[ "$actual_sha" == "$expected_sha" ]] || { echo 'backup SHA-256 mismatch' >&2; exit 1; }
[[ "$actual_size" == "$expected_size" ]] || { echo 'backup size mismatch' >&2; exit 1; }

workdir=$(mktemp -d "${TMPDIR:-/tmp}/novamem-restore.XXXXXX")
port=${NOVAMEM_VERIFY_PGPORT:-$((20000 + RANDOM % 30000))}
cleanup() { pg_ctl -D "$workdir/data" -m immediate -w stop >/dev/null 2>&1 || true; rm -rf "$workdir"; }
trap cleanup EXIT
initdb -D "$workdir/data" --auth=trust -U postgres >/dev/null
pg_ctl -D "$workdir/data" -o "-p $port -k $workdir -c listen_addresses=127.0.0.1" -l "$workdir/postgres.log" -w start >/dev/null
createdb -h 127.0.0.1 -p "$port" -U postgres novamem_verify
restored_url="postgres://postgres@127.0.0.1:$port/novamem_verify?sslmode=disable"
pg_restore --exit-on-error --no-owner --no-acl --dbname="$restored_url" "$backup"
restored_schema=$(psql "$restored_url" -X -A -t -v ON_ERROR_STOP=1 -c 'SELECT coalesce(max(created_at),0) FROM "drizzle"."__drizzle_migrations"')
[[ "$restored_schema" == "$expected_schema" ]] || { echo "manifest schema version $expected_schema does not match restored backup $restored_schema" >&2; exit 1; }
(cd "$ROOT/go" && NOVAMEM_DATABASE_URL="$NOVAMEM_DATABASE_URL" NOVAMEM_RESTORED_DATABASE_URL="$restored_url" go run ./cmd/verify-restore)
