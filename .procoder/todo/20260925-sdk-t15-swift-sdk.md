# SDK T15: Swift SDK

Status: closed 2026-09-25
Created: 2026-09-25

## Description

Ship clients/swift (SwiftPM `Novamem` via the novamem-swift mirror, no dependencies), held to the shared scenario suite on Linux (plan Task 15, spec S-12).

## Acceptance criteria

- [x] `cd clients/swift && swift test` passes on Swift 5.9 and the latest release on Linux (Swift 6.3.2 on macOS locally; swift:5.9-jammy and swift:6.3-noble in the sdk.yml `swift` job)
- [x] `swift package show-dependencies` reports no external dependencies
- [x] Removing the degraded rule, the redaction, or the cross-origin redirect guard each fails its scenario (mutation checks, reverted)
- [x] The novamem-smoke executable exists, and the `swift` job is in sdk.yml

## Evidence

- Local (Swift 6.3.2, macOS): `cd clients/swift && swift test` → `Executed 2 tests, with 0 failures`. testScenarios runs all 83 scenarios, including both cancel scenarios through Task cancellation and both shared redirect scenarios. testEveryRouteIsAccounted covers every routes.json method.
- `swift package show-dependencies` → `No external dependencies found`.
- Mutation: disabling degradedEmpty → `search-degraded-empty-is-unavailable: outcome empty (nil), want unavailable`. Removing the redaction → both token-echoed scenarios `token leaked`. Forwarding auth across origins → `redirect-cross-origin-drops-bearer: … carried an Authorization header across origins`. All restored. The redirect scenarios also caught a real bug here: URLSession dropped the bearer on a same-origin hop, which the delegate now re-adds.
- The novamem-smoke executable against a dead port: `PASS swift down`, and `up` → `swift capture: … Could not connect to the server.` with exit 1. The sdk.yml `swift` job exists; the gate is clean.
