# Prove clients/go covers the TS client surface

Status: open
Created: 2026-08-20
Epic: client-library-go-parity
Sprint: 001-close-the-decision-free-debt-dead-ts-server-scaffolding

## Description

clients/go exists with 42 exported methods (Client 15, Management 21,
Admin 6) vs the TS client's 34 async methods, and ships a surface test.
Turn "plausibly complete" into "proven": enumerate the TS client's
public surface, map each method to its Go counterpart, close any gap.
Note: clients/go is currently NOT lint-covered (golangci-lint fails
there — "no go files to analyze"; likely its own module missing from the
lint config) — fix that here so the client is gated like the rest.

## Acceptance criteria

- [ ] written method-for-method map TS→Go with no unmapped TS method
- [ ] surface_test.go pins the mapped surface (fails when a route is added to openapi.json without a client method)
- [ ] golangci-lint actually analyzes clients/go in CI

## Evidence

