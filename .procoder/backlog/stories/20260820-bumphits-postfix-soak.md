# Confirm the BumpHitsMany deadlock fix under soak

Status: done 2026-08-20
Created: 2026-08-20
Epic: post-migration-gaps
Sprint: 002-server-module-gated-and-soak-proven-the-mcp-stdio-shim

## Description

The audit's soak ran the pre-fix binary; DEFECT-10's fix (sorted lock
order in the memory_access upsert) has never been confirmed to take the
deadlock WARN count to zero. Audit §10 lists this explicitly.

## Acceptance criteria

- [x] soak (≥20 min, concurrent search + write load) against the fixed binary shows zero "async bumpHitsMany failed" WARNs
- [x] result recorded in the parity audit doc or its successor

## Evidence

- rig: local pgvector Postgres + 10-entry namespace with perfectly inverted keyword relevance for two queries (verified: same 10 ids, exactly reversed order), 12 concurrent workers, rate limiter off — degraded keyword-only search still calls BumpHitsMany on the fused top-k
- control build (slices.Sort removed): 173 "deadlock detected (SQLSTATE 40P01)" in 3 min / 511 searches — the rig provably triggers the race, so the zero below is meaningful
- fixed binary: 20 min, 19,022 searches, 190,450 bumps on the contested rows → 0 deadlocks, 0 bumpHitsMany warnings (grep of server log)
- recorded in docs/architecture/go-parity-audit.md ("BumpHitsMany fix confirmed under soak", 2026-08-20)

