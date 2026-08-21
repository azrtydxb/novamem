# Port sync-qdrant-to-pgvector to go/cmd

Status: open
Created: 2026-08-20
Epic: repo-scripts-to-go
Sprint: 005-go-cli-tools-are-shippable-artifacts-and-the-last

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

- [ ] go/cmd/sync-qdrant-to-pgvector reproduces the script's behaviour (flags, env, fast-load pattern, idempotency)
- [ ] pgvector.go's remediation message points at the Go command
- [ ] scripts/sync-qdrant-to-pgvector.mjs deleted; docs references updated
- [ ] verified against a local qdrant + pgvector pair with a seeded corpus

## Evidence

