---
title: Audit log
---

# Audit log

Every admin-authoritative action emits a row to `admin_audit_log`. The dashboard surfaces them at `/admin/audit-log` (admin only) and the API exposes the same data:

```bash
curl "https://novamem.example.com/v1/admin/audit-log?limit=100" \
  -H "Authorization: Bearer ns_..."
```

## What gets logged

| Action | Captured |
|---|---|
| User created / role changed / banned / deleted | `actor_user_id`, `target_user_id`, action verb |
| Password reset (admin → user) | actor + target; never the password |
| Tenant created / deleted | actor + tenant id |
| Tenant token minted / revoked | actor + token hash + label |
| Project created / shared / unshared / deleted | owner / actor + project id + member id |
| Decay config changed | actor + new effectiveDays |

Read access logs (search / remember / etc) are not in the audit log — they're in the metrics counters. The audit log is for **administrative authority**, not data access.

## Schema

```sql
CREATE TABLE admin_audit_log (
  id BIGSERIAL PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  actor_user_id text NOT NULL,
  tenant_id text,
  action text NOT NULL,
  target text,
  request_ip text,
  metadata jsonb
);
```

## Retention

Defaults to forever. Trim with a cron / pg_partman / manual `DELETE` if you have a retention policy:

```sql
DELETE FROM admin_audit_log WHERE ts < now() - interval '180 days';
```

Logs flow elsewhere (Loki / Cloudwatch) too — that's your durable copy. The DB log is for fast operator queries from the dashboard.

## Self-actions in user feed

A user sees their own role changes / password resets in the **Today** feed. The audit log row drives both — same data, two presentations.
