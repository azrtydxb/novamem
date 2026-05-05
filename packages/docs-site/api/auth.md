---
title: Authentication
---

# Authentication

Two parallel auth systems:

- **Better Auth** (`/api/auth/*`) — dashboard sessions (cookie + `Bearer ns_…`)
- **Tenant tokens** (`Bearer nm_…`) — data-plane access for MCP / HTTP integrations

## Better Auth (dashboard)

Standard email + password. Sessions are HttpOnly cookies signed with `NOVAMEM_COOKIE_SECRET`.

```bash
# Sign in
curl -c cookies -X POST https://novamem.example.com/api/auth/sign-in/email \
  -H "Content-Type: application/json" \
  -d '{ "email": "alice@example.com", "password": "..." }'

# Sign out
curl -b cookies -X POST https://novamem.example.com/api/auth/sign-out
```

Returns the `user` and `session` objects on success. The cookie is automatically sent on subsequent requests.

For CLI / scripts that can't carry cookies, the same session token works as `Authorization: Bearer ns_<token>`.

### Admin endpoints (Better Auth admin plugin)

Admin-only:

| Route | Action |
|---|---|
| `GET /api/auth/admin/list-users` | List dashboard users (paginated) |
| `POST /api/auth/admin/create-user` | Create with email + password + role |
| `POST /api/auth/admin/set-role` | Toggle admin/user |
| `POST /api/auth/admin/set-user-password` | Reset password (revokes the user's sessions) |
| `POST /api/auth/admin/ban-user` | Block sign-in |
| `POST /api/auth/admin/unban-user` | Restore |
| `POST /api/auth/admin/remove-user` | Hard delete (cascades) |

Better Auth's full reference: <https://www.better-auth.com/docs>.

## Tenant tokens (data plane)

Mint via the dashboard or:

```bash
curl -X POST https://novamem.example.com/v1/me/tokens \
  -H "Authorization: Bearer ns_..." \
  -d '{ "label": "ci-runner" }'
```

Response includes the plaintext bearer ONCE:

```json
{
  "tokenHash": "287e1876...",
  "label": "ci-runner",
  "token": "nm_zEQs..."
}
```

Use it on data-plane requests:

```bash
curl -X POST https://novamem.example.com/v1/search \
  -H "Authorization: Bearer nm_zEQs..." \
  -d '{ "query": "..." }'
```

Server-side, `resolveTenantToken()` looks up the SHA-256 hash in `tenant_tokens` and either returns `{tenantId, projectId, tokenHash, label}` or null. Null → 401.

### Token scopes

A token's `projectId` field pins it to a single project (or null for tenant-wide). Pinned tokens can ONLY access that project's memory. The route layer rejects body fields that contradict the pinned scope with 403.

### Revoke

```bash
curl -X POST https://novamem.example.com/v1/me/tokens/<hash>/revoke \
  -H "Authorization: Bearer ns_..."
```

The hash is the SHA-256 hex (returned by `GET /v1/me/tokens`), not the plaintext. Effective immediately.

## Auth modes (env)

`NOVAMEM_AUTH_MODE` selects the active path:

| Mode | Description |
|---|---|
| `none` | Dev only. Every request is the public tenant. No isolation. |
| `bearer` | Single shared bearer in `NOVAMEM_AUTH_TOKEN`. One-process deploys. |
| `tenant` | Tenant tokens only. No dashboard. Used by some headless deploys. |
| `user` | Default. Dashboard + Better Auth + tenant tokens. |

Most deploys want `user`.
