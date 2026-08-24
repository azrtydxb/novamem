# Delete the in-process Xenova embedding path

Status: done 2026-08-20
Created: 2026-08-20
Epic: spec-cleanup-phase
Sprint: -

## Description

The TS server's @xenova/transformers in-process embedding path dies with
it; the Go server refuses local-transformers by design (owner decision
2026-08-14) and points at an OpenAI-compatible endpoint instead.

## Acceptance criteria

- [x] no @xenova or xenova dependency anywhere in the workspace
- [x] Go server refuses NOVAMEM_EMBEDDINGS_PROVIDER=local-transformers with a pointer to the endpoint path

## Evidence

- `grep -rl "xenova" packages/*/package.json packages/*/src` → no matches (2026-08-20)
- `grep -rn "local-transformers" go/internal/config` → refusal branch present in config validation
