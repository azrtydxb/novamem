# novamem — Rust client

Rust client for [novamem](https://github.com/azrtydxb/novamem), a tiered memory service for agents. Async (tokio), rustls, MSRV 1.80.

```bash
cargo add novamem
cargo add tokio --features macros,rt-multi-thread
```

Requires Rust 1.80 or newer (the MSRV, tested in CI alongside the current stable) and a Tokio runtime: every call is an `async fn` that must run inside one, since both the HTTP client and the per-call timeout use it. Needs the Go novamem server (the first release after v1.1.7) — every route in `clients/contract/routes.json`.

`Client`, `Management` and `Admin` are `Clone + Send + Sync`. Build one and share it across tasks and threads, or clone it; clones share one connection pool. Calls take `&self`, so concurrent calls on one value are fine.

## Quickstart

```rust
use novamem::types::{CaptureRequest, SearchRequest};
use novamem::{Client, Config};

#[tokio::main]
async fn main() -> Result<(), novamem::Error> {
    let c = Client::new(Config {
        base_url: std::env::var("NOVAMEM_URL").unwrap_or_default(),
        token: std::env::var("NOVAMEM_TOKEN").unwrap_or_default(), // user bearer `nm_…`
        ..Config::default()
    })?;

    let saved = c
        .capture(CaptureRequest {
            content: "User prefers dark roast".into(),
            ..Default::default()
        })
        .await?;
    println!("saved as {:?}", saved.id);

    let hits = c
        .search(SearchRequest {
            query: "coffee preference".into(),
            k: Some(5),
            ..Default::default()
        })
        .await?;
    for e in &hits.results {
        println!("{} {}", e.id, e.content);
    }
    Ok(())
}
```

A `nm_…` bearer carries every right the owning user has — the user's whole memory plus every project they are a member of. Mint one from the dashboard's API Tokens page. Configuration is injected: the crate reads no environment variables and holds no global state, so one process can hold several clients. `Client::new` fails on a base URL that is not absolute `http(s)` or on a blank token, naming the field and never quoting the value. `Config::http` accepts your own `reqwest::Client` (a custom root store, say).

## The error contract

The client insists you can tell **"there is nothing stored about that"** apart from **"I could not reach the store"**. Conflating the two is how an agent ends up saying _"I have no record of that"_ when the truth is that a pod was restarting.

Every call returns `Result<_, novamem::Error>`:

```rust
match c.search(SearchRequest { query: q.into(), ..Default::default() }).await {
    Err(e) if e.is_unavailable() => {
        // Could not look. Say so; do not claim ignorance.
    }
    Err(e) => {
        // A real answer that was not success: bad token, bad request, 404.
        eprintln!("{} failed: {} [{}] {}", e.op(), e.status(), e.code(), e.message());
    }
    Ok(r) if r.results.is_empty() => {
        // Nothing is stored about that. This one is knowledge.
    }
    Ok(r) => { /* use r.results */ }
}
```

- `e.is_unavailable()` — the store could not be consulted: refused dial, DNS failure, timeout, 5xx, 429, an empty body, or a body that is not the JSON the API promises. Also true when `search`, `recent` or `neighbors` get `200 {results: [], degraded: true}`, which is an outage in the costume of an empty result set.
- `e.is_retryable()` — worth calling again: transport failures, timeouts, 5xx, 429 and the degraded-empty answer. Never true for 401/403/400, which are configuration problems that no retry fixes, nor for a malformed body, which parses the same way next time.
- `e.is_not_found()` — the id is not in your scope (status 404).
- `e.status()` (0 when no response arrived), `e.code()` (the server's machine-readable code, or empty), `e.op()` (the method that failed: `"search"`, `"remove-member"`, …) and `e.message()`. `Display` renders all of them as `novamem <op>: <status> [<code>]: <message>`.

The client never retries on your behalf: reads fail fast so you can degrade in one round trip, and `capture` — the only call where a lost request loses information — is left for you to retry on your own schedule and budget.

Every call is bounded by `Config::timeout` (default `DEFAULT_TIMEOUT`, 15 s) even when the caller sets no deadline of its own; dropping the future cancels the request. Responses larger than 8 MiB are refused as unavailable. The bearer token never appears in an error or in `Debug` output, including when the server echoes it back.

## Operations

Request and result types live in `novamem::types`. Methods that take a request struct take it by value; build it with `..Default::default()`.

| Method                              | Route                                          | Notes                                                                                                                                                                        |
| ----------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capture`                           | `POST /v1/capture`                             | **Client.** Durable write with semantic dedup, in-place update and supersession. A declined worthiness gate is not an error: check the result's id (`Option<String>`).       |
| `search`                            | `POST /v1/search`                              | **Client.** 5-signal hybrid retrieval (keyword + vector + graph + recency + entity). A degraded answer with no results raises unavailable: an `Err` with `is_unavailable()`. |
| `recent`                            | `POST /v1/recent`                              | **Client.** Newest first. Every request field is optional; `RecentRequest::default()` stands in for an omitted request.                                                      |
| `today`                             | `POST /v1/recent`                              | **Client.** Recent with since = 24 hours ago. Any `since` you set is overwritten.                                                                                            |
| `neighbors`                         | `POST /v1/neighbors`                           | **Client.** Graph walk from a seed entry id.                                                                                                                                 |
| `update`                            | `PUT /v1/memories/{id}`                        | **Client.** Rewrite in place; keeps the id, hits and edges. Prefer it to forget + capture. `update(id, UpdateRequest)`.                                                      |
| `forget`                            | `POST /v1/forget`                              | **Client.** Never reports success on a failed delete. An id outside your scope is deleted = false with no error.                                                             |
| `remember`                          | `POST /v1/remember`                            | **Client.** Unconditional store: no worthiness gate, no dedup pass. For content a person explicitly asked to keep.                                                           |
| `context`                           | `POST /v1/context`                             | **Client.** Relevant and recent entries for one message, in one round trip.                                                                                                  |
| `session_recap`                     | `POST /v1/session-recap`                       | **Client.** End-of-session facts by category, saved as separate entries.                                                                                                     |
| `context_prefix`                    | `GET /v1/context-prefix`                       | **Client.** Cacheable observation-log prefix. Not-found means the observer is disabled. `project: Option<&str>`; test with `is_not_found()`.                                 |
| `stats`                             | `GET /v1/stats`                                | **Client.** Entry census by namespace and tier.                                                                                                                              |
| `health`                            | `GET /health`                                  | **Client.** A boolean. A served {"ok": false}, including /health's own 503, is an answer, not an error. Returns `Result<bool, Error>`.                                       |
| `mint_token`                        | `POST /v1/me/tokens`                           | **Management.** Mint a bearer for the caller. The plaintext is returned once.                                                                                                |
| `list_tokens`                       | `GET /v1/me/tokens`                            | **Management.** The caller's tokens (hashes and labels, never plaintext).                                                                                                    |
| `revoke_token`                      | `DELETE /v1/me/tokens/{hash}`                  | **Management.** Revoke one of the caller's tokens by hash.                                                                                                                   |
| `list_projects`                     | `GET /v1/me/projects`                          | **Management.** Projects the caller belongs to, with their role.                                                                                                             |
| `create_project`                    | `POST /v1/me/projects`                         | **Management.** Create a project owned by the caller.                                                                                                                        |
| `delete_project`                    | `DELETE /v1/me/projects/{id}`                  | **Management.** Delete a project and its entries.                                                                                                                            |
| `list_project_members`              | `GET /v1/me/projects/{id}/members`             | **Management.** A project's members.                                                                                                                                         |
| `add_project_member`                | `POST /v1/me/projects/{id}/members`            | **Management.** Add a user by their exact sign-in email; role is member or owner.                                                                                            |
| `remove_project_member`             | `DELETE /v1/me/projects/{id}/members/{userId}` | **Management.** Remove a member by user id.                                                                                                                                  |
| `remove_project_member_by_username` | `DELETE /v1/me/projects/{id}/members/{userId}` | **Management.** Look the member up by username, then remove them: two calls. An unknown username is an error with status 0.                                                  |
| `active_project`                    | `GET /v1/me/active-project`                    | **Management.** The caller's active project, if any.                                                                                                                         |
| `set_active_project`                | `PUT /v1/me/active-project`                    | **Management.** Set the active project by id or name.                                                                                                                        |
| `clear_active_project`              | `DELETE /v1/me/active-project`                 | **Management.** Clear the active project. Returns nothing (`Result<(), Error>`).                                                                                             |
| `decay`                             | `POST /v1/decay`                               | **Management.** Run tier decay now.                                                                                                                                          |
| `hygiene`                           | `POST /v1/hygiene`                             | **Management.** Duplicate, stale, low-value and contradiction candidates.                                                                                                    |
| `evaluate`                          | `POST /v1/evaluate`                            | **Management.** Run a retrieval evaluation suite.                                                                                                                            |
| `adoption`                          | `POST /v1/adoption`                            | **Management.** Diagnostics for an agent client's novamem setup.                                                                                                             |
| `observe`                           | `POST /v1/observe`                             | **Management.** Run the observer. A disabled observer raises code observer_disabled, not unavailable.                                                                        |
| `changes`                           | `GET /v1/me/changes`                           | **Management.** The change feed; `since` is an RFC 3339 string passed through as given, `after_seq` pages.                                                                   |
| `usage`                             | `GET /v1/me/usage`                             | **Management.** Entry count and quota.                                                                                                                                       |
| `export`                            | `GET /v1/me/export`                            | **Management.** One page, oldest first; pass `next_after_id` back as `after_id` until a page is empty.                                                                       |
| `import`                            | `POST /v1/me/import`                           | **Management.** Store 1-200 entries unconditionally, deduplicated by content hash. An export page's entries fit as-is. Takes `Vec<serde_json::Value>`.                       |
| `provision_user`                    | `POST /v1/admin/users`                         | **Admin.** Create a user and mint their first token, for fleet orchestrators.                                                                                                |
| `revoke_user_token`                 | `POST /v1/admin/tokens/revoke`                 | **Admin.** Revoke a bearer by presenting its plaintext.                                                                                                                      |
| `list_users`                        | `GET /v1/admin/users`                          | **Admin.** Every user, with entry and token counts.                                                                                                                          |
| `preview_delete_user`               | `DELETE /v1/admin/users/{id}?dryRun=true`      | **Admin.** What deleting the user would remove, without removing it.                                                                                                         |
| `delete_user`                       | `DELETE /v1/admin/users/{id}`                  | **Admin.** Delete a user with their tokens, entries and owned projects.                                                                                                      |
| `set_user_quota`                    | `PUT /v1/admin/users/{id}/quota`               | **Admin.** Set quota overrides; `None` clears an override (sent as JSON null).                                                                                               |

Project, token and user administration are deliberately not on `Client` — an agent process holding a client should not be able to perform them by accident. They live on two separate, explicitly constructed types sharing the same `Config` and error contract: `Management::new(cfg)` for the caller's own `/v1/me/*` surface and maintenance, and `Admin::new(cfg)` for server administration with an admin bearer. Keep the admin bearer on the orchestrator side only; it must never reach an agent's context.

## Forget

Forgetting is a promise to a person, so the client will not round a failure up to "done":

- any transport failure, 5xx or unparseable body is an **`Err`**, never a default "deleted";
- an id that is not in your scope is `Ok(ForgetResult { deleted: false, .. })` with **no** error — the truthful "there was nothing of yours there to delete";
- `cold_delete_ok: Some(false)` is passed through untouched. The primary row is gone but the vector copy survived and the server has queued it for its reaper; the content is still retrievable, so nobody has yet earned the word "forgotten".

## Development

```bash
cd clients/rust
cargo test --locked
```

That is the shared scenario suite, as CI runs it on Rust 1.80 and on stable (CI also runs `cargo clippy --locked --all-targets -- -D warnings`). The suite drives the shared scenario server in `clients/contract` (built with `go`, so Go must be on `PATH`) and never touches a real novamem. `sh check-readme.sh` compiles this README's Quickstart.
