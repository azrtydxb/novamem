# Server module gated and soak-proven; the MCP stdio shim ported to Go

Status: closed 2026-08-20
Created: 2026-08-20

## Goal

The go/ module reaches the same lint bar as clients/go and CI enforces
it; the last unconfirmed parity-audit fix (BumpHitsMany) is proven under
a concurrent-search soak; and the first ADR-gated port lands — a Go
stdio MCP shim whose tool surface byte-matches the TS shim, leaving
packages/mcp ready for deletion once hosts are switched.

## Result

committed: 3
done: 3 (20260820-bumphits-postfix-soak, 20260820-go-mcp-stdio-shim, 20260820-go-server-lint-debt)
carried: 0

## Retro

- What slowed us: the first deadlock rig didn't reproduce — the two
  queries' top-10 sets were disjoint (no lock overlap) and the default
  rate limiter silently throttled the hammer to ~10 rps; both took a
  measurement to notice.
- What we change: before trusting any negative soak result, run a
  control that provably triggers the failure (the unsorted build's 173
  deadlocks made the fixed build's zero meaningful); and check server
  defaults (rate limits, clamps) before load-testing through them.
- Adaptation worth keeping: oracle skepticism — the story's original
  "byte-identical to the TS shim" criterion would have preserved a
  drifted mirror; diffing three sources (TS shim, live server, embedded
  tooldefs) exposed the stale one and produced a stricter contract.
