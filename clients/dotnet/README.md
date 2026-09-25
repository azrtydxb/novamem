# novamem — .NET client

.NET client for [novamem](https://github.com/azrtydxb/novamem), a tiered memory service with 5-signal hybrid retrieval (keyword + vector + graph + recency + entity), per-user isolation, project (sub-brain) scoping and content-hash dedup. .NET 8+, no package references: the framework's `HttpClient` and `System.Text.Json` are all it uses.

```bash
dotnet add package Novamem
```

Everything is in one namespace: `using Novamem;`.

Requires .NET 8 or later. Needs the Go novamem server (the first release after v1.1.7) — every route in `clients/contract/routes.json`. Every method is `…Async`, takes an optional `CancellationToken`, and returns a `Task`. A `Client`, `Management` or `Admin` is safe to share across threads; create one per base URL and token and reuse it.

## Quickstart

```csharp
using System;
using Novamem;

var c = new Client(
    new NovamemOptions
    {
        BaseUrl = Environment.GetEnvironmentVariable("NOVAMEM_URL") ?? "",
        Token = Environment.GetEnvironmentVariable("NOVAMEM_TOKEN") ?? "", // user bearer nm_…
    }
);

var saved = await c.CaptureAsync(new CaptureRequest { Content = "User prefers dark roast" });
if (saved.Id is null)
    Console.WriteLine($"not saved: {saved.Rejected}");

var hits = await c.SearchAsync(new SearchRequest { Query = "coffee preference", K = 5 });
foreach (var e in hits.Results)
    Console.WriteLine(e.Content);
```

A `nm_…` bearer carries every right the owning user has — the user's whole
memory plus every project they are a member of. Mint one from the dashboard's
API Tokens page. Configuration is injected through `NovamemOptions`: the SDK
reads no environment variables (the quickstart does that itself) and holds no
global state, so one process can hold several clients. The constructor rejects
a base URL that is not an absolute http(s) URL, or a blank token, with an
`ArgumentException` naming the field and never quoting the value.

## The error contract

The client insists you can tell **"there is nothing stored about that"** apart
from **"I could not reach the store"**. Conflating the two is how an agent ends
up saying _"I have no record of that"_ when the truth is that a pod was
restarting. Every failure of a call is a `NovamemException`.

```csharp
try
{
    var res = await c.SearchAsync(new SearchRequest { Query = q });
    if (res.Results.Count == 0)
    {
        // Nothing is stored about that. This one is knowledge.
    }
}
catch (NovamemException e) when (e.IsUnavailable)
{
    // Could not look. Say so; do not claim ignorance.
}
catch (NovamemException e)
{
    // A real answer that was not success: bad token, bad request, 404.
    Console.WriteLine($"{e.Op}: {e.StatusCode} {e.Code}");
}
```

- `IsUnavailable` — the store could not be consulted: refused dial, DNS
  failure, timeout, 5xx, 429, or a body that is empty or not the JSON the API
  promises. Also true when `SearchAsync`, `RecentAsync` or `NeighborsAsync` get
  `200 {results: [], degraded: true}`, which is an outage in the costume of an
  empty result set.
- `IsRetryable` — worth calling again: a refused dial, a timeout, a 5xx, a 429,
  a degraded-empty result. Never true for 401/403/400, which are configuration
  problems that no retry fixes, nor for a malformed body.
- `IsNotFound` — the id is not in your scope (a 404).
- `StatusCode` (0 when no response arrived), `Code` (the server's
  machine-readable code, or `""`), `Op` (the method that failed, e.g.
  `"search"`) and `Detail` (the server's message or the transport failure).

Arguments the server would reject — a blank `Content`, `Query` or id — throw a
`NovamemException` with `StatusCode` 0 before any request is sent.

The client never retries on your behalf: reads fail fast so you can degrade in
one round trip, and `CaptureAsync` — the only call where a lost request loses
information — is left for you to retry on your own schedule and budget.

Every call is bounded even when its `CancellationToken` never fires
(`NovamemOptions.Timeout`, default 15 s); running out of time is an unavailable,
retryable `NovamemException`. Cancelling your own token throws
`OperationCanceledException`, as usual. The bearer token never appears in an
exception message, including when the server echoes it back, nor in the
options' or clients' `ToString()`.

## Operations

| Method                               | Route                                          | Notes                                                                                                                                                                                                                     |
| ------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CaptureAsync`                       | `POST /v1/capture`                             | **Client.** Durable write with semantic dedup, in-place update and supersession. A declined worthiness gate is not an error: check the result's id. The id is on `CaptureResult.Id`; `Rejected` says why when it is null. |
| `SearchAsync`                        | `POST /v1/search`                              | **Client.** 5-signal hybrid retrieval (keyword + vector + graph + recency + entity). A degraded answer with no results raises unavailable.                                                                                |
| `RecentAsync`                        | `POST /v1/recent`                              | **Client.** Newest first. The request may be omitted. `Since` is a timestamp string, sent as UTC.                                                                                                                         |
| `TodayAsync`                         | `POST /v1/recent`                              | **Client.** Recent with since = 24 hours ago.                                                                                                                                                                             |
| `NeighborsAsync`                     | `POST /v1/neighbors`                           | **Client.** Graph walk from a seed entry id.                                                                                                                                                                              |
| `UpdateAsync`                        | `PUT /v1/memories/{id}`                        | **Client.** Rewrite in place; keeps the id, hits and edges. Prefer it to forget + capture. Takes the id and an optional `UpdateRequest`.                                                                                  |
| `ForgetAsync`                        | `POST /v1/forget`                              | **Client.** Never reports success on a failed delete. An id outside your scope is deleted = false with no error. See below.                                                                                               |
| `RememberAsync`                      | `POST /v1/remember`                            | **Client.** Unconditional store: no worthiness gate, no dedup pass. For content a person explicitly asked to keep.                                                                                                        |
| `ContextAsync`                       | `POST /v1/context`                             | **Client.** Relevant and recent entries for one message, in one round trip.                                                                                                                                               |
| `SessionRecapAsync`                  | `POST /v1/session-recap`                       | **Client.** End-of-session facts by category, saved as separate entries.                                                                                                                                                  |
| `ContextPrefixAsync`                 | `GET /v1/context-prefix`                       | **Client.** Cacheable observation-log prefix. Not-found means the observer is disabled. Takes an optional project.                                                                                                        |
| `StatsAsync`                         | `GET /v1/stats`                                | **Client.** Entry census by namespace and tier.                                                                                                                                                                           |
| `HealthAsync`                        | `GET /health`                                  | **Client.** A boolean. A served {"ok": false}, including /health's own 503, is an answer, not an error.                                                                                                                   |
| `MintTokenAsync`                     | `POST /v1/me/tokens`                           | **Management.** Mint a bearer for the caller. The plaintext is returned once.                                                                                                                                             |
| `ListTokensAsync`                    | `GET /v1/me/tokens`                            | **Management.** The caller's tokens (hashes and labels, never plaintext).                                                                                                                                                 |
| `RevokeTokenAsync`                   | `DELETE /v1/me/tokens/{hash}`                  | **Management.** Revoke one of the caller's tokens by hash.                                                                                                                                                                |
| `ListProjectsAsync`                  | `GET /v1/me/projects`                          | **Management.** Projects the caller belongs to, with their role.                                                                                                                                                          |
| `CreateProjectAsync`                 | `POST /v1/me/projects`                         | **Management.** Create a project owned by the caller.                                                                                                                                                                     |
| `DeleteProjectAsync`                 | `DELETE /v1/me/projects/{id}`                  | **Management.** Delete a project and its entries.                                                                                                                                                                         |
| `ListProjectMembersAsync`            | `GET /v1/me/projects/{id}/members`             | **Management.** A project's members.                                                                                                                                                                                      |
| `AddProjectMemberAsync`              | `POST /v1/me/projects/{id}/members`            | **Management.** Add a user by their exact sign-in email; role is member or owner.                                                                                                                                         |
| `RemoveProjectMemberAsync`           | `DELETE /v1/me/projects/{id}/members/{userId}` | **Management.** Remove a member by user id.                                                                                                                                                                               |
| `RemoveProjectMemberByUsernameAsync` | `DELETE /v1/me/projects/{id}/members/{userId}` | **Management.** Look the member up by username, then remove them: two calls. An unknown username throws `NovamemException` with `StatusCode` 0.                                                                           |
| `ActiveProjectAsync`                 | `GET /v1/me/active-project`                    | **Management.** The caller's active project, if any.                                                                                                                                                                      |
| `SetActiveProjectAsync`              | `PUT /v1/me/active-project`                    | **Management.** Set the active project by id or name.                                                                                                                                                                     |
| `ClearActiveProjectAsync`            | `DELETE /v1/me/active-project`                 | **Management.** Clear the active project. Returns nothing.                                                                                                                                                                |
| `DecayAsync`                         | `POST /v1/decay`                               | **Management.** Run tier decay now.                                                                                                                                                                                       |
| `HygieneAsync`                       | `POST /v1/hygiene`                             | **Management.** Duplicate, stale, low-value and contradiction candidates.                                                                                                                                                 |
| `EvaluateAsync`                      | `POST /v1/evaluate`                            | **Management.** Run a retrieval evaluation suite.                                                                                                                                                                         |
| `AdoptionAsync`                      | `POST /v1/adoption`                            | **Management.** Diagnostics for an agent client's novamem setup.                                                                                                                                                          |
| `ObserveAsync`                       | `POST /v1/observe`                             | **Management.** Run the observer. A disabled observer raises code observer_disabled, not unavailable. The SDK reports any 503 from this route that way.                                                                   |
| `ChangesAsync`                       | `GET /v1/me/changes`                           | **Management.** The change feed; since is sent as UTC, afterSeq pages. `since` is a timestamp string.                                                                                                                     |
| `UsageAsync`                         | `GET /v1/me/usage`                             | **Management.** Entry count and quota.                                                                                                                                                                                    |
| `ExportAsync`                        | `GET /v1/me/export`                            | **Management.** One page, oldest first; pass nextAfterId back until a page is empty. The field is `NextAfterId`; pass it as `afterId`.                                                                                    |
| `ImportAsync`                        | `POST /v1/me/import`                           | **Management.** Store 1-200 entries unconditionally, deduplicated by content hash. An export page's entries fit as-is. Takes `IEnumerable<JsonElement>`.                                                                  |
| `ProvisionUserAsync`                 | `POST /v1/admin/users`                         | **Admin.** Create a user and mint their first token, for fleet orchestrators.                                                                                                                                             |
| `RevokeUserTokenAsync`               | `POST /v1/admin/tokens/revoke`                 | **Admin.** Revoke a bearer by presenting its plaintext.                                                                                                                                                                   |
| `ListUsersAsync`                     | `GET /v1/admin/users`                          | **Admin.** Every user, with entry and token counts.                                                                                                                                                                       |
| `PreviewDeleteUserAsync`             | `DELETE /v1/admin/users/{id}?dryRun=true`      | **Admin.** What deleting the user would remove, without removing it.                                                                                                                                                      |
| `DeleteUserAsync`                    | `DELETE /v1/admin/users/{id}`                  | **Admin.** Delete a user with their tokens, entries and owned projects.                                                                                                                                                   |
| `SetUserQuotaAsync`                  | `PUT /v1/admin/users/{id}/quota`               | **Admin.** Set quota overrides; null clears an override. Both limits are `int?` defaulting to null, so an omitted limit is sent as null and clears that override.                                                         |

Project and token administration are deliberately not on `Client`: `Management`
(the caller's own `/v1/me/*` surface and maintenance) and `Admin` (server
administration) are separate classes, each constructed explicitly from its own
`NovamemOptions`, so an agent process holding a `Client` cannot perform them by
accident. All three share the error contract above. `Admin` needs an admin
user's bearer; keep it on the orchestrator side only — it must never reach an
agent's context.

## Forget

Forgetting is a promise to a person, so the client will not round a failure up
to "done":

- any transport failure, 5xx, empty or unparseable body is an exception, never
  a default `ForgetResult` that reads as "deleted";
- an id that is not in your scope is `Deleted == false` with **no** exception —
  the truthful "there was nothing of yours there to delete";
- `ColdDeleteOk == false` is passed through untouched. The primary row is gone
  but the vector copy survived and the server has queued it for its reaper; the
  content is still retrievable, so nobody has yet earned the word "forgotten".

## Development

```bash
cd clients/dotnet
dotnet test tests/Novamem.Tests
```

The tests run the shared scenario suite against a scenario server built from
Go, so a Go toolchain must be on the `PATH`. `sh clients/dotnet/check-readme.sh`
compiles this README's quickstart against the SDK.
