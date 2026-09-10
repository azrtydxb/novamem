# Port sync-qdrant-to-pgvector to go/cmd

Status: done 2026-08-21
Created: 2026-08-20
Epic: repo-scripts-to-go
Sprint: 005-go-cli-tools-are-shippable-artifacts-and-the-last-operator

## Description

scripts/sync-qdrant-to-pgvector.mjs is operator tooling the Go server
itself points at (the pgvector primary-key remediation message in
go/internal/coldstore/pgvector.go). An operator running a Go server
should not need a Node environment for the remediation the server
prescribes. Port to go/cmd/sync-qdrant-to-pgvector preserving the
fast-load pattern (drop per-partition HNSW indexes, batched inserts,
rebuild under large maintenance_work_mem) and idempotency (ON CONFLICT
DO NOTHING; re-runnable after a crash).

## Acceptance criteria

- [x] go/cmd/sync-qdrant-to-pgvector reproduces the script's behaviour (flags, env, fast-load pattern, idempotency)
- [x] pgvector.go's remediation message points at the Go command
- [x] scripts/sync-qdrant-to-pgvector.mjs deleted; docs references updated
- [x] verified against a local qdrant + pgvector pair with a seeded corpus

## Evidence

- Behaviour preserved: --partitions (default 32), QDRANT_URL / NOVAMEM_WARM_URL, drop-then-rebuild HNSW per partition, 512-point scroll paging, entryId→warm-row resolution, scope = u:<user_id> or p:<project_id>, batched multi-row INSERT with ON CONFLICT DO NOTHING, and the rebuild on ONE dedicated session at maintenance_work_mem=256MB with parallel workers off (both comments explaining WHY — pooled SET lands on another backend; a bigger value OOM-killed a 2Gi pod — carried over).
- VERIFIED against real containers (qdrant v1.12.4 + pgvector pg16), no models involved since vectors are copied as-is: 700 points across 2 collections (>512, so paging is exercised) against 660 warm rows, with 40 deliberate orphans.
  - result: "DONE: 660 vectors, 40 orphans, 2 collections" — exactly the seeded numbers
  - placement: 0 scope mismatches and 0 namespace mismatches when joined back to memory_entries; 440 user-scoped, 220 project-scoped, 9 distinct scopes; payload round-trips (entryId matches on all 660)
  - fidelity: sampled non-orphan vectors compare equal to Qdrant's to 1e-6
  - orphans: 0 rows written for the 40 entries with no warm row
  - indexes: 32 HNSW indexes dropped and rebuilt
  - idempotency: a second full run leaves 660 rows, no duplicates
- One addition beyond a literal port: the Qdrant client sends `api-key` from NOVAMEM_COLD_API_KEY — the same variable the server's own Qdrant client reads. Without it the tool cannot talk to a secured Qdrant, i.e. exactly the deployments that would run a migration.
- go build/vet green, golangci-lint 0 issues; the .mjs is deleted and the server's own pgvector remediation message plus the k8s install docs now point at the Go command.
