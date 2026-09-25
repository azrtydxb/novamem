# SDK T11: Rust SDK

Status: closed 2026-09-25
Created: 2026-09-25

## Description

Ship clients/rust (crates.io `novamem` 0.1.0, async, MSRV 1.80), held to the shared scenario suite (plan Task 11, spec S-8).

## Acceptance criteria

- [x] `cd clients/rust && cargo test --locked` passes test_scenarios and test_every_route_is_accounted on 1.80 and stable (stable 1.97 locally; 1.80 runs in the sdk.yml `rust` matrix)
- [x] Removing token redaction fails with `token-echoed-in-401-is-redacted: token leaked` (mutation check, reverted)
- [x] `cargo tree --depth 1 -e normal` lists only reqwest, serde, serde_json, thiserror and tokio
- [x] examples/smoke.rs exists, and the `rust` job is in sdk.yml

## Evidence

- Local (rustc 1.97.1): `cd clients/rust && cargo test --locked` → 5 `test result: ok` (scenarios, routes, redirect, the time unit test, the doc example). The two cancel scenarios are skipped, printed by id. `cargo clippy --locked --all-targets -- -D warnings` is clean; `cargo fmt --check` is clean.
- Mutation: disabling degraded_empty → `search-degraded-empty-is-unavailable: outcome empty … want "unavailable"`. Removing redaction → both `token-echoed-in-401-is-redacted` and `token-echoed-in-code-is-redacted: token leaked`. Both restored.
- Dependencies: `cargo tree --depth 1 -e normal` → reqwest 0.12.28, serde, serde_json, thiserror, tokio (a CI step checks this exact set). The lockfile is resolved within MSRV 1.80 via `.cargo/config.toml` (incompatible-rust-versions = fallback); the 1.80 run is in CI.
- examples/smoke.rs (up/down) run against a dead port: `PASS rust down`, and `up` → `rust capture: … Connection refused` with exit 1. The sdk.yml `rust` job exists; `actionlint` is clean.
