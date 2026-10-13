# @azrtydxb/novamem — TypeScript client

TypeScript client for [novamem](https://github.com/azrtydxb/novamem), a tiered memory service with 5-signal hybrid retrieval (keyword + vector + graph + recency + entity), per-user isolation, project (sub-brain) scoping, sensitivity auto-detection, content-hash dedup, and async background enrichment. No runtime dependencies: it uses the platform `fetch`. Published as an ES module with its own type declarations.

```bash
npm install @azrtydxb/novamem
```

Then: `import { Client, NovamemError, isUnavailable } from "@azrtydxb/novamem";`

Requires Node 20+. Needs the Go novamem server (the first release after v1.1.7) — every route in `clients/contract/routes.json`. Every method is `async`; a client keeps no per-call state (each call gets its own timeout and abort controller), so one instance is safe to share across any number of concurrent calls.

## Quickstart

```ts
import { Client } from "@azrtydxb/novamem";

const c = new Client({
  baseUrl: process.env.NOVAMEM_URL ?? "",
  token: process.env.NOVAMEM_TOKEN ?? "", // user bearer `nm_…`
});

await c.capture({ content: "User prefers dark roast" });

const hits = await c.search({ query: "coffee preference", k: 5 });
for (const entry of hits.results) console.log(entry.id, entry.content);
```

A `nm_…` bearer carries every right the owning user has — the user's whole
memory plus every project they are a member of. Mint one from the dashboard's
API Tokens page. Configuration is injected: the package reads no environment
variables (the quickstart reads them itself) and holds no global state, so one
process can hold several clients. A `baseUrl` that is not an absolute http(s)
URL, or a blank `token`, throws a `NovamemError` with `op: "config"` from the
constructor. `ClientOptions` also takes `timeoutMs` and an injected `fetch`.

## The error contract

The client insists you can tell **"there is nothing stored about that"** apart
from **"I could not reach the store"**. Conflating the two is how an agent ends
up saying _"I have no record of that"_ when the truth is that a pod was
restarting.

```ts
import { NovamemError, isUnavailable } from "@azrtydxb/novamem";

try {
  const res = await c.search({ query: q });
  if (res.results.length === 0) {
    // Nothing is stored about that. This one is knowledge.
  }
} catch (e) {
  if (isUnavailable(e)) {
    // Could not look. Say so; do not claim ignorance.
  } else if (e instanceof NovamemError) {
    // A real answer that was not success: bad token, bad request, 404.
  } else {
    throw e;
  }
}
```

Every failure is a `NovamemError`; its flags answer the questions:

- `isUnavailable(e)` / `e.unavailable` — the store could not be consulted:
  refused dial, DNS failure, timeout, 5xx, 429, or a body that is empty, larger
  than 8 MiB, or not the JSON the API promises. Also true when the server
  answers `200 {results: [], degraded: true}` to `search`, `recent` or
  `neighbors`, which is an outage in the costume of an empty result set.
- `isRetryable(e)` / `e.retryable` — worth calling again. True for transport
  failures, timeouts, 5xx, 429 and the degraded-empty answer; never for
  401/403/400, which are configuration problems that no retry fixes, nor for a
  malformed body.
- `isNotFound(e)` / `e.notFound` — the id is not in your scope (404).
- `e.statusCode` (0 when no response arrived), `e.code` (the server's
  machine-readable code, when it sent one) and `e.op` (the operation, e.g.
  `"search"`, `"remove-member"`). A call rejected locally before it is sent (a
  blank `content`, `query` or id) throws with `statusCode` 0.
- `e.canceled` — your `AbortSignal` ended the call. That is neither unavailable
  nor retryable: you walked away, the store did not fail.

The client never retries on your behalf: reads fail fast so you can degrade in
one round trip, and `capture` — the only call where a lost request loses
information — is left for you to retry on your own schedule and budget.

Every method takes an optional last argument `{ signal?: AbortSignal }`, and
every call is bounded even without one (`timeoutMs`, default 15 000, the
`DEFAULT_TIMEOUT_MS` constant) — the bound covers the whole call, body included.
The bearer token never appears in an error message, `JSON.stringify` or
`util.inspect` output, including when the server echoes it back.

## Operations

| Method                          | Route                                          | Notes                                                                                                                                             |
| ------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capture`                       | `POST /v1/capture`                             | Client. Durable write with semantic dedup, in-place update and supersession. A declined worthiness gate is not an error: check the result's `id`. |
| `search`                        | `POST /v1/search`                              | Client. 5-signal hybrid retrieval (keyword + vector + graph + recency + entity). A degraded answer with no results throws unavailable.            |
| `recent`                        | `POST /v1/recent`                              | Client. Newest first. The request may be omitted. `since` is a `Date` or an ISO-8601 string, sent as UTC.                                         |
| `today`                         | `POST /v1/recent`                              | Client. Recent with since = 24 hours ago.                                                                                                         |
| `neighbors`                     | `POST /v1/neighbors`                           | Client. Graph walk from a seed entry id.                                                                                                          |
| `update`                        | `PUT /v1/memories/{id}`                        | Client. Rewrite in place; keeps the id, hits and edges. Prefer it to forget + capture. `update(id, request)`.                                     |
| `forget`                        | `POST /v1/forget`                              | Client. Never reports success on a failed delete. An id outside your scope is `deleted: false` with no error.                                     |
| `remember`                      | `POST /v1/remember`                            | Client. Unconditional store: no worthiness gate, no dedup pass. For content a person explicitly asked to keep.                                    |
| `context`                       | `POST /v1/context`                             | Client. Relevant and recent entries for one message, in one round trip.                                                                           |
| `sessionRecap`                  | `POST /v1/session-recap`                       | Client. End-of-session facts by category, saved as separate entries.                                                                              |
| `contextPrefix`                 | `GET /v1/context-prefix`                       | Client. Cacheable observation-log prefix. Not-found (`isNotFound`) means the observer is disabled.                                                |
| `stats`                         | `GET /v1/stats`                                | Client. Entry census by namespace and tier.                                                                                                       |
| `health`                        | `GET /health`                                  | Client. A boolean. A served `{"ok": false}`, including /health's own 503, is an answer, not an error.                                             |
| `mintToken`                     | `POST /v1/me/tokens`                           | Management. Mint a bearer for the caller. The plaintext is returned once.                                                                         |
| `listTokens`                    | `GET /v1/me/tokens`                            | Management. The caller's tokens (hashes and labels, never plaintext).                                                                             |
| `revokeToken`                   | `DELETE /v1/me/tokens/{hash}`                  | Management. Revoke one of the caller's tokens by hash.                                                                                            |
| `listProjects`                  | `GET /v1/me/projects`                          | Management. Projects the caller belongs to, with their role.                                                                                      |
| `createProject`                 | `POST /v1/me/projects`                         | Management. Create a project owned by the caller.                                                                                                 |
| `deleteProject`                 | `DELETE /v1/me/projects/{id}`                  | Management. Delete a project and its entries.                                                                                                     |
| `listProjectMembers`            | `GET /v1/me/projects/{id}/members`             | Management. A project's members.                                                                                                                  |
| `addProjectMember`              | `POST /v1/me/projects/{id}/members`            | Management. Add a user by their exact sign-in email; role is member or owner. `addProjectMember(id, email, role?)`.                               |
| `removeProjectMember`           | `DELETE /v1/me/projects/{id}/members/{userId}` | Management. Remove a member by user id.                                                                                                           |
| `removeProjectMemberByUsername` | `DELETE /v1/me/projects/{id}/members/{userId}` | Management. Look the member up by username, then remove them: two calls.                                                                          |
| `activeProject`                 | `GET /v1/me/active-project`                    | Management. The caller's active project, if any.                                                                                                  |
| `setActiveProject`              | `PUT /v1/me/active-project`                    | Management. Set the active project by id or name.                                                                                                 |
| `clearActiveProject`            | `DELETE /v1/me/active-project`                 | Management. Clear the active project. Returns nothing (`Promise<void>`).                                                                          |
| `decay`                         | `POST /v1/decay`                               | Management. Run tier decay now.                                                                                                                   |
| `hygiene`                       | `POST /v1/hygiene`                             | Management. Duplicate, stale, low-value and contradiction candidates.                                                                             |
| `evaluate`                      | `POST /v1/evaluate`                            | Management. Run a retrieval evaluation suite.                                                                                                     |
| `adoption`                      | `POST /v1/adoption`                            | Management. Diagnostics for an agent client's novamem setup.                                                                                      |
| `observe`                       | `POST /v1/observe`                             | Management. Run the observer. A disabled observer throws code `observer_disabled`, not unavailable.                                               |
| `changes`                       | `GET /v1/me/changes`                           | Management. The change feed; since is sent as UTC, afterSeq pages. `changes(since?, afterSeq?, limit?)`, `since` an ISO-8601 string.              |
| `usage`                         | `GET /v1/me/usage`                             | Management. Entry count and quota.                                                                                                                |
| `export`                        | `GET /v1/me/export`                            | Management. One page, oldest first; pass `nextAfterId` back (as `afterId`) until a page is empty.                                                 |
| `import`                        | `POST /v1/me/import`                           | Management. Store 1-200 entries unconditionally, deduplicated by content hash. An export page's entries fit as-is.                                |
| `provisionUser`                 | `POST /v1/admin/users`                         | Admin. Create a user and mint their first token, for fleet orchestrators.                                                                         |
| `revokeUserToken`               | `POST /v1/admin/tokens/revoke`                 | Admin. Revoke a bearer by presenting its plaintext.                                                                                               |
| `listUsers`                     | `GET /v1/admin/users`                          | Admin. Every user, with entry and token counts.                                                                                                   |
| `previewDeleteUser`             | `DELETE /v1/admin/users/{id}?dryRun=true`      | Admin. What deleting the user would remove, without removing it.                                                                                  |
| `deleteUser`                    | `DELETE /v1/admin/users/{id}`                  | Admin. Delete a user with their tokens, entries and owned projects.                                                                               |
| `setUserQuota`                  | `PUT /v1/admin/users/{id}/quota`               | Admin. Set quota overrides; null clears an override (so does omitting it).                                                                        |

Project and token administration are deliberately not on `Client` — an agent
process holding a client cannot perform them by accident. They live on two
separate, explicitly constructed classes that take the same `ClientOptions`
and share the same error contract: `new Management(options)` (the caller's own
`/v1/me/*` surface and the maintenance endpoints) and `new Admin(options)`
(server administration with an admin user's bearer). Keep the admin bearer on
the orchestrator side only; it must never reach an agent's context.

## Forget

Forgetting is a promise to a person, so the client will not round a failure up
to "done":

- any transport failure, 5xx, empty or unparseable body throws an unavailable
  `NovamemError`, never a result claiming `deleted: true`;
- an id that is not in your scope resolves to `{ deleted: false }` with **no**
  error — the truthful "there was nothing of yours there to delete";
- `coldDeleteOk: false` is passed through untouched. The primary row is gone
  but the vector copy survived and the server has queued it for its reaper; the
  content is still retrievable, so nobody has yet earned the word "forgotten".

## Development

```bash
cd clients/typescript
npm ci && npm test
```

The scenario suite runs against the shared scenario server
(`clients/contract/scenario-server.sh`, built with Go), so `go` must be on
`PATH`. It never touches a real novamem.
