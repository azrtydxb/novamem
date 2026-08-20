# The conformance oracle speaks Go

Status: closed 2026-08-20
Created: 2026-08-20

## Goal

The black-box oracle is a standalone Go module with case parity against
the TS suite (declared and mode-skipped counts match), its independence
enforced by a compile-time boundary check instead of a language gap, a
green run against a live server, and packages/conformance deleted. The
three .mjs repo scripts get their written disposition on the way.

## Result

committed: 2
done: 2 (20260820-conformance-go-port, 20260820-repo-scripts-disposition)
carried: 0

## Retro

- What slowed us: the local rig, not the port. Two full suite runs failed
  on rig configuration rather than ported code — a read-only-token read
  hitting 503 because no embedder was reachable, then every write hitting
  500 because the cold table had been created at the default 384 dims
  before a 1024-dim embedder existed. Both cost a full run each.
- What we change: stand the target up COMPLETELY before the first run
  (embedder reachable, vector dims fixed at create time, identities
  minted to the target's own conventions), and prove the rig with a
  handful of curl calls before spending a suite run on it.
- Adaptation worth keeping: parity claims get measured, never argued.
  Running BOTH suites against the same rig turned "we ported it
  faithfully" into a per-suite table with one explained delta — and it
  caught my own miscount first (subtest names contain slashes, so naive
  parent detection inflated the Go leaf count from 98 to 112).
