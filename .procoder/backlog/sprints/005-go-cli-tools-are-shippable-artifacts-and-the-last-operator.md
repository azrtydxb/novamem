# Go CLI tools are shippable artifacts, and the last operator script leaves Node

Status: closed 2026-08-21
Created: 2026-08-20

## Goal

ADR 0001's channel exists: a tagged release cross-compiles novamem-mcp
and novamem-init for the three supported targets, ships them together in
one archive so the installer's sibling-resolution works, and publishes
checksums plus an install script — verified locally end to end, since
publishing a release is the owner's call, not the agent's. The
qdrant→pgvector operator tool becomes a Go command, so an operator
running the Go server never needs Node for the remediation the server
itself prescribes.

## Result

Committed 2, done 2, carried 0 — both stories closed with evidence.

(The closer reported 0/0: the sprint file was renamed after the stories
were pulled, so their `Sprint:` field pointed at the pre-rename id and
the closer read an empty sprint. Stories repointed; this line is the
corrected count, not a re-run.)

## Retro

- What slowed us: nothing in the work — but the sprint ledger went wrong
  because I renamed the sprint file after pulling stories into it, so
  the closer read an empty sprint and reported 0 done.
- What we change: name the sprint file from the id the launcher prints,
  and never rename it once stories carry that id.
- Adaptation worth keeping: verify a migration tool by making the data
  disagree on purpose. Seeding 700 points against 660 warm rows with 40
  deliberate orphans and >512 per collection meant the run exercised
  paging, orphan-skipping and scope resolution at once — and the counters
  it printed could be checked against numbers I chose in advance rather
  than against itself.
