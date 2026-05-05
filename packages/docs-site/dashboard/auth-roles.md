---
title: Sign in & roles
---

# Sign in & roles

novamem's dashboard auth is [Better Auth](https://www.better-auth.com/) with email + password. Two roles are baked in: **admin** and **user**.

## Bootstrap the first admin

On a fresh install with no users, set:

```bash
NOVAMEM_BOOTSTRAP_ADMIN_EMAIL=alice@example.com
NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD=$(openssl rand -hex 16)
```

Start the server. On first boot novamem creates the user via Better Auth and scrubs the password from `process.env`. Sign in with those credentials, then:

1. Change the password from `/admin/account` (or whatever route the SPA exposes for self-service)
2. Create the rest of your users from `/admin/users`

The bootstrap flow only fires when the `user` table is empty. After that the env values are ignored.

## Roles

| Capability | admin | user |
|---|---|---|
| Sign in to dashboard | ✓ | ✓ |
| Create / list / share / delete projects | ✓ | ✓ |
| Mint own bearer tokens | ✓ | ✓ |
| Browse / search / remember / forget — own memories | ✓ | ✓ |
| Browse / search project memories the user is a member of | ✓ | ✓ |
| Manage other users (`/admin/users`) — create, role, ban, password reset | ✓ | ✗ |
| View tenant-aggregate metrics | ✓ | ✗ |
| Revoke any tenant token | ✓ | own only |
| Read the audit log | ✓ | ✗ |

A user's "own memory" is private — invisible to admins until the user shares it via project membership. Admin role grants administrative powers, not read access to private user memories.

## Sessions

- HttpOnly cookie signed with `NOVAMEM_COOKIE_SECRET`
- Default expiry: 7 days, sliding (extends on activity)
- Sign out clears the cookie + revokes the session row in Better Auth's `session` table
- `Authorization: Bearer ns_…` is an alternate path — same session token, used by CLI / scripts that can't carry cookies

Rotate `NOVAMEM_COOKIE_SECRET` to forcibly invalidate every active session.

## See also

- [Users (admin)](/dashboard/users) — create / role / ban
- [API tokens](/dashboard/tokens) — bearer lifecycle
- [Security model](/ops/security) — full auth flow + threat model
