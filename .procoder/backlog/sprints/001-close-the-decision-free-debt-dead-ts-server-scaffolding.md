# Close the decision-free debt: dead TS-server scaffolding gone, clients/go proven and gated, Go runtime observability shipped, audit ledger reads closed

Status: closed 2026-08-20
Created: 2026-08-20

## Goal

Everything that needed no owner decision is finished: the tree no longer
carries a Dockerfile that cannot build, the Go client is proven
method-for-method against the TS client and actually linted in CI, an
operator can see goroutine and runtime metrics on a primary-Go
deployment, and the parity audit's unverified-items section reads as a
closed ledger instead of trailing off. After this sprint, every
remaining open story is either an ADR execution or gated on one.

## Result

committed: 4
done: 4 (20260820-go-client-surface-parity, 20260820-go-observability-pprof, 20260820-remove-ts-server-build-scaffolding, 20260820-retire-audit-unverified-ledger)
carried: 0

## Retro

- What slowed us: the formatting gate rejected story files twice mid-flow
  (unescaped markdown globs, prettier table realignment) — each cost a
  retry loop; and the goroutine-flatness criterion needed a live stack,
  which meant standing up a throwaway pgvector container and a
  10-minute wait late in the sprint.
- What we change: run prettier on any hand-written .procoder file before
  the first close attempt, and start long-running verification rigs at
  sprint OPEN so the wait overlaps the other stories entirely.
- Adaptation worth keeping: the local throwaway-stack pattern (pgvector
  container + server binary + pprof listener + load loop) verified a
  runtime criterion with zero shared-infra risk — reuse it for the
  BumpHitsMany soak story.
