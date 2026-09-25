# novamem — Java client

Java client for [novamem](https://github.com/azrtydxb/novamem), a tiered memory service with 5-signal hybrid retrieval (keyword + vector + graph + recency + entity), per-user isolation, project (sub-brain) scoping and content-hash dedup. Java 17+, Jackson as the one runtime dependency: `java.net.http` is the transport.

```xml
<dependency>
  <groupId>com.azrtydxb</groupId>
  <artifactId>novamem</artifactId>
  <version>0.1.0</version>
</dependency>
```

```kotlin
implementation("com.azrtydxb:novamem:0.1.0")
```

The clients are in `com.azrtydxb.novamem` (`import com.azrtydxb.novamem.Client;`),
the wire records nested in `com.azrtydxb.novamem.types.Types`
(`import com.azrtydxb.novamem.types.Types.SearchRequest;`), each built with
`.builder()`.

Requires Java 17 or later. Needs the Go novamem server (the first release after v1.1.7) — every route in `clients/contract/routes.json`. Every operation has a blocking method and an `…Async` method returning a `CompletableFuture`; cancelling the future cancels the request, and interrupting a thread blocked in the blocking form cancels it too. A `Client`, `Management` or `Admin` is safe to share across threads; create one per base URL and token and reuse it.

## Quickstart

```java
import com.azrtydxb.novamem.Client;
import com.azrtydxb.novamem.NovamemConfig;
import com.azrtydxb.novamem.types.Types.CaptureRequest;
import com.azrtydxb.novamem.types.Types.CaptureResult;
import com.azrtydxb.novamem.types.Types.MemoryEntry;
import com.azrtydxb.novamem.types.Types.SearchRequest;
import com.azrtydxb.novamem.types.Types.SearchResult;

public class Quickstart {
  public static void main(String[] args) {
    Client c =
        new Client(
            NovamemConfig.builder()
                .baseUrl(System.getenv("NOVAMEM_URL"))
                .token(System.getenv("NOVAMEM_TOKEN")) // user bearer nm_…
                .build());

    CaptureResult saved =
        c.capture(CaptureRequest.builder().content("User prefers dark roast").build());
    if (saved.id() == null) {
      System.out.println("not saved: " + saved.rejected());
    }

    SearchResult hits =
        c.search(SearchRequest.builder().query("coffee preference").k(5).build());
    for (MemoryEntry e : hits.results()) {
      System.out.println(e.content());
    }
  }
}
```

A `nm_…` bearer carries every right the owning user has — the user's whole
memory plus every project they are a member of. Mint one from the dashboard's
API Tokens page. Configuration is injected through `NovamemConfig`: the SDK
reads no environment variables (the quickstart does that itself) and holds no
global state, so one process can hold several clients. `build()` rejects a base
URL that is not an absolute http(s) URL, or a blank token, with an
`IllegalArgumentException` naming the field and never quoting the value.

## The error contract

The client insists you can tell **"there is nothing stored about that"** apart
from **"I could not reach the store"**. Conflating the two is how an agent ends
up saying _"I have no record of that"_ when the truth is that a pod was
restarting. Every failure of a call is a `NovamemException` (unchecked): thrown
by the blocking form, and the cause the `…Async` future completes with.

```java
try {
  SearchResult res = c.search(SearchRequest.builder().query(q).build());
  if (res.results().isEmpty()) {
    // Nothing is stored about that. This one is knowledge.
  }
} catch (NovamemException e) {
  if (e.isUnavailable()) {
    // Could not look. Say so; do not claim ignorance.
  } else {
    // A real answer that was not success: bad token, bad request, 404.
    System.out.println(e.op() + ": " + e.statusCode() + " " + e.code());
  }
}
```

- `isUnavailable()` — the store could not be consulted: refused dial, DNS
  failure, timeout, 5xx, 429, or a body that is empty or not the JSON the API
  promises. Also true when `search`, `recent` or `neighbors` get
  `200 {results: [], degraded: true}`, which is an outage in the costume of an
  empty result set.
- `isRetryable()` — worth calling again: a refused dial, a timeout, a 5xx, a
  429, a degraded-empty result. Never true for 401/403/400, which are
  configuration problems that no retry fixes, nor for a malformed body.
- `isNotFound()` — the id is not in your scope (a 404).
- `statusCode()` (0 when no response arrived), `code()` (the server's
  machine-readable code, or `""`), `op()` (the method that failed, e.g.
  `"search"`) and `detail()` (the server's message or the transport failure).

Arguments the server would reject — a blank `content`, `query` or id — fail
with a `NovamemException` with `statusCode()` 0 before any request is sent.

The client never retries on your behalf: reads fail fast so you can degrade in
one round trip, and `capture` — the only call where a lost request loses
information — is left for you to retry on your own schedule and budget.

Every call is bounded, redirects and body included (`NovamemConfig.timeout`,
default 15 s); running out of time is an unavailable, retryable
`NovamemException`. Cancelling an `…Async` future surfaces as
`CancellationException`, as usual. The bearer token never appears in an
exception message, including when the server echoes it back, nor in the
config's or clients' `toString()`; Java stack traces record no argument
values, so it cannot surface there either.

## Operations

Each method below also has an `…Async` twin (`search` / `searchAsync`) that
returns a `CompletableFuture` of the same result.

| Method                          | Route                                          | Notes                                                                                                                                                                                                                         |
| ------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capture`                       | `POST /v1/capture`                             | **Client.** Durable write with semantic dedup, in-place update and supersession. A declined worthiness gate is not an error: check the result's id. The id is on `CaptureResult.id()`; `rejected()` says why when it is null. |
| `search`                        | `POST /v1/search`                              | **Client.** 5-signal hybrid retrieval (keyword + vector + graph + recency + entity). A degraded answer with no results raises unavailable.                                                                                    |
| `recent`                        | `POST /v1/recent`                              | **Client.** Newest first. The request may be omitted. Pass null to omit it; `since` is an `Instant`.                                                                                                                          |
| `today`                         | `POST /v1/recent`                              | **Client.** Recent with since = 24 hours ago. Pass null for no request.                                                                                                                                                       |
| `neighbors`                     | `POST /v1/neighbors`                           | **Client.** Graph walk from a seed entry id.                                                                                                                                                                                  |
| `update`                        | `PUT /v1/memories/{id}`                        | **Client.** Rewrite in place; keeps the id, hits and edges. Prefer it to forget + capture. Takes the id and an `UpdateRequest`, which may be null.                                                                            |
| `forget`                        | `POST /v1/forget`                              | **Client.** Never reports success on a failed delete. An id outside your scope is deleted = false with no error. See below.                                                                                                   |
| `remember`                      | `POST /v1/remember`                            | **Client.** Unconditional store: no worthiness gate, no dedup pass. For content a person explicitly asked to keep.                                                                                                            |
| `context`                       | `POST /v1/context`                             | **Client.** Relevant and recent entries for one message, in one round trip.                                                                                                                                                   |
| `sessionRecap`                  | `POST /v1/session-recap`                       | **Client.** End-of-session facts by category, saved as separate entries.                                                                                                                                                      |
| `contextPrefix`                 | `GET /v1/context-prefix`                       | **Client.** Cacheable observation-log prefix. Not-found means the observer is disabled. The project may be null.                                                                                                              |
| `stats`                         | `GET /v1/stats`                                | **Client.** Entry census by namespace and tier.                                                                                                                                                                               |
| `health`                        | `GET /health`                                  | **Client.** A boolean. A served {"ok": false}, including /health's own 503, is an answer, not an error.                                                                                                                       |
| `mintToken`                     | `POST /v1/me/tokens`                           | **Management.** Mint a bearer for the caller. The plaintext is returned once.                                                                                                                                                 |
| `listTokens`                    | `GET /v1/me/tokens`                            | **Management.** The caller's tokens (hashes and labels, never plaintext).                                                                                                                                                     |
| `revokeToken`                   | `DELETE /v1/me/tokens/{hash}`                  | **Management.** Revoke one of the caller's tokens by hash.                                                                                                                                                                    |
| `listProjects`                  | `GET /v1/me/projects`                          | **Management.** Projects the caller belongs to, with their role.                                                                                                                                                              |
| `createProject`                 | `POST /v1/me/projects`                         | **Management.** Create a project owned by the caller.                                                                                                                                                                         |
| `deleteProject`                 | `DELETE /v1/me/projects/{id}`                  | **Management.** Delete a project and its entries.                                                                                                                                                                             |
| `listProjectMembers`            | `GET /v1/me/projects/{id}/members`             | **Management.** A project's members.                                                                                                                                                                                          |
| `addProjectMember`              | `POST /v1/me/projects/{id}/members`            | **Management.** Add a user by their exact sign-in email; role is member or owner.                                                                                                                                             |
| `removeProjectMember`           | `DELETE /v1/me/projects/{id}/members/{userId}` | **Management.** Remove a member by user id.                                                                                                                                                                                   |
| `removeProjectMemberByUsername` | `DELETE /v1/me/projects/{id}/members/{userId}` | **Management.** Look the member up by username, then remove them: two calls. An unknown username throws `NovamemException` with `statusCode()` 0. Cancelling the async form cancels whichever call is running.                |
| `activeProject`                 | `GET /v1/me/active-project`                    | **Management.** The caller's active project, if any.                                                                                                                                                                          |
| `setActiveProject`              | `PUT /v1/me/active-project`                    | **Management.** Set the active project by id or name.                                                                                                                                                                         |
| `clearActiveProject`            | `DELETE /v1/me/active-project`                 | **Management.** Clear the active project. Returns nothing.                                                                                                                                                                    |
| `decay`                         | `POST /v1/decay`                               | **Management.** Run tier decay now.                                                                                                                                                                                           |
| `hygiene`                       | `POST /v1/hygiene`                             | **Management.** Duplicate, stale, low-value and contradiction candidates.                                                                                                                                                     |
| `evaluate`                      | `POST /v1/evaluate`                            | **Management.** Run a retrieval evaluation suite.                                                                                                                                                                             |
| `adoption`                      | `POST /v1/adoption`                            | **Management.** Diagnostics for an agent client's novamem setup.                                                                                                                                                              |
| `observe`                       | `POST /v1/observe`                             | **Management.** Run the observer. A disabled observer raises code observer_disabled, not unavailable. The SDK reports any 503 from this route that way.                                                                       |
| `changes`                       | `GET /v1/me/changes`                           | **Management.** The change feed; since is sent as UTC, afterSeq pages. `since` is an RFC 3339 string; every argument may be null.                                                                                             |
| `usage`                         | `GET /v1/me/usage`                             | **Management.** Entry count and quota.                                                                                                                                                                                        |
| `export`                        | `GET /v1/me/export`                            | **Management.** One page, oldest first; pass nextAfterId back until a page is empty. The field is `nextAfterId()`; pass it as `afterId`.                                                                                      |
| `importEntries`                 | `POST /v1/me/import`                           | **Management.** Store 1-200 entries unconditionally, deduplicated by content hash. An export page's entries fit as-is. Named `importEntries(List<?>)` because `import` is a Java keyword.                                     |
| `provisionUser`                 | `POST /v1/admin/users`                         | **Admin.** Create a user and mint their first token, for fleet orchestrators.                                                                                                                                                 |
| `revokeUserToken`               | `POST /v1/admin/tokens/revoke`                 | **Admin.** Revoke a bearer by presenting its plaintext.                                                                                                                                                                       |
| `listUsers`                     | `GET /v1/admin/users`                          | **Admin.** Every user, with entry and token counts.                                                                                                                                                                           |
| `previewDeleteUser`             | `DELETE /v1/admin/users/{id}?dryRun=true`      | **Admin.** What deleting the user would remove, without removing it.                                                                                                                                                          |
| `deleteUser`                    | `DELETE /v1/admin/users/{id}`                  | **Admin.** Delete a user with their tokens, entries and owned projects.                                                                                                                                                       |
| `setUserQuota`                  | `PUT /v1/admin/users/{id}/quota`               | **Admin.** Set quota overrides; null clears an override. Both limits are `Integer`; pass null to clear an override.                                                                                                           |

Project and token administration are deliberately not on `Client`: `Management`
(the caller's own `/v1/me/*` surface and maintenance) and `Admin` (server
administration) are separate classes, each constructed explicitly from its own
`NovamemConfig`, so an agent process holding a `Client` cannot perform them by
accident. All three share the error contract above. `Admin` needs an admin
user's bearer; keep it on the orchestrator side only — it must never reach an
agent's context.

## Forget

Forgetting is a promise to a person, so the client will not round a failure up
to "done":

- any transport failure, 5xx, empty or unparseable body is an exception, never
  a default `ForgetResult` that reads as "deleted";
- an id that is not in your scope is `deleted() == false` with **no**
  exception — the truthful "there was nothing of yours there to delete";
- `coldDeleteOk() == false` is passed through untouched. The primary row is
  gone but the vector copy survived and the server has queued it for its
  reaper; the content is still retrievable, so nobody has yet earned the word
  "forgotten".

## Development

```bash
cd clients/java
mvn -B verify
```

The scenario tests start a scenario server built from Go, so a Go toolchain
must be on the `PATH`. `sh clients/java/check-readme.sh` compiles this README's
quickstart against the SDK.
