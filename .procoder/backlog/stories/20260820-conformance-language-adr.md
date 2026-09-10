# Decision: conformance suite stays TS or ports to Go

Status: done 2026-08-21
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

- [x] ADR recorded with the independence trade-off addressed explicitly
- [x] if port: parity plan attached as follow-up stories; if stay: the milestone's goal text amended to name conformance as a second accepted exception

## Evidence

- ADR 0003 (port to Go; independence preserved by module boundary + no shared helpers, enforced by check) accepted 2026-08-20
- Port chosen, so the follow-up-story branch applies: 20260820-conformance-go-port carried the parity plan and is closed with a measured per-suite table (both suites run against one live rig, 98 passed each, single explained delta in llm skip granularity).
- The parity target was restated from "103 declared cases" to "measured per-suite equality" during execution: the static TS count (103 `it(` declarations) is not the runtime case count (104 reported), and a for-loop case declares once but runs three times. Counting declarations would have been a weaker check than running both suites and comparing.
