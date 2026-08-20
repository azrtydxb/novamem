# Close the decision-free debt: dead TS-server scaffolding gone, clients/go proven and gated, Go runtime observability shipped, audit ledger reads closed

Status: active
Created: 2026-08-20

## Goal

Everything that needed no owner decision is finished: the tree no longer
carries a Dockerfile that cannot build, the Go client is proven
method-for-method against the TS client and actually linted in CI, an
operator can see goroutine and runtime metrics on a primary-Go
deployment, and the parity audit's unverified-items section reads as a
closed ledger instead of trailing off. After this sprint, every
remaining open story is either an ADR execution or gated on one.
