# The rate limiter is per-replica, so the effective limit is N× the configured one

Status: done 2026-09-10
Created: 2026-09-10
Epic: post-migration-gaps

## Description

`go/internal/httpapi/ratelimit.go` keeps counters in an in-process
`map[string]rateEntry`. Each replica therefore enforces the configured
budget independently: with 3 replicas a caller gets roughly 3× the
intended allowance, and the advertised `x-ratelimit-remaining` walks
backwards between consecutive calls.

Measured on the kw deployment (3 replicas), one request per connection
so nothing is pinned:

    remaining=593, 592, 593, 593, 592, 591

Three independent counters, exactly as a per-process map predicts.

This is the same class of defect as the MCP session map (ADR 0005) and
the SSE transport: process-local state behind a load balancer.

**The conformance suite does not reliably catch it.** `TestRateLimiting`
passes in a normal full run because Go's `http.Client` reuses one
keepalive connection, which nginx pins to a single upstream; it fails
6/6 when run in isolation, and the raw-header probe above fails
whenever connections are not reused. A test that only passes because of
connection reuse is not testing the property it claims.

Rate limiting is a protection, so N× the intended budget is a security-
relevant weakening, not only a metrics inconsistency.

## Acceptance criteria

- [x] owner chose a shared counter over documenting a single-replica guarantee
- [x] counters moved to Postgres (`rate_limits`, migration 0009), one atomic statement per take
- [x] `TestRateLimiting` no longer depends on keepalive pinning, and fails when counters are per-replica
- [x] the deployment caveat disappears rather than being documented — limiting now holds at any replica count

## Resolution

`warmstore.TakeRateLimit` is a fixed-window counter in Postgres. The
whole take is a single `INSERT … ON CONFLICT DO UPDATE … RETURNING`, so
concurrent callers in one process or across replicas cannot interleave a
read and a write and lose an increment. The remaining window is computed
by the database, so app/Postgres clock differences cannot skew
`x-ratelimit-reset`.

The in-process limiter stays as the fallback for a server with no warm
store. When the shared counter is unreachable the request fails **open**
and logs a warning — a database blip must not become a site-wide 429,
and the warning stops a silent downgrade to per-replica limits.

Closed windows are collected by an opportunistic sweep (every 2048
requests) rather than a background goroutine needing its own lifecycle.

## Evidence

- reproduction on 3 replicas, one request per connection: `remaining = 593, 592, 593, 593, 592, 591` — three counters
- `TestTakeRateLimitIsSharedAcrossReplicas`: two Stores with separate pools over one database count 1..10 in order; control (per-process map) fails at call 2 with "the counter is not shared"
- `TestTakeRateLimitLosesNoIncrementsUnderConcurrency`: 60 concurrent takes across both replicas yield each count exactly once
- `TestTakeRateLimitWindowIsFixedThenResets`, `TestSweepRateLimitsRemovesOnlyClosedWindows`
- all four run against a real Postgres (throwaway `novamem_rl_test`), not a mock
- the hardened conformance test fails 3/3 against the pre-fix deployment and passes after
