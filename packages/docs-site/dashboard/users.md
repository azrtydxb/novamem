---
title: Users (admin)
---

# Users (admin)

Visible only to admins. Lists every dashboard user and lets you manage them. Backed by Better Auth's admin plugin (`/api/auth/admin/*`).

## What you can do

| Action             | Effect                                                                                                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Create user**    | Email + password + role. The user can sign in immediately; their private memory is empty.                                                                               |
| **Set role**       | Toggle `admin` ↔ `user`. Effective on the user's next request — existing sessions are not invalidated.                                                                  |
| **Reset password** | Sets a new password and signs the user out everywhere (revokes all sessions).                                                                                           |
| **Ban / unban**    | Marks the user as banned; they can't sign in. Existing memory is preserved; un-ban restores access.                                                                     |
| **Delete user**    | Hard delete. Cascades: removes the user, their sessions, their user API tokens, their project memberships. Their private memory entries go with them. **Irreversible.** |

## Roles

|                                  | admin                        | user     |
| -------------------------------- | ---------------------------- | -------- |
| Manage other users (this page)   | ✓                            | ✗        |
| View tenant-aggregate metrics    | ✓                            | ✗        |
| Read audit log                   | ✓                            | ✗        |
| Revoke any token                 | ✓                            | own only |
| Read other users' private memory | ✗ (until shared via project) | ✗        |

## Audit trail

NovaMem-owned admin operations are written to `admin_audit_log`; Better Auth admin-plugin passthrough events should be corroborated with Better Auth/session logs.

## When the page is empty (and shouldn't be)

If you click Users and see only the "Loading users…" card, then nothing — that's a transient 401 / network blip on the first call after session establishment. Switch tabs and back, or hit Refresh; the v1.1.5 fix surfaces a clear error card with retry instead of an indefinite loading state.

## See also

- [Sign in & roles](./auth-roles.md) — what each role can do
- [Security model](../ops/security.md) — Better Auth setup + session handling
