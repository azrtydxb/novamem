# Retire or verify the audit's remaining unverified items

Status: open
Created: 2026-08-20
Epic: post-migration-gaps
Sprint: 001-close-the-decision-free-debt-dead-ts-server-scaffolding

## Description

go-parity-audit.md §10 lists items that were unverifiable at audit time.
With packages/server deleted, several are moot (TS-direction cookie
interop, in-cluster TS-vs-Go latency, oracle keyword-tier bug) — but the
document never says so. One paragraph per item in the audit doc, marking
each verified / retired-because-moot, so the ledger reads closed to a
future reader instead of trailing off.

## Acceptance criteria

- [ ] every §10 bullet has a written disposition (verified since, retired as moot, or converted to an open story)
- [ ] scale-behaviour and Qdrant-cold-store bullets explicitly dispositioned (they are not moot)

## Evidence

