# novamem — C and C++ client

A C ABI (`include/novamem.h`) and a header-only C++17 wrapper (`include/novamem.hpp`) over the [Rust SDK](../rust), for [novamem](https://github.com/azrtydxb/novamem), a tiered memory service for agents. Every behaviour below is the Rust SDK's; this layer only converts across the boundary.

Prebuilt archives are attached to each `clients/c/v<version>` GitHub release, one per Linux triplet: `novamem-c-<version>-linux-x86_64.tar.gz` and `novamem-c-<version>-linux-aarch64.tar.gz`. Each holds `include/` (both headers) and `lib/` (`libnovamem_ffi.a` and `libnovamem_ffi.so`):

```sh
v=0.1.0
curl -LO "https://github.com/azrtydxb/novamem/releases/download/clients%2Fc%2Fv$v/novamem-c-$v-linux-x86_64.tar.gz"
tar xzf "novamem-c-$v-linux-x86_64.tar.gz"
cc -std=c11 app.c -Inovamem-c-$v-linux-x86_64/include \
    novamem-c-$v-linux-x86_64/lib/libnovamem_ffi.a -lpthread -ldl -lm -o app
```

A vcpkg port and a Conan recipe that install those archives live in [`port/`](port). The release workflow pins each release's SHA-512s into them by opening a PR (`port/pin.sh`); until that PR is merged the recipes say `unpinned` and refuse to install. They are not in the central vcpkg or ConanCenter indexes: submitting them there is a manual upstream PR. Until then, use them from this repository:

```sh
vcpkg install novamem --overlay-ports=clients/c/port/vcpkg
conan create clients/c/port/conan
```

To build from source (needs Rust 1.80+ and the repository's Cargo workspace):

```sh
make -C clients/c lib   # target/release/libnovamem_ffi.a, at the repository root
```

`make lib` also compiles in the test-only entry point `novamem_test_call_by_name`, which the header declares only under `NOVAMEM_TEST_DISPATCH`; the release archives are built without it (`cargo build --release --locked -p novamem-ffi`).

Requires a C11 or C++17 compiler. Prebuilt archives exist for Linux x86_64 and aarch64 only, and CI builds and tests on Linux only; the Makefile also links on macOS from source. Needs the Go novamem server (the first release after v1.1.7) — every route in `clients/contract/routes.json`.

**Threads and blocking.** Every function blocks the calling thread until the answer arrives or the call's timeout expires. The library runs one process-wide Tokio runtime (two worker threads, started on first use) to drive the requests. A handle is safe to use from several threads at once — the operations take a `const` handle and the Rust value behind it is `Send + Sync` — but must not be freed while another thread is using it.

**Ownership.**

- A handle from `novamem_client_new` / `novamem_management_new` / `novamem_admin_new` is freed with `novamem_client_free` / `novamem_management_free` / `novamem_admin_free`.
- Every result a call writes to its `out` parameter is owned by the caller and freed with the matching `novamem_<type>_free` (`novamem_search_result_free`, `novamem_capture_result_free`, …), which frees everything inside it. Call it on the top-level pointer only — never on an element of a returned array (`results[i]`), which belongs to its parent.
- Request structs are only read, never freed or kept by the library: zero-initialise one, point its strings at your own memory, and keep it until the call returns. Do not pass one you built to a `*_free` function.
- Every `*_free` and `novamem_string_free` accept NULL. `novamem_client_health` writes a plain `bool`, and `novamem_management_clear_active_project` writes nothing.
- On `NOVAMEM_ERR` nothing is allocated and `*out` is left untouched, so initialise it to NULL and free unconditionally. A NULL `out` is rejected before the request is sent.
- `novamem_error` is a fixed-size struct on your side (strings truncated to fit, always NUL-terminated); it needs no freeing.
- Strings are UTF-8 and NULL means absent. An optional number or boolean has a `has_<field>` flag; operations take optional numbers by pointer (NULL = not given). JSON-valued fields (`metadata`, `by_namespace`, …) hold JSON text. An enum string the SDK does not know, or JSON text that does not parse, is dropped rather than sent.

## Quickstart

```c
#include <stdio.h>
#include <stdlib.h>

#include "novamem.h"

int main(void) {
    const char *url = getenv("NOVAMEM_URL"), *token = getenv("NOVAMEM_TOKEN"); /* user bearer nm_… */
    novamem_error err = {0};
    novamem_client *c = novamem_client_new(url ? url : "", token ? token : "", 0, &err);
    if (!c) {
        fprintf(stderr, "config: %s\n", err.message);
        return 1;
    }

    novamem_capture_request cap_req = {0};
    cap_req.content = "User prefers dark roast";
    novamem_capture_result *cap = NULL;
    if (novamem_client_capture(c, &cap_req, &cap, &err) != NOVAMEM_OK) {
        fprintf(stderr, "%s: %s\n", err.op, err.message);
        novamem_client_free(c);
        return 1;
    }
    printf("saved as %s\n", cap->id ? cap->id : "(declined by the worthiness gate)");
    novamem_capture_result_free(cap);

    novamem_search_request req = {0};
    req.query = "coffee preference";
    req.has_k = true;
    req.k = 5;
    novamem_search_result *hits = NULL;
    novamem_status st = novamem_client_search(c, &req, &hits, &err);
    if (st == NOVAMEM_OK) {
        for (size_t i = 0; i < hits->results_len; i++)
            printf("%s %s\n", hits->results[i].id, hits->results[i].content);
    } else {
        fprintf(stderr, "%s: %s\n", err.op, err.message);
    }
    novamem_search_result_free(hits);
    novamem_client_free(c);
    return st == NOVAMEM_OK ? 0 : 1;
}
```

Link it as shown under the install instructions. A `nm_…` bearer carries every right the owning user has — the user's whole memory plus every project they are a member of. Mint one from the dashboard's API Tokens page. Configuration is injected: the library reads no environment variables, so one process can hold several handles. `timeout_ms` bounds every call (0 means 15 000). A constructor returns NULL on a base URL that is not absolute `http(s)` or on a blank token, with `err` naming the field and never quoting the value.

The C++ wrapper gives RAII handles (`novamem::Client`, `novamem::Management`, `novamem::Admin`), returns results as `std::unique_ptr`s that free themselves, and throws `novamem::Error`:

```cpp
#include <cstdlib>
#include <iostream>

#include "novamem.hpp"

int main() {
    const char *url = std::getenv("NOVAMEM_URL"), *token = std::getenv("NOVAMEM_TOKEN");
    try {
        novamem::Client c(url ? url : "", token ? token : "");

        novamem_capture_request cap{};
        cap.content = "User prefers dark roast";
        auto saved = c.capture(cap);

        novamem_search_request req{};
        req.query = "coffee preference";
        auto hits = c.search(req);
        for (size_t i = 0; i < hits->results_len; i++)
            std::cout << hits->results[i].content << "\n";
    } catch (const novamem::Error &e) {
        std::cerr << e.what() << (e.unavailable ? " (could not reach the store)" : "") << "\n";
        return 1;
    }
    return 0;
}
```

## The error contract

The client insists you can tell **"there is nothing stored about that"** apart from **"I could not reach the store"**. Conflating the two is how an agent ends up saying _"I have no record of that"_ when the truth is that a pod was restarting.

Every operation returns a `novamem_status` (`NOVAMEM_OK` or `NOVAMEM_ERR`) and, on error, fills the caller's `novamem_error`:

```c
novamem_search_result *res = NULL;
if (novamem_client_search(c, &req, &res, &err) != NOVAMEM_OK) {
    if (err.unavailable) {
        /* Could not look. Say so; do not claim ignorance. */
    } else {
        /* A real answer that was not success: bad token, bad request, 404. */
    }
} else if (res->results_len == 0) {
    /* Nothing is stored about that. This one is knowledge. */
}
novamem_search_result_free(res);
```

- `err.unavailable` — the store could not be consulted: refused dial, DNS failure, timeout, 5xx, 429, an empty body, or a body that is not the JSON the API promises. Also set when `search`, `recent` or `neighbors` get `200 {results: [], degraded: true}`, which is an outage in the costume of an empty result set.
- `err.retryable` — worth calling again: transport failures, timeouts, 5xx, 429 and the degraded-empty answer. Never set for 401/403/400, which are configuration problems that no retry fixes, nor for a malformed body.
- `err.not_found` — the id is not in your scope (status 404).
- `err.status_code` (0 when no response arrived), `err.code` (the server's machine-readable code, or empty), `err.op` (the operation that failed: `"search"`, `"remove-member"`, …) and `err.message`. Local failures — a NULL handle or `out`, a missing required argument — have status 0 and neither flag set.
- `err.canceled` is reserved: the C API has no cancellation, and this version never sets it.

In C++ the same fields are members of `novamem::Error` (`unavailable`, `retryable`, `not_found`, `status_code`, `code`, `op`, `message`), and `what()` renders them.

The client never retries on your behalf: reads fail fast so you can degrade in one round trip, and `capture` — the only call where a lost request loses information — is left for you to retry on your own schedule and budget.

Every call is bounded by the handle's timeout (default 15 s). Responses larger than 8 MiB are refused as unavailable. The bearer token never appears in an error, including when the server echoes it back.

## Operations

| Method                                                 | Route                                          | Notes                                                                                                                                                                            |
| ------------------------------------------------------ | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `novamem_client_capture`                               | `POST /v1/capture`                             | **Client.** Durable write with semantic dedup, in-place update and supersession. A declined worthiness gate is not an error: check the result's `id` (NULL when not saved).      |
| `novamem_client_search`                                | `POST /v1/search`                              | **Client.** 5-signal hybrid retrieval (keyword + vector + graph + recency + entity). A degraded answer with no results raises unavailable: `NOVAMEM_ERR` with `err.unavailable`. |
| `novamem_client_recent`                                | `POST /v1/recent`                              | **Client.** Newest first. The request may be omitted. Pass NULL for the request.                                                                                                 |
| `novamem_client_today`                                 | `POST /v1/recent`                              | **Client.** Recent with since = 24 hours ago. Any `since` you set is overwritten; the request may be NULL.                                                                       |
| `novamem_client_neighbors`                             | `POST /v1/neighbors`                           | **Client.** Graph walk from a seed entry id.                                                                                                                                     |
| `novamem_client_update`                                | `PUT /v1/memories/{id}`                        | **Client.** Rewrite in place; keeps the id, hits and edges. Prefer it to forget + capture. The id is its own argument.                                                           |
| `novamem_client_forget`                                | `POST /v1/forget`                              | **Client.** Never reports success on a failed delete. An id outside your scope is deleted = false with no error.                                                                 |
| `novamem_client_remember`                              | `POST /v1/remember`                            | **Client.** Unconditional store: no worthiness gate, no dedup pass. For content a person explicitly asked to keep.                                                               |
| `novamem_client_context`                               | `POST /v1/context`                             | **Client.** Relevant and recent entries for one message, in one round trip.                                                                                                      |
| `novamem_client_session_recap`                         | `POST /v1/session-recap`                       | **Client.** End-of-session facts by category, saved as separate entries.                                                                                                         |
| `novamem_client_context_prefix`                        | `GET /v1/context-prefix`                       | **Client.** Cacheable observation-log prefix. Not-found means the observer is disabled. `project` may be NULL; test `err.not_found`.                                             |
| `novamem_client_stats`                                 | `GET /v1/stats`                                | **Client.** Entry census by namespace and tier.                                                                                                                                  |
| `novamem_client_health`                                | `GET /health`                                  | **Client.** A boolean. A served {"ok": false}, including /health's own 503, is an answer, not an error. Writes a `bool`; nothing to free.                                        |
| `novamem_management_mint_token`                        | `POST /v1/me/tokens`                           | **Management.** Mint a bearer for the caller. The plaintext is returned once.                                                                                                    |
| `novamem_management_list_tokens`                       | `GET /v1/me/tokens`                            | **Management.** The caller's tokens (hashes and labels, never plaintext).                                                                                                        |
| `novamem_management_revoke_token`                      | `DELETE /v1/me/tokens/{hash}`                  | **Management.** Revoke one of the caller's tokens by hash.                                                                                                                       |
| `novamem_management_list_projects`                     | `GET /v1/me/projects`                          | **Management.** Projects the caller belongs to, with their role.                                                                                                                 |
| `novamem_management_create_project`                    | `POST /v1/me/projects`                         | **Management.** Create a project owned by the caller.                                                                                                                            |
| `novamem_management_delete_project`                    | `DELETE /v1/me/projects/{id}`                  | **Management.** Delete a project and its entries.                                                                                                                                |
| `novamem_management_list_project_members`              | `GET /v1/me/projects/{id}/members`             | **Management.** A project's members.                                                                                                                                             |
| `novamem_management_add_project_member`                | `POST /v1/me/projects/{id}/members`            | **Management.** Add a user by their exact sign-in email; role is member or owner.                                                                                                |
| `novamem_management_remove_project_member`             | `DELETE /v1/me/projects/{id}/members/{userId}` | **Management.** Remove a member by user id.                                                                                                                                      |
| `novamem_management_remove_project_member_by_username` | `DELETE /v1/me/projects/{id}/members/{userId}` | **Management.** Look the member up by username, then remove them: two calls. An unknown username is an error with status 0.                                                      |
| `novamem_management_active_project`                    | `GET /v1/me/active-project`                    | **Management.** The caller's active project, if any.                                                                                                                             |
| `novamem_management_set_active_project`                | `PUT /v1/me/active-project`                    | **Management.** Set the active project by id or name.                                                                                                                            |
| `novamem_management_clear_active_project`              | `DELETE /v1/me/active-project`                 | **Management.** Clear the active project. Returns nothing: the function takes no out-parameter.                                                                                  |
| `novamem_management_decay`                             | `POST /v1/decay`                               | **Management.** Run tier decay now.                                                                                                                                              |
| `novamem_management_hygiene`                           | `POST /v1/hygiene`                             | **Management.** Duplicate, stale, low-value and contradiction candidates.                                                                                                        |
| `novamem_management_evaluate`                          | `POST /v1/evaluate`                            | **Management.** Run a retrieval evaluation suite.                                                                                                                                |
| `novamem_management_adoption`                          | `POST /v1/adoption`                            | **Management.** Diagnostics for an agent client's novamem setup.                                                                                                                 |
| `novamem_management_observe`                           | `POST /v1/observe`                             | **Management.** Run the observer. A disabled observer raises code observer_disabled, not unavailable.                                                                            |
| `novamem_management_changes`                           | `GET /v1/me/changes`                           | **Management.** The change feed; `since` is an RFC 3339 string passed through as given, `after_seq` pages. Optional numbers by pointer.                                          |
| `novamem_management_usage`                             | `GET /v1/me/usage`                             | **Management.** Entry count and quota.                                                                                                                                           |
| `novamem_management_export`                            | `GET /v1/me/export`                            | **Management.** One page, oldest first; pass `next_after_id` back as `after_id` until a page is empty.                                                                           |
| `novamem_management_import`                            | `POST /v1/me/import`                           | **Management.** Store 1-200 entries unconditionally, deduplicated by content hash. An export page's entries fit as-is. Takes the entries as JSON array text (`entries_json`).    |
| `novamem_admin_provision_user`                         | `POST /v1/admin/users`                         | **Admin.** Create a user and mint their first token, for fleet orchestrators.                                                                                                    |
| `novamem_admin_revoke_user_token`                      | `POST /v1/admin/tokens/revoke`                 | **Admin.** Revoke a bearer by presenting its plaintext.                                                                                                                          |
| `novamem_admin_list_users`                             | `GET /v1/admin/users`                          | **Admin.** Every user, with entry and token counts.                                                                                                                              |
| `novamem_admin_preview_delete_user`                    | `DELETE /v1/admin/users/{id}?dryRun=true`      | **Admin.** What deleting the user would remove, without removing it.                                                                                                             |
| `novamem_admin_delete_user`                            | `DELETE /v1/admin/users/{id}`                  | **Admin.** Delete a user with their tokens, entries and owned projects.                                                                                                          |
| `novamem_admin_set_user_quota`                         | `PUT /v1/admin/users/{id}/quota`               | **Admin.** Set quota overrides; a NULL pointer clears an override (sent as JSON null).                                                                                           |

Project, token and user administration are deliberately not on `novamem_client` — an agent process holding a client handle should not be able to perform them by accident. They live on two separate, explicitly constructed handle types sharing the same error contract: `novamem_management_new` for the caller's own `/v1/me/*` surface and maintenance, and `novamem_admin_new` for server administration with an admin bearer. Keep the admin bearer on the orchestrator side only; it must never reach an agent's context.

## Forget

Forgetting is a promise to a person, so the client will not round a failure up to "done":

- any transport failure, 5xx or unparseable body is `NOVAMEM_ERR`, never a zeroed "deleted";
- an id that is not in your scope is `NOVAMEM_OK` with `deleted == false` — the truthful "there was nothing of yours there to delete";
- `has_cold_delete_ok && !cold_delete_ok` is passed through untouched. The primary row is gone but the vector copy survived and the server has queued it for its reaper; the content is still retrievable, so nobody has yet earned the word "forgotten".

## Development

```sh
make -C clients/c test       # C11 and C++17 scenario runners, the NULL-out check, the route check
make -C clients/c memcheck   # the C runner under valgrind (Linux)
```

Both run the shared scenario suite against the scenario server in `clients/contract` (built with `go`, so Go must be on `PATH`) and never touch a real novamem; `make test` needs `python3`. `sh clients/c/check-readme.sh` compiles this README's C and C++ examples.
