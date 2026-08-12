# novamem — Go client

Go client for [novamem](https://github.com/azrtydxb/novamem), a tiered memory service with 5-signal hybrid retrieval (keyword + vector + graph + recency + entity), per-user isolation, project (sub-brain) scoping, sensitivity auto-detection, content-hash dedup, and async background enrichment. It targets the same HTTP API as the TypeScript client in `packages/client`, and is a standalone Go module so it can be imported without pulling in the server.

```bash
go get github.com/azrtydxb/novamem/clients/go
```

```go
import novamem "github.com/azrtydxb/novamem/clients/go"
```

## Quickstart

```go
c, err := novamem.New(novamem.Config{
    BaseURL: "http://localhost:7778",
    Token:   os.Getenv("NOVAMEM_TOKEN"), // user bearer `nm_…`
})
if err != nil {
    return err
}

if _, err := c.Capture(ctx, novamem.CaptureRequest{
    Content: "User prefers dark roast",
}); err != nil {
    return err
}

hits, err := c.Search(ctx, novamem.SearchRequest{Query: "coffee preference", K: 5})
```

A `nm_…` bearer carries every right the owning user has — the user's whole
memory plus every project they are a member of. Mint one from the dashboard's
API Tokens page. Configuration is injected: the package reads no environment
variables and holds no global state, so one process can hold several clients.

## The error contract

The client insists you can tell **"there is nothing stored about that"** apart
from **"I could not reach the store"**. Conflating the two is how an agent ends
up saying *"I have no record of that"* when the truth is that a pod was
restarting.

```go
res, err := c.Search(ctx, novamem.SearchRequest{Query: q})
switch {
case novamem.Unavailable(err):
    // Could not look. Say so; do not claim ignorance.
case err != nil:
    // A real answer that was not success: bad token, bad request, 404.
case len(res.Entries) == 0:
    // Nothing is stored about that. This one is knowledge.
}
```

- `novamem.Unavailable(err)` — the store could not be consulted: refused dial,
  DNS failure, timeout, 5xx, 429, or a body that is not the JSON the API
  promises. Also true when the server answers `200 {results: [], degraded:
  true}`, which is an outage in the costume of an empty result set.
- `novamem.Retryable(err)` — worth calling again. Never true for 401/403/400,
  which are configuration problems that no retry fixes.
- `errors.Is(err, novamem.ErrNotFound)` — the id is not in your scope.
- `errors.As(err, &e)` for `*novamem.Error` gives `StatusCode`, `Code`, `Op`.

The client never retries on your behalf: reads fail fast so you can degrade in
one round trip, and `Capture` — the only call where a lost request loses
information — is left for you to retry on your own schedule and budget.

Every call takes a `context.Context` and is bounded even if that context has no
deadline (`Config.Timeout`, default 15s). The bearer token never appears in an
error message, including when the server echoes it back.

## Operations

| Method | Route | Notes |
|---|---|---|
| `Capture(ctx, CaptureRequest)` | `POST /v1/capture` | Durable write with semantic dedupe, in-place update, and supersession. Check `result.Saved()` — the worthiness gate declining is not an error. |
| `Search(ctx, SearchRequest)` | `POST /v1/search` | 5-signal hybrid retrieval (keyword + vector + graph + recency + entity). |
| `Recent(ctx, RecentRequest)` | `POST /v1/recent` | Newest first; `Since` is a `time.Time`, formatted for you. |
| `Neighbors(ctx, NeighborsRequest)` | `POST /v1/neighbors` | Graph walk from a seed entry id. |
| `Update(ctx, UpdateRequest)` | `PUT /v1/memories/:id` | Rewrite in place; preserves id, hits and edges. Prefer it to forget+capture. |
| `Forget(ctx, ForgetRequest)` | `POST /v1/forget` | Never reports success on a failed delete. See below. |

Project and token administration are deliberately not exposed — those are
operator actions, and an agent process holding a client should not be able to
perform them by accident. Use the TypeScript client or the dashboard.

## Scoping

Every entry is either user-wide or belongs to a **project** (sub-brain), whose
members can all read and delete its entries.

```go
c.Capture(ctx, novamem.CaptureRequest{Content: "phoenix sprint plan", Project: "Phoenix"})
c.Search(ctx, novamem.SearchRequest{Query: "sprint", Project: "Phoenix"})

// Union the user-wide store with several projects in one read:
c.Search(ctx, novamem.SearchRequest{
    Query:           "sprint",
    IncludeProjects: []string{"Phoenix", "Atlas"},
})
```

`Project` accepts an id or a human name. Leave it empty for user-wide; empty
optional fields are omitted from the request body rather than sent as `""`,
which the server would reject.

Namespaces are shelves, not security. With neither `Namespace` nor
`IncludeNamespaces` set, reads span every namespace you have entries in — so
omitting them is the right default, not a narrowing.

## Forget

Forgetting is a promise to a person, so the client will not round a failure up
to "done":

- any transport failure, 5xx or unparseable body is an **error**, never a
  zero-valued "deleted";
- an id that is not in your scope is `Deleted: false` with **no** error — the
  truthful "there was nothing of yours there to delete";
- `ColdDeleteOk: false` is passed through untouched. The primary row is gone
  but the vector copy survived and the server has queued it for its reaper; the
  content is still retrievable, so nobody has yet earned the word "forgotten".

## Development

```bash
cd clients/go
go build ./... && go test ./... -count=1 && go vet ./...
```

Tests run entirely against `httptest` servers and never touch a real NovaMem.
