# novamem — Python client

Python client for [novamem](https://github.com/azrtydxb/novamem), a tiered memory service with 5-signal hybrid retrieval (keyword + vector + graph + recency + entity), per-user isolation, project (sub-brain) scoping, sensitivity auto-detection, content-hash dedup, and async background enrichment. Standard library only: installing it pulls in no other package.

```bash
pip install novamem
```

Then, in Python: `from novamem import Client, CaptureRequest, SearchRequest`.

Requires Python 3.10+. Needs the Go novamem server (the first release after v1.1.7) — every route in `clients/contract/routes.json`. `Client`, `Management` and `Admin` are synchronous (blocking `urllib`) and hold no per-call state, so one instance is safe to share across threads. `AsyncClient`, `AsyncManagement` and `AsyncAdmin` have the same methods as coroutines: each call runs its sync twin in a worker thread (`asyncio.to_thread`), so one instance is safe to share across tasks. Cancelling the awaiting task raises `asyncio.CancelledError` as usual; the abandoned request still ends within the client's timeout.

## Quickstart

```python
import os

from novamem import CaptureRequest, Client, SearchRequest

c = Client(os.environ["NOVAMEM_URL"], os.environ["NOVAMEM_TOKEN"])

c.capture(CaptureRequest(content="User prefers dark roast"))

hits = c.search(SearchRequest(query="coffee preference", k=5))
for entry in hits.results:
    print(entry.id, entry.content)
```

A `nm_…` bearer carries every right the owning user has — the user's whole
memory plus every project they are a member of. Mint one from the dashboard's
API Tokens page. Configuration is injected: the package reads no environment
variables (the quickstart reads them itself) and holds no global state, so one
process can hold several clients. A base URL that is not an absolute http(s)
URL, or a blank token, raises `ConfigError` (a `ValueError`) at construction.

## The error contract

The client insists you can tell **"there is nothing stored about that"** apart
from **"I could not reach the store"**. Conflating the two is how an agent ends
up saying _"I have no record of that"_ when the truth is that a pod was
restarting.

```python
from novamem import NovamemError, SearchRequest, UnavailableError

try:
    res = c.search(SearchRequest(query=q))
except UnavailableError:
    ...  # Could not look. Say so; do not claim ignorance.
except NovamemError as e:
    ...  # A real answer that was not success: bad token, bad request, 404.
else:
    if not res.results:
        ...  # Nothing is stored about that. This one is knowledge.
```

- `UnavailableError` (`e.unavailable` is true) — the store could not be
  consulted: refused dial, DNS failure, timeout, 5xx, 429, or a body that is
  empty, larger than 8 MiB, or not the JSON the API promises. Also raised when
  the server answers `200 {results: [], degraded: true}` to `search`, `recent`
  or `neighbors`, which is an outage in the costume of an empty result set.
- `e.retryable` — worth calling again. True for transport failures, timeouts,
  5xx, 429 and the degraded-empty answer; never for 401/403/400, which are
  configuration problems that no retry fixes, nor for a malformed body.
- `NotFoundError` — the id is not in your scope (404).
- Every `NovamemError` carries `status_code` (0 when no response arrived),
  `code` (the server's machine-readable code, when it sent one), `op` (the
  operation, e.g. `"search"`, `"remove-member"`) and `message`. A call rejected
  locally before it is sent (a blank `content`, `query` or id) raises a plain
  `NovamemError` with `status_code` 0.

The client never retries on your behalf: reads fail fast so you can degrade in
one round trip, and `capture` — the only call where a lost request loses
information — is left for you to retry on your own schedule and budget.

Every call is bounded by the client's `timeout` (seconds, default 15, the
`DEFAULT_TIMEOUT` constant): it applies to the connect and to each socket read,
which is what the standard library offers, so a server that answers a byte at a
time can stretch a call beyond it. The bearer token never appears in an error
message or a `repr`, including when the server echoes it back.

## Operations

