# Project (sub-brain) lifecycle — project_list · create · delete · activate · deactivate · share · unshare

Seven MCP tools for managing projects. A **project** is a sub-brain — a separate shelf of memories alongside the user's global memory. Memory entries can belong to one project; projects can be shared with other users by adding them as members.

When passing `project` to any tool, an id (ULID) **or** a human name both work.

## project_list

No inputs. Returns the projects the caller is a member of, with `id`, `name`, and the caller's `role` (`owner` | `member`) for each.

Use this when the user says "what projects do I have access to" or before activating one whose exact name you're unsure of.

## project_create

Inputs:
- `name` (required, string, 1–128 chars) — human-readable project name

Caller becomes owner. Returns the new project's server-assigned ULID. Use when the user says "start a new project for X" or "spin up a sub-brain for the Y migration".

## project_delete

Inputs:
- `project` (required, string) — id or human name

**Owner-only.** Removes every memory entry, vector, and graph node belonging to the project. Irrecoverable. Confirm with the user before calling unless they explicitly said "delete it".

## project_activate

Inputs:
- `project` (required, string) — id or human name

Sets the caller's active project. Subsequent `memory_*` calls without an explicit `project` arg default to it:
- `search` / `recent` / `neighbors` union it with user-global
- `remember` / `forget` / `update` target it directly

Idempotent. Use when the user signals they're working on a specific project ("let's switch to Phoenix for a bit").

## project_deactivate

No inputs. Clears the caller's active project — `memory_*` calls without `project` fall back to user-global only.

Use when the user signals they're done with the current project ("switching contexts", "back to general work").

## project_share

Inputs:
- `project` (required, string) — id or human name
- `username` (required, string) — invitee's email or display name

**Owner-only.** Adds another user as a member; the invitee can read and write the project's memories. Use when the user says "let X access the Phoenix project" or "share Phoenix with alice@…".

## project_unshare

Inputs:
- `project` (required, string) — id or human name
- `username` (required, string) — member's email or display name

**Owner-only.** Removes a member's access. The owner cannot unshare themselves — use `project_delete` instead. Removing a member also drops the membership row atomically.

## Errors

- `404 no such project '<arg>'` — id/name didn't resolve to anything; suggest `project_list`
- `403 not a member of project '<name>' (id <ulid>)` — exists but you can't reach it
- `403 owner-only` — you're a member but not the owner; only owners can `delete` / `share` / `unshare`
- `400 cannot unshare owner` — owner trying to unshare themselves; use `delete` instead

## Tips

- Names are human-friendly but not unique across users — when in doubt, prefer the id
- Active project is per-user, not per-token — switching agents/clients keeps your active project
- Sharing doesn't grant ownership — only the owner can delete or change membership
