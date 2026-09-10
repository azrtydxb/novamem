## PR #248 has sat open and BLOCKED for two weeks — what now?

The procoder-audit + TS→Go migration branch (25 commits) is still open.
All checks passed except `docker (arm64)`, a required check that was
queued because the ARC runners were down. Copilot never reviewed it —
it declined at over 20,000 lines, so the automated review CLAUDE.md
relies on never engaged.

Options:

- Re-check `docker (arm64)` and merge (squash + delete branch) if the
  required checks are now green.
- Split the branch into per-theme PRs so Copilot can actually review it,
  then merge those.
- Leave the PR alone and start on the open issues (#139 telemetry
  dashboard, #140 backup/restore verification).
- Leave everything as is for now.

**Decision (2026-09-10, owner):** re-check `docker (arm64)` and merge if
the required checks are green. Copilot's missing review is accepted.

**Outcome (2026-09-10):** merged as fd853b9 (squash), branch deleted.
`docker (arm64)` had not failed on its merits — it was cancelled after
24h queued with no runner. Once runners returned, two advisories
published since 24 Aug blocked it instead: CVE-2026-56854 (CRITICAL,
golang.org/x/crypto 0.52.0 → 0.55.0, caught by Trivy) and six HIGH
fast-uri advisories (→ 4.1.4, caught by pnpm audit). Both fixed; all 12
checks green at merge.

## How far to take the deprecated-package cleanup?

Four TypeScript packages (~6,568 LOC) are superseded by Go and still in
the tree, still pulling npm dependencies we pay to patch — the fast-uri
advisory just fixed came from `packages/mcp`, which `go/cmd/novamem-mcp`
already replaced.

Two recorded decisions currently gate deleting them:

- **ADR 0002** — publish a final npm version carrying the deprecation
  README, THEN delete. Note `npm deprecate` marks already-published
  versions and needs no source, so deleting first does not prevent
  deprecating; it only skips the final README-bearing release.
- **ADR 0004** — reproduce a published benchmark number in the Go
  harness BEFORE deleting `packages/benchmarks`, so docs/benchmarks/
  claims stay reproducible. The model endpoint is reachable again, so
  this is now possible rather than blocked.

Options:

- Delete client + mcp + init now; keep benchmarks until the Go harness
  reproduces a published number (honours ADR 0004, ends most of the
  maintenance).
- Delete all four now, accepting that the published benchmark numbers
  lose their original harness.
- Publish the final deprecation versions first (owner action), then
  delete everything.
- Delete nothing yet.

**Decision (2026-09-10, owner):** delete client + mcp + init now; keep
`packages/benchmarks` until the Go harness reproduces a published
number (ADR 0004 still stands, and the models are reachable again).

## Repoint novamem-bench to the :4000 model gateway, or leave it?

novamem is ALREADY deployed in the kw cluster and has been for 112 days:
`novamem-bench` namespace, deployment `novamem` 3/3, LoadBalancer
192.168.10.121:7778, `/health` green. All four optional subsystems are
already enabled (rerank, extraction, observer, query decomposition).

It points at a different gateway and different model aliases than the
ones just supplied:

| | running now | supplied |
| --- | --- | --- |
| gateway | `http://192.168.10.125/v1` (:80) | `http://192.168.10.125:4000/v1` |
| embeddings | bge-m3 | bge-m3 |
| rerank | bge-reranker-v2-m3 | rerank |
| LLM (×3) | qwen3-6-35b-a3b-nvfp4 | qwen3-6-35b-a3b |

Both gateways answer and both tokens are valid — the :80 one returns 200
with the token found in the manifest, the :4000 one with the new token.
So this is a choice, not a repair.

Repointing is measurement-affecting: this deployment is the benchmark
oracle, and the published 79.4% LongMemEval number was produced on the
current models. `qwen3-6-35b-a3b` may or may not be the same weights as
`qwen3-6-35b-a3b-nvfp4`.

Options:

- Leave the deployment alone (it already does what was asked).
- Repoint to :4000 with the new token and aliases, accepting that
  published benchmark numbers were produced on the old config.
- Repoint only non-benchmark-critical parts.

Separate, unconditional finding: `NOVAMEM_RERANK_API_KEY` is a PLAINTEXT
literal in the deployment spec while every other key uses a secretRef —
a credential sitting in cluster config and in `kubectl get deploy -o
yaml` output. Worth fixing either way.

**Decision (2026-09-10, owner):** repoint the deployment to the :4000
gateway with the supplied token and model aliases (bge-m3, rerank,
qwen3-6-35b-a3b), all four optional subsystems enabled. Accepts that the
published 79.4% LongMemEval number was produced on the :80 gateway with
`qwen3-6-35b-a3b-nvfp4` / `bge-reranker-v2-m3`.

## Delete the novamem-bench deployment from the kw cluster

**Decision (2026-09-10, owner):** delete it fully — "this is all dev, so
i don't care". Deleted the whole `novamem-bench` namespace, which takes
the deployment, the postgres StatefulSet, the 20Gi Longhorn PVC holding
the memory store, all four secrets, the configmap, the ingress
(novamem-bench.kw.local) and the LoadBalancer holding 192.168.10.121.
Irreversible; no backup was taken because the owner waived the data.
