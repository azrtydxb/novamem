# MCP sessions are process-local, so replicas > 1 silently breaks clients

Status: done 2026-09-10
Created: 2026-09-10
Epic: post-migration-gaps

## Description

`go/internal/mcp/transport.go` keeps streamable-HTTP and SSE sessions in
an in-process map (`s.streamable` / `s.sse`). A client's `initialize`
lands on one pod; every follow-up POST carries `Mcp-Session-Id` and is
load-balanced to a different pod, which answers
`404 {"error":"unknown sessionId"}`.

Measured on the kw deployment (3 replicas, plain round-robin ingress):
4 of 9, then 8 of 20, reused-session calls succeeded — the ~1/N success
rate a per-pod session map predicts. Claude Code reported
`Failed to connect — HTTP 404: unknown sessionId`.

`deploy/k8s/novamem.yaml` ships `replicas: 1`, so the shipped default is
safe — but nothing warns an operator that scaling up breaks MCP, and the
failure mode looks like a client bug, not a scaling bug.

Worked around on kw by giving the `/mcp` paths their own Service
(`novamem-mcp`) plus an ingress annotated
`nginx.ingress.kubernetes.io/upstream-hash-by: "$http_authorization"`,
which pins a bearer to one pod: 20/20 reused-session calls succeeded.
The workaround is deployment-shaped, not in-tree.

## Acceptance criteria

- [ ] `deploy/k8s/novamem.yaml` warns, at `replicas:`, that MCP sessions are process-local and that scaling out needs per-client affinity
- [ ] the affinity recipe (dedicated Service + `upstream-hash-by`) is documented under `docs/` where operators look before scaling
- [ ] decide and record whether to make sessions shared (Postgres/adopt-unknown-session) or to keep MCP single-pod by contract
- [ ] a test or check fails if the manifest's replica count and the session model disagree

## Notes

Adopting an unknown-but-well-formed session id on the receiving pod may
be cheap: `session` carries only `id`, `userID` and `done`, so a pod
could bind an unseen id to the authenticated caller. That needs a
security review first (session ids would become caller-assertable).
