---
title: Multi-tenancy
---

# Multi-tenancy

novamem partitions memory at three nesting levels:

```
tenant ─┬── users ─┬── private memory
        │          └── projects (sub-brains, shareable across users in the tenant)
        │
        └── tenant_tokens (nm_… bearers, scoped to tenant or project)
```

For a single-user homelab, the tenant model is invisible — there's a `PUBLIC_TENANT` constant that everything falls under. For an enterprise, each tenant is one organisation / business unit / customer.

## Tenants

A tenant is a top-level isolation boundary. Two users in different tenants cannot see each other's memory, mint each other's tokens, or share each other's projects.

- Created via `POST /v1/admin/tenants` (admin only). Id is operator-chosen, must match `^[a-z0-9][a-z0-9_-]*$` and avoid the `p_` prefix (reserved for project collection naming).
- Cold-tier collections are named `novamem_<tenantId>_<namespace>` for tenant-wide entries, `novamem_p_<projectId>_<namespace>` for project entries.
- Deletion cascades: tenant delete drops all users, projects, entries, tokens. Irreversible.

## Users-within-tenant

Every dashboard user belongs to exactly one tenant (or none, for global admins). The user's `tenantId` is set at creation; admins can change it. Memory writes are credited to the user, scoped to the user's tenant.

For solo / small-team deploys, the default `auth.mode = "user"` runs everything as the implicit `PUBLIC_TENANT`. The complexity is invisible.

## Projects-within-tenant

Projects are scoped to a tenant. Membership crosses users **within** the tenant — you cannot add a member from a different tenant. Use a tenant-wide bearer if you need cross-tenant sharing (which you usually don't).

## Tokens

A `tenant_tokens` row resolves to `{tenantId, projectId | null}`. Every data-plane request is bound to that scope:

- `projectId = null` → tenant-wide. Search / remember run against tenant-wide entries plus any active project the caller passes.
- `projectId = <id>` → pinned. Calls can ONLY read / write that project. The token can't be used to access tenant-wide or other-project memory.

Pinning is enforced at the route layer: a body that passes `project: <other>` is rejected with 403.

## Quotas

(Planned, not yet implemented.) Per-tenant limits on:

- Total entries
- Daily query rate
- Concurrent SSE sessions

Currently `MAX_SESSIONS_PER_USER = 10` is a global constant; per-tenant overrides are on the roadmap.

## Audit

Every tenant-affecting action (create / delete tenant, mint / revoke token, role change, password reset) writes a row to `admin_audit_log` with the actor user id, tenant id, action verb, and timestamp. Surfaced via [Audit log](/ops/audit-log).

## Operational notes for k8s deploys

- One server replica handles many tenants; the bottleneck is Postgres + Qdrant, not novamem itself.
- HA: 2+ replicas behind a Service. Sessions are DB-backed (Better Auth) so any replica handles any cookie.
- Cold-tier collection count grows with tenants × projects × namespaces. Qdrant handles thousands cheaply; tens of thousands need bigger nodes.
- Backup the Postgres database — it's the source of truth. Qdrant + FalkorDB are reconstructible from warm data via `/v1/admin/reindex` (planned).

## See also

- [Sign in & roles](/dashboard/auth-roles) — admin vs user
- [Projects](/dashboard/projects) — sharing within a tenant
- [Hardening](/ops/hardening) — production checklist
