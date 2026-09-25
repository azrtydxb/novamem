# SDK T11: Rust SDK

Status: open
Created: 2026-09-25

## Description

Ship clients/rust (crates.io `novamem` 0.1.0, async, MSRV 1.80), held to the shared scenario suite (plan Task 11, spec S-8).

## Acceptance criteria

- [ ] `cd clients/rust && cargo test --locked` passes test_scenarios and test_every_route_is_accounted on 1.80 and stable
- [ ] Removing token redaction fails with `token-echoed-in-401-is-redacted: token leaked` (mutation check, reverted)
- [ ] `cargo tree --depth 1 -e normal` lists only reqwest, serde, serde_json, thiserror and tokio
- [ ] examples/smoke.rs exists, and the `rust` job is in sdk.yml

## Evidence
