---
title: Authentication
---

# Authentication

Three auth surfaces are used in production:

- **Better Auth** (`/api/auth/*`) — dashboard sessions via HttpOnly cookie, plus `Bearer ns_…` session tokens for scripts that cannot carry cookies.
- **User API tokens** (`Bearer nm_…`) — data-plane access for MCP and HTTP integrations. Tokens are owned by a dashboard user and inherit that user's access to user-global memory and shared projects.

- **On-behalf-of service tokens** (`Bearer <JWT>`) — a registered service acts for its own end users inside one organization, without a NovaMem account per user. See [below](#on-behalf-of-service-tokens).

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
  "token": "nm_your-token-here"
}
```

Use it on data-plane requests:

```bash
curl -X POST https://novamem.example.com/v1/search \
  -H "Authorization: Bearer $NOVAMEM_TOKEN" \
  -d '{ "query": "..." }'
```

Server-side, the SHA-256 hash is looked up in `user_tokens`; revoked or unknown tokens return 401. Tokens are not per-project pinned. Project access is resolved from the owning user's project memberships.

### Revoke your own token

```bash
curl -X DELETE https://novamem.example.com/v1/me/tokens/<hash> \
  -H "Authorization: Bearer ns_..."
```

The hash is the SHA-256 hex returned by `GET /v1/me/tokens`, not the plaintext bearer.

## On-behalf-of service tokens

For a multi-tenant service (Kuvryn Atlas is the first) that keeps memory for many users across many organizations. Design and alternatives: ADR 0011. Available in `user` auth mode.

**1. Register the service's public key.** The service generates an Ed25519 key pair and keeps the private half. An admin registers the public half, bound to exactly one organization. NovaMem stores only the public key.

```bash
curl -X POST https://novamem.example.com/v1/admin/service-keys \
  -H "Authorization: Bearer $ADMIN_NM_TOKEN" -H "Content-Type: application/json" \
  -d '{ "name": "atlas-acme", "organizationId": "acme", "publicKey": "<raw 32-byte Ed25519 key, base64url>" }'
```

The response's `id` is the `kid`. `GET /v1/admin/service-keys` lists keys (revoked ones included); `DELETE /v1/admin/service-keys/{id}` revokes one and takes effect on the next request. `organizationId` is `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` and may **not** be `default` (that organization holds every ordinary user's data).

**2. Mint a token per call (or per few calls) and send it as the bearer.** It is an EdDSA JWT:

| Part                | Value                                                                |
| ------------------- | -------------------------------------------------------------------- |
| header `alg`        | `EdDSA`                                                              |
| header `kid`        | the service key `id`                                                 |
| claim `sub`         | the end user, `[A-Za-z0-9][A-Za-z0-9._:@+=-]*`, up to 128 characters |
| claim `org`         | must equal the key's bound organization                              |
| claim `aud`         | `novamem`                                                            |
| claims `iat`, `exp` | `exp - iat` at most 15 minutes                                       |

Anything else is a bare `401`: bad signature, unknown or revoked `kid`, wrong `alg` or `aud`, expired (30 s leeway), lifetime over 15 minutes, `org` different from the key's, or a malformed `sub`.

**3. What the token can do.** Everything it reads and writes is scoped to `(org, sub)`: org A's `alice` cannot see org A's `bob`, and no token of org B can read, search, update or forget org A's entries. An `org` or `userId` in a request body is ignored; identity comes only from the token. The token reaches the memory data plane and `/mcp`. It gets `403` on `/v1/admin/*`, `/v1/auth/*`, `/v1/me/*` (accounts, token management, projects) and on any `project` parameter. Ordinary `nm_` tokens, cookies and all existing data (organization `default`) are unaffected.

With the Go client:

```go
src, _ := novamem.NewOBOTokenSource(priv, kid, "acme", "alice", 10*time.Minute)
c, _ := novamem.New(novamem.Config{BaseURL: baseURL, TokenSource: src})
```

## Auth modes

`NOVAMEM_AUTH_MODE` selects the active path:

| Mode     | Description                                                        |
| -------- | ------------------------------------------------------------------ |
| `none`   | Dev only. Every request is public. No isolation.                   |
| `bearer` | Single shared bearer in `NOVAMEM_AUTH_TOKEN`. One-process deploys. |
| `user`   | Default. Dashboard + Better Auth + user API tokens.                |

Most deploys want `user`.
