# Remove the TS-server-only build scaffolding

Status: done 2026-08-20
Created: 2026-08-20
Epic: spec-cleanup-phase
Sprint: 001-close-the-decision-free-debt-dead-ts-server-scaffolding

## Description

The spec's cleanup phase requires removing TS-server-only CI jobs, build
scripts, and Docker stages. CI was cleaned (both image jobs build
go/Dockerfile), but two artifacts survived the server's deletion and are
now dead: the root Dockerfile still COPYs /app/packages/server/dist —
a directory that no longer exists, so the image cannot build — and
scripts/gen-runtime-package.mjs exists only to generate that image's
runtime package.json.

## Acceptance criteria

- [x] root Dockerfile deleted (or rewritten for a real current target) — it currently references packages/server and cannot build
- [x] scripts/gen-runtime-package.mjs deleted along with any package.json script invoking it
- [x] no remaining CI/build/script references to packages/server (`git grep -l "packages/server" -- ':!docs' ':!packages/docs-site'` empty)
- [x] docker build of every remaining Dockerfile succeeds

## Evidence

- `git rm Dockerfile scripts/gen-runtime-package.mjs` (2026-08-20); no package.json script invoked gen-runtime-package (grep empty)
- CODEOWNERS packages/server rules removed; remaining `packages/server` hits are prose: CHANGELOG history, go/ provenance comments ("transcribed from"), backlog/audit docs — no CI, build, or script references
- docs updated to `-f go/Dockerfile` (install/kubernetes both trees, install/docker table, contribute/dev-setup buildx); docker-compose already targeted go/Dockerfile
- `docker build -f go/Dockerfile .` → image sha256:c9133782… builds clean; go/Dockerfile is the only Dockerfile left

