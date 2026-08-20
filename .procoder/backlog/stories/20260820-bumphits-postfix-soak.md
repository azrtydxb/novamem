# Confirm the BumpHitsMany deadlock fix under soak

Status: open
Created: 2026-08-20
Epic: post-migration-gaps
Sprint: -

## Description

The audit's soak ran the pre-fix binary; DEFECT-10's fix (sorted lock
order in the memory_access upsert) has never been confirmed to take the
deadlock WARN count to zero. Audit §10 lists this explicitly.

## Acceptance criteria

- [ ] soak (≥20 min, concurrent search + write load) against the fixed binary shows zero "async bumpHitsMany failed" WARNs
- [ ] result recorded in the parity audit doc or its successor

## Evidence

