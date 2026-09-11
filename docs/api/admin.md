---
title: Admin & users
---

# Admin & users

Routes gated to the dashboard admin role. The current production model is user/project based: dashboard users are managed through Better Auth admin endpoints, while NovaMem-owned admin routes expose metrics, audit, and token revocation.

## User management

Better Auth admin plugin. See [Authentication → admin endpoints](./auth.md#admin-endpoints-better-auth-admin-plugin).

## Metrics

```bash
curl https://novamem.example.com/v1/admin/metrics \
  -H "Authorization: Bearer ns_..."
```

Returns counters, gauges, rolling rates, and 24h history for the deployment. Disabled when `NOVAMEM_ADMIN_DASHBOARD=0`.

Prometheus format:

```bash
curl https://novamem.example.com/v1/admin/metrics/prom \
  -H "Authorization: Bearer ns_..."
```

## Lifecycle controls

These routes are admin-only and trigger immediate maintenance runs:

```bash
curl -X POST https://novamem.example.com/v1/decay \
  -H "Authorization: Bearer ns_..." \
  -d '{ "effectiveDays": 14 }'

curl -X POST https://novamem.example.com/v1/dream-cycle \
  -H "Authorization: Bearer ns_..."

curl -X POST https://novamem.example.com/v1/reap-orphans \
  -H "Authorization: Bearer ns_..."
```

There is no persistent global decay-config endpoint; configuration belongs in environment/config and one-shot overrides belong in the request body.

## Token revocation

Admins can revoke a user API token by plaintext bearer when emergency cleanup is needed:

```bash
curl -X POST https://novamem.example.com/v1/admin/tokens/revoke \
  -H "Authorization: Bearer ns_..." \
  -d '{ "token": "nm_..." }'
```

## Audit log

```bash
curl "https://novamem.example.com/v1/admin/audit-log?limit=50" \
  -H "Authorization: Bearer ns_..."
```

Returns recent NovaMem audit entries for project, membership, token, and admin actions that pass through NovaMem-owned routes. Better Auth admin plugin passthrough events are not all duplicated into `admin_audit_log`; use Better Auth/session logs as the source for those operations.

## See also

- [Audit log doc](../ops/audit-log.md)
- [Hardening](../ops/hardening.md)
