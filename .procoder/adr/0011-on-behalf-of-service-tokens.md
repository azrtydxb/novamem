# 0011 — On-behalf-of service tokens and organization scoping

Status: accepted
Date: 2026-10-09
Issue: #337

## Context

Kuvryn Atlas is multi-tenant: one installation serves several
organizations and keeps personal, agent and team memory in NovaMem. NovaMem
authenticated with one `nm_` token per _NovaMem user_ and had no tenant
concept and no way for a service to act for a user. Atlas would have had to
create, mint and store a NovaMem account and token for every one of its
users, and nothing in the server would have stopped a bug in Atlas, or a
leaked credential, from crossing organizations.

Two things were needed: a credential a service can issue for _its_ users
without NovaMem knowing them, and a hard organization boundary around
everything that credential touches.

## Decision

### Token: a service-signed EdDSA JWT

An admin registers a service's **Ed25519 public key** (`POST
/v1/admin/service-keys`), bound to **one organization**. NovaMem stores only
the public key, in `service_keys (id, name, organization_id, public_key,
created_at, revoked_at)`. The service mints short-lived JWTs itself and
sends one as the bearer.

    header  {"alg":"EdDSA","kid":"<service_keys.id>"}
    claims  {"sub":"<user>","org":"<org>","aud":"novamem","iat":N,"exp":N}

A token is rejected (a bare 401, the reason only in the debug log) if any of
these hold: it is not three well-formed parts; `alg` is not `EdDSA`; the
`kid` is unknown or revoked; the signature does not verify; `aud` lacks
`novamem`; it is expired (30 s leeway) or `iat` is more than 30 s in the
future; `exp - iat` exceeds **15 minutes** (rejected, not clamped);
`org` differs from the key's bound org; `sub` or `org` fail the charset and
length rules below. Revocation is checked against the database on every
request, so it takes effect immediately. Verification (`internal/auth/obo.go`)
is pure apart from an injected key lookup and uses only `crypto/ed25519`.
No JWT library was added.

### Identity: a free-form subject scoped by org

`sub` need not be a NovaMem user, and no user row is created. Charsets:
`org` is `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`; `sub` is
`[A-Za-z0-9][A-Za-z0-9._:@+=-]{0,127}`.

Service keys **may not be bound to `default`**, at registration (400) and
again at verification. Every pre-existing row, and every row an ordinary
user writes, belongs to org `default`; a key bound to it could act as any
real user.

### Isolation: a reserved composite user id

An OBO caller's effective internal user id is

    org:<org>/<sub>

(`internal/tenant`). Real NovaMem user ids are ULIDs, Better Auth ids or
`public`; none contains `:`, and the `org:` prefix is rejected as a real
identity. Because `org` excludes `/` and `:`, the id splits unambiguously at
the first `/`, and a `sub` can never forge another org's prefix.

Every store, index and cache keyed by `user_id` then isolates
organizations without knowing organizations exist: entries, the FTS shadow
table, relations, vector scope keys (`u:org:acme/alice`), facts and graph,
sessions, stats, quotas, rate limits, metrics and MCP session ids.

### Defense in depth: `memory_entries.organization_id`

Migration 0012 adds `organization_id text NOT NULL DEFAULT 'default'` (a
constant default is catalog-only on PostgreSQL 11+, so the backfill does
not rewrite the table) with indexes `(organization_id, user_id)` and
`(organization_id, user_id, cold)`. Writes set it from the caller's org;
`GetEntry`, `GetEntries`, `ListRecent`/`ListNamespaces`, content-hash
dedupe, update and delete add `organization_id = <caller org>`. The user_id
filter alone would already isolate; the column means a single missed or
broken user_id predicate is not a cross-tenant read. The test corrupts a
row's org column to prove the filter works on its own.

### What an OBO caller may reach

The memory data plane (`/v1/remember|capture|search|context|recent|forget|
neighbors|stats|hygiene|evaluate|adoption|session-recap`, `PUT
/v1/memories/{id}`) and `/mcp` (same `withAuth`, same caller resolution, so
the same scoping). **Denied with 403:** `/v1/admin/*`, `/v1/auth/*`,
`/v1/me/*` (accounts, token management, projects), the dashboard, any
`project`/`includeProjects` parameter, and the MCP `project_*` tools and
project scopes. Projects are a sharing construct between real accounts.
Accepted in `user` auth mode only; `none` and `bearer` have no service-key
admin and ignore the scheme.

### Org or user in the request body: ignored

Identity comes only from the verified token. A body field such as `userId`
or `organizationId` is never read (request bodies already ignore unknown
fields). Rejecting would have been noisier and would need a body inspection
step in the middleware for no gain; the test sends such fields and asserts
they have no effect.

## Alternatives considered

- **A NovaMem-minted JWT** (admin issues a signed token per service). The
  server must hold a signing secret, every replica must share it, and a
  database or secret leak lets an attacker mint for any org. With
  service-held keys NovaMem holds nothing that can mint, and a service can
  rotate or mint per call without a round trip.
- **An opaque service key plus an `X-On-Behalf-Of` header.** Simple, but the
  user and org are then unsigned request metadata next to a long-lived
  secret: a leaked key reaches every user of its org forever, nothing
  bounds token lifetime, and the key must be stored hashed and compared on
  every call like any bearer. A signed, expiring claim set bounds a leak to
  15 minutes and one subject.
- **Threading `organization_id` through every query instead of a composite
  user id.** Many tables (fts, vectors, facts, graph, sessions, stats,
  quotas) are keyed by `user_id`; adding an org parameter to each is a wide
  change in which any omission is a leak. The composite makes the existing
  predicates do the work.
- **A NovaMem user row per OBO subject.** Atlas would need provisioning and
  teardown of accounts it does not otherwise need.

## Consequences

- `visibleEntries` (`warmstore/visibility.go`) is **unchanged**: it stays a
  UNION ALL semi-join keyed on `$1`. OBO users have no project memberships,
  so its project branch contributes nothing for them, and the first branch
  is user_id-scoped through the composite id.
- The `organization_id` filter is not on the FTS shadow table, the vector
  store, `memory_relations` or the maintenance jobs (decay, dream cycle,
  reaper). Those are keyed by `user_id` and already isolated by the
  composite; the jobs operate per row or per user and never merge across
  users.
- Each distinct `(org, sub)` is a distinct user for quotas, rate limits and
  metrics. There is no org-level quota yet.
- A real user id must never begin with `org:`. Nothing in NovaMem lets a
  caller choose a user id today (they are generated); a future feature that
  does must reject the prefix.
- MCP session ids are bound to the composite id, so a session minted for one
  `(org, sub)` is unusable by another. A session outlives the 15-minute
  token; each request still presents a fresh, valid token.
- `tools/list` over MCP still advertises the `project_*` tools to an OBO
  caller; calling one returns an error.
- Deleting data for a departed OBO subject or a whole org has no admin
  endpoint yet (`DELETE /v1/admin/users/{id}` only knows real users).
- The `clients/go` module gains `MintOBOToken`, `NewOBOTokenSource`,
  `Config.TokenSource` and `Admin.{Register,List,Revoke}ServiceKey`. The
  other SDKs treat the three service-key routes as a recorded non-goal in
  `clients/contract/routes.json` until they have a consumer (ADR 0009).
- CI's go job now runs a pinned `pgvector/pgvector` Postgres service, which
  also turns on the existing database tests that used to skip there.
