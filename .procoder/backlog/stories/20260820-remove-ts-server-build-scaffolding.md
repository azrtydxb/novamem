# Remove the TS-server-only build scaffolding

Status: open
Created: 2026-08-20
Epic: spec-cleanup-phase
Sprint: -

## Description

The spec's cleanup phase requires removing TS-server-only CI jobs, build
scripts, and Docker stages. CI was cleaned (both image jobs build
go/Dockerfile), but two artifacts survived the server's deletion and are
now dead: the root Dockerfile still COPYs /app/packages/server/dist —
a directory that no longer exists, so the image cannot build — and
scripts/gen-runtime-package.mjs exists only to generate that image's
runtime package.json.

## Acceptance criteria

- [ ] root Dockerfile deleted (or rewritten for a real current target) — it currently references packages/server and cannot build
- [ ] scripts/gen-runtime-package.mjs deleted along with any package.json script invoking it
- [ ] no remaining CI/build/script references to packages/server (`git grep -l "packages/server" -- ':!docs' ':!packages/docs-site'` empty)
- [ ] docker build of every remaining Dockerfile succeeds

## Evidence

