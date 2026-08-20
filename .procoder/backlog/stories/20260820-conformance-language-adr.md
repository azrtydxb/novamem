# Decision: conformance suite stays TS or ports to Go

Status: open
Created: 2026-08-20
Epic: conformance-oracle-language
Sprint: -

## Description

The suite's value is black-box independence: it was written against the
TS server and caught Go divergences precisely because it shared no code
with either implementation's Go tree. Porting to Go removes the last TS
test runtime but the suite would then share a language (and temptingly,
helpers) with the system under test. Both outcomes are defensible;
record one. If "stay TS": that keeps Node in the dev toolchain, which
the admin-ui/docs-site builds require anyway.

## Acceptance criteria

- [ ] ADR recorded with the independence trade-off addressed explicitly
- [ ] if port: 103-case parity plan attached as follow-up stories; if stay: the milestone's goal text amended to name conformance as a second accepted exception

## Evidence

