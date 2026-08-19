---
title: Authentication
---

# Authentication

Two auth surfaces are used in production:

- **Better Auth** (`/api/auth/*`) — dashboard sessions via HttpOnly cookie, plus `Bearer ns_…` session tokens for scripts that cannot carry cookies.
- **User API tokens** (`Bearer nm_…`) — data-plane access for MCP and HTTP integrations. Tokens are owned by a dashboard user and inherit that user's access to user-global memory and shared projects.

## Better Auth dashboard sessions

```bash
curl -c cookies -X POST https://novamem.example.com/api/auth/sign-in/email \
  -H "Content-Type: application/json" \
  -d '{ "email": "alice@example.com", "password": "..." }'

curl -b cookies -X POST https://novamem.example.com/api/auth/sign-out
```

For CLI/scripts that cannot carry cookies, the same session token works as `Authorization: Bearer ns_<token>`.

### Admin endpoints: Better Auth admin plugin

Admin-only:

| Route                                    | Action                              |
| ---------------------------------------- | ----------------------------------- |
| `GET /api/auth/admin/list-users`         | List dashboard users                |
| `POST /api/auth/admin/create-user`       | Create with email + password + role |
| `POST /api/auth/admin/set-role`          | Toggle admin/user                   |
| `POST /api/auth/admin/set-user-password` | Reset password                      |
| `POST /api/auth/admin/ban-user`          | Block sign-in                       |
| `POST /api/auth/admin/unban-user`        | Restore sign-in                     |
| `POST /api/auth/admin/remove-user`       | Hard delete                         |

## User API tokens for MCP / HTTP

Mint via the dashboard or:

```bash
curl -X POST https://novamem.example.com/v1/me/tokens \
  -H "Authorization: Bearer ns_..." \
  -d '{ "label": "ci-runner" }'
```

Response includes the plaintext bearer once:

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

Server-side, the SHA-256 hash is looked up in `user_tokens`; revoked or unknown tokens return 401. Tokens are not per-project pinned. Project access is resolved from the owning user's project memberships.

### Revoke your own token

```bash
curl -X DELETE https://novamem.example.com/v1/me/tokens/<hash> \
  -H "Authorization: Bearer ns_..."
```

The hash is the SHA-256 hex returned by `GET /v1/me/tokens`, not the plaintext bearer.

## Auth modes

`NOVAMEM_AUTH_MODE` selects the active path:

| Mode     | Description                                                        |
| -------- | ------------------------------------------------------------------ |
| `none`   | Dev only. Every request is public. No isolation.                   |
| `bearer` | Single shared bearer in `NOVAMEM_AUTH_TOKEN`. One-process deploys. |
| `user`   | Default. Dashboard + Better Auth + user API tokens.                |

Most deploys want `user`.
