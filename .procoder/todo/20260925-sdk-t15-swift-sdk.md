# SDK T15: Swift SDK

Status: open
Created: 2026-09-25

## Description

Ship clients/swift (SwiftPM `Novamem` via the novamem-swift mirror, no dependencies), held to the shared scenario suite on Linux (plan Task 15, spec S-12).

## Acceptance criteria

- [ ] `cd clients/swift && swift test` passes on Swift 5.9 and the latest release on Linux
- [ ] `swift package show-dependencies` reports no external dependencies
- [ ] Removing the forget blank-id guard fails `forget-blank-id-local` (mutation check, reverted)
- [ ] The novamem-smoke executable exists, and the `swift` job is in sdk.yml

## Evidence
