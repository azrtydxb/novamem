---
title: Isolation model
---

# Isolation model

NovaMem currently isolates memory at two levels:

```
user ─┬── user-global memory
      └── projects (sub-brains, shareable with explicit members)
```

There is no active tenant-admin API in the current service. Historical tenant language has been removed from the runtime surface; the production auth model is dashboard users plus user-owned API tokens.

## Users

Each dashboard user owns their user-global memory. Data-plane requests authenticate as a user either through a Better Auth session (`ns_…`/cookie) or a user API token (`nm_…`). User-global memory is private by default.

## Projects

Projects are shareable sub-brains. Owners create, delete, share, and unshare projects through `/v1/me/projects/*` (or the equivalent MCP project tools). Memory requests can pass `project` by id or name to read/write a project the caller can access.

## API tokens

`nm_…` tokens are rows in `user_tokens`. The plaintext token is shown once, only its SHA-256 hash is stored, and revoked tokens return 401. A token inherits the owning user's project memberships; it is not pinned to a single project.

## Quotas

Per-user/project quotas are not implemented yet. `MAX_SESSIONS_PER_USER = 10` limits concurrent SSE sessions per user.

## Audit

NovaMem-owned project, token, lifecycle, and admin routes write `admin_audit_log` entries. Better Auth admin-plugin passthrough operations should be corroborated with Better Auth/session logs.

## Operational notes for k8s deploys

- One server replica handles many users; the bottleneck is Postgres + Qdrant, not NovaMem itself.
- HA: 2+ replicas behind a Service. Sessions are DB-backed so any replica handles any cookie.
- Cold-tier collection count grows with projects × namespaces. Qdrant handles thousands cheaply; tens of thousands need bigger nodes.
- Back up Postgres — it is the source of truth, including the `memory_relations` co-occurrence edges. Qdrant is reconstructible from warm data once a reindex workflow is added.

## See also

- [Sign in & roles](/dashboard/auth-roles)
- [Projects](/dashboard/projects)
- [Hardening](/ops/hardening)