| Method                              | Route                                          | Notes                                                                                                                                                   |
| ----------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capture`                           | `POST /v1/capture`                             | Client. Durable write with semantic dedup, in-place update and supersession. A declined worthiness gate is not an error: check the result's `id`.       |
| `search`                            | `POST /v1/search`                              | Client. 5-signal hybrid retrieval (keyword + vector + graph + recency + entity). A degraded answer with no results raises `UnavailableError`.           |
| `recent`                            | `POST /v1/recent`                              | Client. Newest first. The request may be omitted. `since` is a `datetime` (or ISO-8601 string), sent as UTC.                                            |
| `today`                             | `POST /v1/recent`                              | Client. Recent with since = 24 hours ago.                                                                                                               |
| `neighbors`                         | `POST /v1/neighbors`                           | Client. Graph walk from a seed entry id.                                                                                                                |
| `update`                            | `PUT /v1/memories/{id}`                        | Client. Rewrite in place; keeps the id, hits and edges. Prefer it to forget + capture. `update(id, request)`.                                           |
| `forget`                            | `POST /v1/forget`                              | Client. Never reports success on a failed delete. An id outside your scope is `deleted=False` with no error.                                            |
| `remember`                          | `POST /v1/remember`                            | Client. Unconditional store: no worthiness gate, no dedup pass. For content a person explicitly asked to keep.                                          |
| `context`                           | `POST /v1/context`                             | Client. Relevant and recent entries for one message, in one round trip.                                                                                 |
| `session_recap`                     | `POST /v1/session-recap`                       | Client. End-of-session facts by category, saved as separate entries.                                                                                    |
| `context_prefix`                    | `GET /v1/context-prefix`                       | Client. Cacheable observation-log prefix. Not-found (`NotFoundError`) means the observer is disabled.                                                   |
| `stats`                             | `GET /v1/stats`                                | Client. Entry census by namespace and tier.                                                                                                             |
| `health`                            | `GET /health`                                  | Client. A boolean. A served `{"ok": false}`, including /health's own 503, is an answer, not an error.                                                   |
| `mint_token`                        | `POST /v1/me/tokens`                           | Management. Mint a bearer for the caller. The plaintext is returned once.                                                                               |
| `list_tokens`                       | `GET /v1/me/tokens`                            | Management. The caller's tokens (hashes and labels, never plaintext).                                                                                   |
| `revoke_token`                      | `DELETE /v1/me/tokens/{hash}`                  | Management. Revoke one of the caller's tokens by hash.                                                                                                  |
| `list_projects`                     | `GET /v1/me/projects`                          | Management. Projects the caller belongs to, with their role.                                                                                            |
| `create_project`                    | `POST /v1/me/projects`                         | Management. Create a project owned by the caller.                                                                                                       |
| `delete_project`                    | `DELETE /v1/me/projects/{id}`                  | Management. Delete a project and its entries.                                                                                                           |
| `list_project_members`              | `GET /v1/me/projects/{id}/members`             | Management. A project's members.                                                                                                                        |
| `add_project_member`                | `POST /v1/me/projects/{id}/members`            | Management. Add a user by their exact sign-in email; role is member or owner. `add_project_member(id, email, role=None)`.                               |
| `remove_project_member`             | `DELETE /v1/me/projects/{id}/members/{userId}` | Management. Remove a member by user id.                                                                                                                 |
| `remove_project_member_by_username` | `DELETE /v1/me/projects/{id}/members/{userId}` | Management. Look the member up by username, then remove them: two calls.                                                                                |
| `active_project`                    | `GET /v1/me/active-project`                    | Management. The caller's active project, if any.                                                                                                        |
| `set_active_project`                | `PUT /v1/me/active-project`                    | Management. Set the active project by id or name.                                                                                                       |
| `clear_active_project`              | `DELETE /v1/me/active-project`                 | Management. Clear the active project. Returns nothing (`None`).                                                                                         |
| `decay`                             | `POST /v1/decay`                               | Management. Run tier decay now.                                                                                                                         |
| `hygiene`                           | `POST /v1/hygiene`                             | Management. Duplicate, stale, low-value and contradiction candidates.                                                                                   |
| `evaluate`                          | `POST /v1/evaluate`                            | Management. Run a retrieval evaluation suite.                                                                                                           |
| `adoption`                          | `POST /v1/adoption`                            | Management. Diagnostics for an agent client's novamem setup.                                                                                            |
| `observe`                           | `POST /v1/observe`                             | Management. Run the observer. A disabled observer raises code `observer_disabled`, not unavailable.                                                     |
| `changes`                           | `GET /v1/me/changes`                           | Management. The change feed; `after_seq` pages. `since` is a string and is sent exactly as given — it is not converted to UTC, so pass a UTC timestamp. |
| `usage`                             | `GET /v1/me/usage`                             | Management. Entry count and quota.                                                                                                                      |
| `export`                            | `GET /v1/me/export`                            | Management. One page, oldest first; pass `next_after_id` back as `after_id` until a page is empty.                                                      |
| `import_`                           | `POST /v1/me/import`                           | Management. Store 1-200 entries unconditionally, deduplicated by content hash. An export page's entries fit as-is. (`import` is a Python keyword.)      |
| `provision_user`                    | `POST /v1/admin/users`                         | Admin. Create a user and mint their first token, for fleet orchestrators.                                                                               |
| `revoke_user_token`                 | `POST /v1/admin/tokens/revoke`                 | Admin. Revoke a bearer by presenting its plaintext.                                                                                                     |
| `list_users`                        | `GET /v1/admin/users`                          | Admin. Every user, with entry and token counts.                                                                                                         |
| `preview_delete_user`               | `DELETE /v1/admin/users/{id}?dryRun=true`      | Admin. What deleting the user would remove, without removing it.                                                                                        |
| `delete_user`                       | `DELETE /v1/admin/users/{id}`                  | Admin. Delete a user with their tokens, entries and owned projects.                                                                                     |
| `set_user_quota`                    | `PUT /v1/admin/users/{id}/quota`               | Admin. Set quota overrides; `None` (the default) clears an override.                                                                                    |

Project and token administration are deliberately not on `Client` — an agent
process holding a client cannot perform them by accident. They live on two
separate, explicitly constructed classes that take the same `(base_url, token,
*, timeout=...)` arguments and share the same error contract: `Management`
(the caller's own `/v1/me/*` surface and the maintenance endpoints) and
`Admin` (server administration with an admin user's bearer). Keep the admin
bearer on the orchestrator side only; it must never reach an agent's context.

## Forget

Forgetting is a promise to a person, so the client will not round a failure up
to "done":

- any transport failure, 5xx, empty or unparseable body raises
  `UnavailableError`, never a `ForgetResult` claiming `deleted=True`;
- an id that is not in your scope returns `ForgetResult(deleted=False)` with
  **no** exception — the truthful "there was nothing of yours there to delete";
- `cold_delete_ok=False` is passed through untouched. The primary row is gone
  but the vector copy survived and the server has queued it for its reaper; the
  content is still retrievable, so nobody has yet earned the word "forgotten".

## Development

```bash
cd clients/python
PYTHONPATH=src:tests python -m unittest discover -s tests -v
```

The scenario suite runs against the shared scenario server
(`clients/contract/scenario-server.sh`, built with Go), so `go` must be on
`PATH`. It never touches a real novamem.
