# The installer speaks Go and ships as a binary

Status: closed 2026-08-21
Created: 2026-08-20

## Goal

packages/init — the last large TypeScript runtime — is a Go binary that
writes byte-identical host configuration to what the TS installer wrote,
except for the one deliberate difference ADR 0001 requires: stdio
entries invoke the shipped `novamem-mcp` binary instead of `npx`. Parity
is proven by golden fixtures generated from the TS implementation, not
by reading the code. The docs and host configs then tell one consistent
distribution story.

## Result

committed: 2
done: 1 (20260820-go-init-cli)
carried: 1 (20260820-mcp-shim-distribution-decision)

## Retro

- What slowed us: parallel agents collided twice on shared helpers
  (`trimTrailingSlash` declared by two of them, `goldenTool`/`loadGolden`
  by two more), and once I raced an agent that was still editing — I
  "found" a defect in a test the agent fixed a minute later.
- What we change: name the shared surface in the brief up front (the
  lead owns the shared helpers file; agents may use but never declare
  cross-cutting utilities), and never diagnose an agent's file until its
  completion notification has landed.
- Adaptation worth keeping: generate the oracle from the implementation
  you are about to retire, BEFORE retiring it. golden.json turned a
  30-host port from a reading exercise into a measurement — and when the
  ADR required one deliberate difference, the difference went into the
  EXPECTATION (with a guard that fails if the fixture stops showing the
  old shape), so the fixture stayed an oracle instead of becoming a
  mirror of our own output.
