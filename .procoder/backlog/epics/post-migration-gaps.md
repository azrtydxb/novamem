# Post-migration gaps — what the parity audit left open

Status: open
Created: 2026-08-20
Milestone: go-server-migration--close-out-the-2026-08-13-spec

## Description

The parity audit (docs/architecture/go-parity-audit.md) closed its
divergence ledger, but §10 lists things it could not verify and #16
defers observability "until Go becomes primary". Go is primary now and
the TS server is deleted, so each remaining item must be verified,
implemented, or retired in writing — not left implied.
