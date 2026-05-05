---
title: Admin & users
---

# Admin & users

Routes gated to dashboard admin role. Two families: legacy `/v1/admin/*` (tenant + token bootstrap) and Better Auth's `/api/auth/admin/*` (user management).

## Tenant management

```bash
# Create tenant
curl -X POST https://novamem.example.com/v1/admin/tenants \
  -H "Authorization: Bearer ns_..." \
  -d '{ "id": "acme", "name": "Acme Corp" }'

# List tenants
curl https://novamem.example.com/v1/admin/tenants \
  -H "Authorization: Bearer ns_..."

# Mint a tenant-wide bearer
curl -X POST https://novamem.example.com/v1/admin/tenants/acme/tokens \
  -H "Authorization: Bearer ns_..." \
  -d '{ "label": "acme bootstrap" }'

# Revoke any bearer (by plaintext)
curl -X POST https://novamem.example.com/v1/admin/tokens/revoke \
  -H "Authorization: Bearer ns_..." \
  -d '{ "token": "nm_..." }'
```

Tenant ids are constrained: `^[a-z0-9][a-z0-9_-]*$`, no `p_` prefix (collides with project collection naming), no `__` (reserved separator).

## Tenant deletion

```bash
curl -X DELETE https://novamem.example.com/v1/admin/tenants/acme \
  -H "Authorization: Bearer ns_..."
```

Cascades: every user, project, token, entry, cold collection, graph node. Irreversible. Confirmation header required:

```
X-Novamem-Confirm-Delete: tenant=acme
```

## User management

Better Auth admin plugin. See [Authentication → admin endpoints](/api/auth#admin-endpoints-better-auth-admin-plugin).

## Metrics

```bash
# Tenant-aggregate (admin)
curl https://novamem.example.com/v1/admin/metrics \
  -H "Authorization: Bearer ns_..."
```

Returns counters / gauges / rolling rates / 24 h history per tenant. Disabled when `NOVAMEM_ADMIN_DASHBOARD=0`.

## Decay control

```bash
# Force a decay sweep now
curl -X POST https://novamem.example.com/v1/admin/decay/run \
  -H "Authorization: Bearer ns_..."

# Override the base lifespan globally
curl -X POST https://novamem.example.com/v1/admin/decay/config \
  -H "Authorization: Bearer ns_..." \
  -d '{ "effectiveDays": 14 }'
```

## Audit log

```bash
curl "https://novamem.example.com/v1/admin/audit-log?limit=50" \
  -H "Authorization: Bearer ns_..."
```

Returns the most recent entries from `admin_audit_log` — every admin action emits a row with actor user id, tenant id, action verb, target, timestamp, request IP.

## See also

- [Audit log doc](/ops/audit-log) — what gets logged + retention
- [Hardening](/ops/hardening) — disabling the admin surface entirely
