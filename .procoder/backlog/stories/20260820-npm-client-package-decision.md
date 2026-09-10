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

- [x] ADR recorded: keep-as-SDK or deprecate, with the support policy
- [x] package README and docs-site reflect the decision
- [ ] if deprecated: npm deprecation notice published on the final version

## Evidence

- ADR 0002 (deprecate; final version + notice pointing at HTTP API and clients/go) accepted 2026-08-20
- packages/client/README.md now opens with the deprecation notice, pointing JS/TS users at the HTTP API and Go users at clients/go. Written as plain markdown rather than a GitHub `[!WARNING]` alert on purpose: npm renders this README and does not support that syntax, so the alert would have shown as literal text to the audience that matters.
- packages/docs-site/connect/http.md's SDK section now leads with the Go client and marks the npm package deprecated. The Go snippet was WRONG on first write (I used a `novamem.Options` constructor that does not exist); it is now compiled for real against clients/go before shipping — `novamem.New(novamem.Config{…})`, `Remember`, `Search`.
- Remaining criterion is the npm deprecation publish itself, which is an outward-facing release action and the owner's call. The README above is what ships with that final version.
