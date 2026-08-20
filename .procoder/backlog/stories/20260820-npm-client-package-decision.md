# Decision: fate of the @azrtydxb/novamem npm client

Status: open
Created: 2026-08-20
Epic: client-library-go-parity
Sprint: -

## Description

The TS client is a published npm package with potential external
consumers; internal consumers (mcp shim, benchmarks, conformance)
disappear as their epics land. Owner decision: keep publishing it as a
supported TS SDK for JS users (it is API-generated surface, low
maintenance), or deprecate with a final version and README notice.
"Migrate everything to Go" does not automatically answer what happens to
a public artifact other people install.

## Acceptance criteria

- [ ] ADR recorded: keep-as-SDK or deprecate, with the support policy
- [ ] package README and docs-site reflect the decision
- [ ] if deprecated: npm deprecation notice published on the final version

## Evidence

