#!/usr/bin/env bash
set -euo pipefail

: "${NOVAMEM_DATABASE_URL:?set NOVAMEM_DATABASE_URL to the database to back up}"
BACKUP_DIR=${NOVAMEM_BACKUP_DIR:-./backups}
mkdir -p "$BACKUP_DIR"
command -v pg_dump >/dev/null || { echo 'pg_dump is required' >&2; exit 1; }
command -v psql >/dev/null || { echo 'psql is required' >&2; exit 1; }
if command -v sha256sum >/dev/null; then
	sha256() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null; then
	sha256() { shasum -a 256 "$1" | awk '{print $1}'; }
else
	echo 'sha256sum or shasum is required' >&2
	exit 1
fi

stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup="$BACKUP_DIR/novamem-$stamp.dump"
tmp="$backup.tmp"
manifest="$backup.json"
manifest_tmp="$manifest.tmp"
trap 'rm -f "$tmp" "$manifest_tmp"' EXIT
pg_dump --format=custom --no-owner --no-acl --dbname="$NOVAMEM_DATABASE_URL" --file="$tmp"
mv "$tmp" "$backup"
size=$(wc -c < "$backup" | tr -d '[:space:]')
sha=$(sha256 "$backup")
schema=$(psql "$NOVAMEM_DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 -c 'SELECT coalesce(max(created_at),0) FROM "drizzle"."__drizzle_migrations"')
[[ "$schema" =~ ^[0-9]+$ ]] || { echo 'could not read numeric migration schema version' >&2; exit 1; }
printf '{"timestamp":"%s","file":"%s","size_bytes":%s,"sha256":"%s","schema_version":%s}\n' "$stamp" "$(basename "$backup")" "$size" "$sha" "$schema" > "$manifest_tmp"
mv "$manifest_tmp" "$manifest"
printf 'backup created: %s (%s bytes), schema_version=%s\n' "$backup" "$size" "$schema"
