# PostgreSQL backup verification

NovaMem's cluster uses CloudNativePG (CNPG) base backups for PostgreSQL recovery. Those backups remain the operational recovery mechanism; this workflow periodically checks that a logical `pg_dump` artifact is readable, that the current server migrator can open its restored schema, and that restored public-table row counts and deterministic samples agree with the source. It complements CNPG by exercising a portable logical dump and the application's migration path. It does not verify Neo4j, vector-index, or object-volume recovery.

## Create and verify

Install PostgreSQL client/server utilities (`pg_dump`, `psql`, `initdb`, `pg_ctl`, `createdb`, `pg_restore`) and Go 1.26. Configure network and credentials for a read-only-capable source connection and an output directory restricted to operators:

```sh
export NOVAMEM_DATABASE_URL='postgres://…'
export NOVAMEM_BACKUP_DIR=/secure/backup/path
scripts/backup/backup.sh
scripts/backup/verify.sh
```

`backup.sh` writes a custom-format dump and adjacent JSON manifest atomically. The manifest records UTC timestamp, file name, byte size, SHA-256, and the latest `drizzle.__drizzle_migrations.created_at` schema version. Verification chooses the newest timestamped dump, validates its size and digest, restores into a fresh local temporary Postgres cluster, checks the manifest's schema version against the restored journal, runs `go/cmd/verify-restore`, then removes the temporary cluster. The Go verifier applies the embedded production migrator to the restored DB and compares public table row counts and SHA-256 checksums of up to 100 deterministically ordered rows per table. It emits only counts, version, and hashes; no data values are logged. Any mismatch or command failure exits nonzero.

## Scheduling and retention

Schedule the backup and verification as distinct steps in the same protected host or CI runner that can reach the source. Run the dump at the site's recovery-point objective and verification at least weekly (preferably after each scheduled dump). Do not expose database URLs or dump contents in CI logs. CI artifacts and filesystem backups contain production data: encrypt at rest and in transit, restrict access to the backup operators, and retain according to the organization's approved recovery and privacy policy. Keep enough generations to cover the recovery-point and recovery-time objectives; expire manifests and dump files together. A checksum manifest detects accidental corruption but is not a signature against an attacker who can replace both files.

Example cron (environment should be loaded from a protected file by the invoking service):

```cron
15 2 * * * cd /srv/novamem && scripts/backup/backup.sh && scripts/backup/verify.sh
```

## Pass criteria and limits

A pass requires a valid manifest, exact artifact size and SHA-256, successful restore into an isolated throwaway server, compatible/up-to-date migrations, and matching public-table counts and sample checksums. Nonzero exit is a failed check; preserve the concise stderr and investigate immediately. A pass validates only the newest logical PostgreSQL backup and these relational checks. It is not a full-stack recall test, a CNPG base-backup restore test, or verification of graph, vector, or persistent-volume state. Continue monitoring CNPG backup status and separately exercise those dependencies in the deployment's recovery plan.

For the Go integration test, set `NOVAMEM_TEST_DATABASE_URL` to a disposable Postgres database, following the Go CI job's URL convention. The test applies the migration set and checks content-drift detection.
