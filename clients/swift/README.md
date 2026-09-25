# novamem — Swift client

Swift client for [novamem](https://github.com/azrtydxb/novamem), a tiered memory service for agents. Foundation only, no dependencies.

SwiftPM reads a package from a repository's root, so this directory is published through the read-only mirror [`azrtydxb/novamem-swift`](https://github.com/azrtydxb/novamem-swift) (ADR 0010), tagged `X.Y.Z` on each `clients/swift/vX.Y.Z` release. Send changes to `clients/swift` in this repository, not to the mirror.

```text
.package(url: "https://github.com/azrtydxb/novamem-swift", from: "0.1.0")
```

and add `.product(name: "Novamem", package: "novamem-swift")` to your target's dependencies.

Requires Swift 5.9 or newer. `Package.swift` declares macOS 13 and iOS 16 (and the package builds on Linux with FoundationNetworking), but CI runs the suite on Linux only — Swift 5.9 and 6.3 — so Apple platforms are declared, not exercised. Needs the Go novamem server (the first release after v1.1.7) — every route in `clients/contract/routes.json`.

`Client`, `Management` and `Admin` are `final class`es marked `Sendable`: build one and share it across tasks. Every operation is `async throws`. Cancelling the calling task cancels the request and throws `CancellationError`, not a `NovamemError`.

## Quickstart

```swift
import Foundation
import Novamem

let env = ProcessInfo.processInfo.environment
let client = try Client(Config(
    baseURL: env["NOVAMEM_URL"] ?? "",
    token: env["NOVAMEM_TOKEN"] ?? "" // user bearer `nm_…`
))

let saved = try await client.capture(CaptureRequest(content: "User prefers dark roast"))
print("saved as \(saved.id ?? "(declined by the worthiness gate)")")

let hits = try await client.search(SearchRequest(k: 5, query: "coffee preference"))
for entry in hits.results {
    print(entry.id, entry.content)
}
```

A `nm_…` bearer carries every right the owning user has — the user's whole memory plus every project they are a member of. Mint one from the dashboard's API Tokens page. Configuration is injected: the package reads no environment variables and holds no global state, so one process can hold several clients. `Config(baseURL:token:timeout:)` throws on a base URL that is not absolute `http(s)` or on a blank token, naming the field and never quoting the value. Request initialisers take their fields as labelled arguments in alphabetical order, every optional one defaulting to nil.

## The error contract

The client insists you can tell **"there is nothing stored about that"** apart from **"I could not reach the store"**. Conflating the two is how an agent ends up saying _"I have no record of that"_ when the truth is that a pod was restarting.

```swift
do {
    let res = try await client.search(SearchRequest(query: q))
    if res.results.isEmpty {
        // Nothing is stored about that. This one is knowledge.
    }
} catch let e as NovamemError where e.isUnavailable {
    // Could not look. Say so; do not claim ignorance.
} catch let e as NovamemError {
    // A real answer that was not success: bad token, bad request, 404.
    print(e.op, e.statusCode, e.code, e.message)
} catch is CancellationError {
    // The calling task was cancelled.
}
```

- `isUnavailable` — the store could not be consulted: refused dial, DNS failure, timeout, 5xx, 429, an empty body, or a body that is not the JSON the API promises. Also true when `search`, `recent` or `neighbors` get `200 {results: [], degraded: true}`, which is an outage in the costume of an empty result set.
- `isRetryable` — worth calling again: transport failures, timeouts, 5xx, 429 and the degraded-empty answer. Never true for 401/403/400, which are configuration problems that no retry fixes, nor for a malformed body.
- `isNotFound` — the id is not in your scope (status 404).
- `statusCode` (0 when no response arrived), `code` (the server's machine-readable code, or empty), `op` (the method that failed: `"search"`, `"remove-member"`, …) and `message`. `description` renders them as `novamem <op>: <status> [<code>]: <message>`.

The client never retries on your behalf: reads fail fast so you can degrade in one round trip, and `capture` — the only call where a lost request loses information — is left for you to retry on your own schedule and budget.

Every call is bounded by `Config.timeout` (default `Config.defaultTimeout`, 15 s) even when the calling task has no deadline of its own. Responses larger than 8 MiB are refused as unavailable. The bearer token never appears in an error or in `Config`'s description, including when the server echoes it back.

## Operations

| Method                          | Route                                          | Notes                                                                                                                                                                             |
| ------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capture`                       | `POST /v1/capture`                             | **Client.** Durable write with semantic dedup, in-place update and supersession. A declined worthiness gate is not an error: check the result's `id` (nil when not saved).        |
| `search`                        | `POST /v1/search`                              | **Client.** 5-signal hybrid retrieval (keyword + vector + graph + recency + entity). A degraded answer with no results raises unavailable: a `NovamemError` with `isUnavailable`. |
| `recent`                        | `POST /v1/recent`                              | **Client.** Newest first. The request may be omitted. `recent()` with no argument works.                                                                                          |
| `today`                         | `POST /v1/recent`                              | **Client.** Recent with since = 24 hours ago. Any `since` you set is overwritten.                                                                                                 |
| `neighbors`                     | `POST /v1/neighbors`                           | **Client.** Graph walk from a seed entry id.                                                                                                                                      |
| `update`                        | `PUT /v1/memories/{id}`                        | **Client.** Rewrite in place; keeps the id, hits and edges. Prefer it to forget + capture. `update(id:_:)`.                                                                       |
| `forget`                        | `POST /v1/forget`                              | **Client.** Never reports success on a failed delete. An id outside your scope is deleted = false with no error.                                                                  |
| `remember`                      | `POST /v1/remember`                            | **Client.** Unconditional store: no worthiness gate, no dedup pass. For content a person explicitly asked to keep.                                                                |
| `context`                       | `POST /v1/context`                             | **Client.** Relevant and recent entries for one message, in one round trip.                                                                                                       |
| `sessionRecap`                  | `POST /v1/session-recap`                       | **Client.** End-of-session facts by category, saved as separate entries.                                                                                                          |
| `contextPrefix`                 | `GET /v1/context-prefix`                       | **Client.** Cacheable observation-log prefix. Not-found means the observer is disabled. `contextPrefix(project:)`; test `isNotFound`.                                             |
| `stats`                         | `GET /v1/stats`                                | **Client.** Entry census by namespace and tier.                                                                                                                                   |
| `health`                        | `GET /health`                                  | **Client.** A boolean. A served {"ok": false}, including /health's own 503, is an answer, not an error. Returns `Bool`.                                                           |
| `mintToken`                     | `POST /v1/me/tokens`                           | **Management.** Mint a bearer for the caller. The plaintext is returned once.                                                                                                     |
| `listTokens`                    | `GET /v1/me/tokens`                            | **Management.** The caller's tokens (hashes and labels, never plaintext).                                                                                                         |
| `revokeToken`                   | `DELETE /v1/me/tokens/{hash}`                  | **Management.** Revoke one of the caller's tokens by hash.                                                                                                                        |
| `listProjects`                  | `GET /v1/me/projects`                          | **Management.** Projects the caller belongs to, with their role.                                                                                                                  |
| `createProject`                 | `POST /v1/me/projects`                         | **Management.** Create a project owned by the caller.                                                                                                                             |
| `deleteProject`                 | `DELETE /v1/me/projects/{id}`                  | **Management.** Delete a project and its entries.                                                                                                                                 |
| `listProjectMembers`            | `GET /v1/me/projects/{id}/members`             | **Management.** A project's members.                                                                                                                                              |
| `addProjectMember`              | `POST /v1/me/projects/{id}/members`            | **Management.** Add a user by their exact sign-in email; role is member or owner.                                                                                                 |
| `removeProjectMember`           | `DELETE /v1/me/projects/{id}/members/{userId}` | **Management.** Remove a member by user id.                                                                                                                                       |
| `removeProjectMemberByUsername` | `DELETE /v1/me/projects/{id}/members/{userId}` | **Management.** Look the member up by username, then remove them: two calls. An unknown username is an error with status 0.                                                       |
| `activeProject`                 | `GET /v1/me/active-project`                    | **Management.** The caller's active project, if any.                                                                                                                              |
| `setActiveProject`              | `PUT /v1/me/active-project`                    | **Management.** Set the active project by id or name.                                                                                                                             |
| `clearActiveProject`            | `DELETE /v1/me/active-project`                 | **Management.** Clear the active project. Returns nothing.                                                                                                                        |
| `decay`                         | `POST /v1/decay`                               | **Management.** Run tier decay now.                                                                                                                                               |
| `hygiene`                       | `POST /v1/hygiene`                             | **Management.** Duplicate, stale, low-value and contradiction candidates.                                                                                                         |
| `evaluate`                      | `POST /v1/evaluate`                            | **Management.** Run a retrieval evaluation suite.                                                                                                                                 |
| `adoption`                      | `POST /v1/adoption`                            | **Management.** Diagnostics for an agent client's novamem setup.                                                                                                                  |
| `observe`                       | `POST /v1/observe`                             | **Management.** Run the observer. A disabled observer raises code observer_disabled, not unavailable.                                                                             |
| `changes`                       | `GET /v1/me/changes`                           | **Management.** The change feed; since is sent as UTC, afterSeq pages. A `since` that does not parse as ISO 8601 is sent unchanged.                                               |
| `usage`                         | `GET /v1/me/usage`                             | **Management.** Entry count and quota.                                                                                                                                            |
| `export`                        | `GET /v1/me/export`                            | **Management.** One page, oldest first; pass nextAfterId back until a page is empty.                                                                                              |
| `import`                        | `POST /v1/me/import`                           | **Management.** Store 1-200 entries unconditionally, deduplicated by content hash. An export page's entries fit as-is. Called as `m.import(entries:)` with `[JSONValue]`.         |
| `provisionUser`                 | `POST /v1/admin/users`                         | **Admin.** Create a user and mint their first token, for fleet orchestrators.                                                                                                     |
| `revokeUserToken`               | `POST /v1/admin/tokens/revoke`                 | **Admin.** Revoke a bearer by presenting its plaintext.                                                                                                                           |
| `listUsers`                     | `GET /v1/admin/users`                          | **Admin.** Every user, with entry and token counts.                                                                                                                               |
| `previewDeleteUser`             | `DELETE /v1/admin/users/{id}?dryRun=true`      | **Admin.** What deleting the user would remove, without removing it.                                                                                                              |
| `deleteUser`                    | `DELETE /v1/admin/users/{id}`                  | **Admin.** Delete a user with their tokens, entries and owned projects.                                                                                                           |
| `setUserQuota`                  | `PUT /v1/admin/users/{id}/quota`               | **Admin.** Set quota overrides; nil clears an override (sent as JSON null).                                                                                                       |

Project, token and user administration are deliberately not on `Client` — an agent process holding a client should not be able to perform them by accident. They live on two separate, explicitly constructed types sharing the same `Config` and error contract: `Management(config)` for the caller's own `/v1/me/*` surface and maintenance, and `Admin(config)` for server administration with an admin bearer. Keep the admin bearer on the orchestrator side only; it must never reach an agent's context.

## Forget

Forgetting is a promise to a person, so the client will not round a failure up to "done":

- any transport failure, 5xx or unparseable body **throws**, never returns a default "deleted";
- an id that is not in your scope is `ForgetResult` with `deleted == false` and **no** error — the truthful "there was nothing of yours there to delete";
- `coldDeleteOk == false` is passed through untouched. The primary row is gone but the vector copy survived and the server has queued it for its reaper; the content is still retrievable, so nobody has yet earned the word "forgotten".

## Development

```bash
cd clients/swift
swift test
```

That is the shared scenario suite, as CI runs it on Linux (Swift 5.9 and 6.3). It drives the scenario server in `clients/contract` (built with `go`, so Go must be on `PATH`) and never touches a real novamem. `sh check-readme.sh` parses this README's Quickstart.
