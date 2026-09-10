# 0002 — Deprecate the @azrtydxb/novamem npm client

Status: accepted
Date: 2026-08-20

## Context

The TS client (packages/client) exists for two audiences: internal
consumers (mcp shim, benchmarks, conformance — all leaving TS per the
migration milestone) and external JS users of the published npm package.
With internals gone, keeping it means maintaining a public TS SDK
forever solely for hypothetical external users.

## Decision

Deprecate. Publish a final version whose README and npm deprecation
notice point at the HTTP API (OpenAPI spec) and clients/go. Rejected:
keeping it as a supported SDK — its maintenance is real (surface parity
with every API change) and the project's contract is the HTTP API, not
a language binding.

## Consequences

Easier: one client library (Go) held to surface parity; API changes
touch one binding. Harder: JS integrators lose the typed wrapper and
call the HTTP API directly (the OpenAPI spec must stay first-class);
combined with ADR 0001 this ends npm publishing entirely — the
Changesets flow, release-preflight.mjs, and the npm version badges in
the README all retire with it.
