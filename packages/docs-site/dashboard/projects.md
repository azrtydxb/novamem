---
title: Projects (sub-brains)
---

# Projects (sub-brains)

A project is a shared scope for memory. Use them when you want a body of memory visible to a group of people instead of just yourself.

## Mental model

Every entry has exactly one owner-user. By default that's you and it's invisible to everyone else. Adding the entry under a project widens the visibility to every member of that project — and only those members.

```
user ─┬── private memory                          (only you see it)
      │
      └── project memberships
            ├── alice's project   (alice + bob + you all see entries here)
            └── platform team     (everyone in `platform-team`)
```

Memory crosses user boundaries **only** through explicit project membership. There is no "share a single entry"; sharing is at the project granularity.

## Create

Projects page → **Create project** → pick a human name. The id is a server-assigned ULID. You become the owner automatically.

```bash
curl -X POST https://novamem.example.com/v1/me/projects \
  -H "Authorization: Bearer ns_..." \
  -d '{ "name": "Phoenix" }'
```

## Activate (sidebar switcher)

The sidebar's project switcher sets the **active scope** for subsequent search / recent / today / graph calls. The switcher persists to `localStorage` (`nm-active-project`) so it survives page reloads.

- **Global memory only** — searches your private user-global store.
- **A specific project** — unions user-global with that project's entries.

Activating doesn't write anything; `memory_remember` calls still write to user-global by default unless you pass `project: "<name|id>"` explicitly.

## Share

Project page → expand a project → **Add member** → username. The member can read + write the project's memory immediately. Removing a member revokes access immediately too — no re-encryption needed because there's no per-user encryption layer (security boundary is the database, not crypto).

## Roles

Within a project there are two roles:

| | Owner | Member |
|---|---|---|
| Read project memory | ✓ | ✓ |
| Write project memory | ✓ | ✓ |
| Add / remove other members | ✓ | ✗ |
| Delete the project | ✓ | ✗ (can leave only) |

The owner is the user who created the project. Ownership doesn't transfer; if the owner leaves, the project goes with them via the **Delete project** action (which cascades all entries + cold collections + graph nodes).

## Delete vs leave

- **Delete** (owner only) — full cascade: every memory entry across every namespace, all cold-tier Qdrant collections, all graph nodes. Irreversible.
- **Leave** (member only) — drops your `project_members` row. Project keeps existing for the other members. You no longer see its entries.

## Why projects, not tags?

Tags are easy to forget; projects are explicit. The visibility boundary is the same primitive that gates every search and every write — there's no path where a private memory leaks via a tag-like field. If you want intra-project organisation, use **namespaces** within the project.

## See also

- [Mental model](../concepts/mental-model.md) — projects vs namespaces
- [Multi-tenancy architecture](../architecture/multi-tenancy.md) — how projects scale across tenants
