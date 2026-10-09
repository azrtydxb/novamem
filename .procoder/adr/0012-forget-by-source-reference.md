# 0012 — Forget by source reference

Status: accepted
Date: 2026-10-09
Issue: #338

## Context

Kuvryn Atlas derives memories from source documents. When a source is
deleted or access to it is revoked, every memory derived from it must become
unretrievable. Forget accepted only a memory id, so Atlas would have had to
mirror a source-to-ids map and forget one id at a time, where a crash partway
leaks revoked content.

## Decision

### Storage: a side table

`memory_entry_source_refs (entry_id FK ON DELETE CASCADE, organization_id,
source_ref, created_at, PRIMARY KEY (entry_id, source_ref))` with an index on
`(organization_id, source_ref)` (migration 0013). The relation is
many-to-many, so a column on `memory_entries` would be an array: it needs a
GIN index on the hottest table and rewrites the row on every merge. The
cascade means every existing delete path (forget, project delete, TTL reaper,
user delete) removes the refs with the entry and none needed to change.
`organization_id` is copied from the entry (the insert selects it from
`memory_entries`), so the lookup index leads with it.

### Write: refs merge, never replace

`sourceRefs` (at most 32, each 1-512 characters, no control characters, not
blank) is accepted on remember and capture over HTTP and MCP. When a write
dedupes onto an existing entry (exact hash, a lost insert race, or capture's
in-place update of a near duplicate) the new refs are added to that entry. The
entry now derives from both sources, so forgetting either removes it; the
alternative (replace) would let a later write from source B make an entry
survive the revocation of source A. A contradiction supersede inserts a new
entry with the new refs and leaves the superseded one with its own. Refs are
not returned on reads: that would add a join or an aggregate to every search,
recent and neighbors path, and nothing needs it.

### Forget: `sourceRef` beside `id`

`POST /v1/forget` takes exactly one of `id` and `sourceRef` (400 otherwise);
MCP `memory_forget` mirrors it. The receipt is `{sourceRef, ids, count,
coldDeleteOk}`; no match is `count: 0`, status 200.

**Scope** is forget-by-id's: without a project, the caller's own user-wide
entries inside the caller's organization; with a project (explicit, or the
active-project default, membership-checked) that project's entries whoever
wrote them. A user-wide forget never deletes project entries and a project
forget never deletes user-wide ones. Every predicate carries the organization
(entry and ref both), on top of the composite user id of ADR 0011.

**Ordering:** one transaction deletes the FTS shadow, access counters,
relations and entries of all matches (`SELECT ... FOR UPDATE` first, so a
concurrent merge cannot slip a ref in between); then the cold vector, derived
facts and changelog are handled per entry by the same helper forget-by-id
uses. Retrieval resolves every hit through the warm rows, so once the first
transaction commits nothing matched is retrievable, even if the process dies
before the cold cleanup. A failed cold delete is parked for the reaper. A
crash in that window strands an unreachable vector that is not retried, the
same residual as forget-by-id.

## Consequences

- `ForgetBySource` and `CaptureRequest.SourceRefs` exist in `clients/go` only.
  routes.json holds one method set for all SDKs and `POST /v1/forget` stays
  credited to `Client.Forget`; the other SDKs add it on first consumer.
- Refs matched exactly and case-sensitively; callers normalize.
- The warm delete is one statement per table over all ids, so a very popular
  source holds a longer transaction. Acceptable at the expected fan-out.
- Entries written before 0013 have no refs and cannot be forgotten by source.
