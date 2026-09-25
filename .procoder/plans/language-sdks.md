# language-sdks — implementation plan

Status: complete
Spec: .procoder/specs/language-sdks.md

## Goal

Ship nine novamem SDKs (Python, TypeScript, .NET, Java, Rust, C/C++, Ruby, PHP, Swift) that all behave exactly like `clients/go`. Shared artifacts enforce that mechanically: a scenario suite, a route map and generated types.

## Architecture

`clients/contract` holds the language-neutral truth: `routes.json` (every API route, and the SDK methods that cover it), `scenarios.json` (scripted server responses plus the outcome every SDK must report), and a Go scenario server that replays them over HTTP. `clients/gen` reads `docs/api/openapi.json` and `routes.json` and writes each language's wire types and its scenario dispatch table. Each SDK in `clients/<lang>` hand-writes only its transport, error classification and 41 thin methods. One CI workflow (`.github/workflows/sdk.yml`) runs every SDK against the scenario server, then against a real server built from the PR.

## Constraints

Every task inherits all of these. They are copied from the spec.

- Runtime floors: Python 3.10, Node 20, .NET 8, Java 17, Rust 1.80 (MSRV), Ruby 3.2, PHP 8.2, Swift 5.9 (declared platforms macOS 13 / iOS 16 / Linux), C11, C++17.
- Dependencies: standard library only, except these, and no others:
  - Java: `com.fasterxml.jackson.core:jackson-databind`.
  - Rust: `reqwest` (default-features off, features `rustls-tls` and `json`), `serde` (feature `derive`), `serde_json`, `tokio` (features `rt-multi-thread` and `time`), `thiserror`.
  - C/C++: the bundled Rust static library; cbindgen is build-time only.
  - PHP: `ext-curl` and `ext-json`.
  - Swift on Linux: `FoundationNetworking`.
  - Test-only exceptions: PHPUnit (PHP), xUnit (.NET), JUnit 5 (Java). Every other test runner is the language's built-in one.
- Configuration is injected: base URL, token, timeout (default 15 s), and an optional HTTP client. SDK code never reads environment variables; only test and smoke programs do.
- Construction fails immediately on a blank token, or on a base URL that isn't an absolute http(s) URL. The error names the field and never quotes the value.
- The token appears only in the `Authorization: Bearer <token>` header. Every error message, string form and debug form has every occurrence of the token replaced with `[redacted]`.
- Every call is bounded by the client timeout, even with no caller deadline. Response bodies over 8 MiB (8388608 bytes) are classified as unavailable and not retryable.
- Error classification is exactly the spec's "Error model" table:
  - Transport failure (dial, DNS, reset, TLS) and timeout: unavailable and retryable.
  - Caller cancellation: canceled.
  - HTTP 5xx and 429: unavailable and retryable.
  - HTTP 404: not_found.
  - Other 4xx: error.
  - A 2xx whose body is empty but a payload was expected: unavailable, not retryable.
  - A 2xx whose body isn't valid JSON: unavailable, not retryable.
  - 200 with `degraded: true` and an empty `results` array on search, recent, today or neighbors: unavailable and retryable.
  - 200 degraded with results: returned as data.
- Error fields: `op`, `statusCode`, `code` and `message`.
  - `op` is the Go op string for the method, from the table in Task 3.
  - `message` is the server's `error` field. If there is none, it's the trimmed raw body; when that runs past 256 characters it's truncated to 256 and suffixed with `…`.
- Method rules:
  - `forget`: 404 means `{deleted:false, coldDeleteOk:true}` with no error. A blank id fails locally with message `id is required`.
  - `capture` and `remember`: blank content fails locally with message `content is required`.
  - `today` is `recent` with `since` set to now − 24 h.
  - `health`: `{ok:false}` returns false, not an error.
  - GET and bodyless DELETE calls send no body. Every call sends `Accept: application/json`; calls with a body send `Content-Type: application/json`.
  - Optional fields that are unset or empty strings are omitted from request JSON. Timestamps are sent as RFC 3339 UTC with a `Z` suffix. Unknown response fields are ignored. int64 fields are `number` in TS (see the spec's edge cases).
- `expect.messageContains` is matched case-insensitively, because each language capitalises field names in its own way (`Token is required` in Go, `token is required` in Python).
- Scenario runners start the server through `clients/contract/scenario-server.sh` (Go's runner builds the binary itself), never with `go run`.
- "Empty" (the scenario outcome) means the method succeeded and its result's wire JSON is `[]`, or is an object whose `results` array has length 0.
- Naming: Python and Ruby use `snake_case`; TS, Java and Swift use `camelCase`; .NET uses `PascalCase` with an `Async` suffix; Rust uses `snake_case`; C uses `novamem_<class>_<snake>`. The classes are `Client`, `Management` and `Admin`.
- Sync/async:
  - Python: `Client` (sync) and `AsyncClient`, `AsyncManagement`, `AsyncAdmin` (async, running the sync call in `asyncio.to_thread`).
  - TS: async only, with an optional `{signal}` last argument.
  - .NET: async only, with a trailing `CancellationToken ct = default`.
  - Java: sync, plus `xxxAsync` returning `CompletableFuture`.
  - Rust: async.
  - C and C++: blocking.
  - Ruby and PHP: sync.
  - Swift: `async throws`.
- Versions: every SDK starts at `0.1.0`, except TS at `2.0.0`. Each README states "Requires novamem server ≥ <the server version tagged latest at merge time>".
- CI runs on `arc-azrtydxb-amd64` only. No Docker Desktop.
- Commits: conventional prefix (`feat(sdk-<lang>):`, `feat(contract):`, `ci(sdk):`, `docs(sdk):`). No AI co-author trailer or "Generated with" footer. Run `procoder check` from the repo root before each commit.
- A PR merges only after every Copilot and Claude review comment is resolved.

## Task 1: Probe ARC service-container support

Status: done 2026-09-25. Draft PR #306 ran the probe job on `arc-azrtydxb-amd64` (run 36098964791). The runner pulled `pgvector/pgvector:pg16`, the container reported `healthy`, and the step printed `services ok`. **Result: service containers work on the ARC runners.** PR #306 was closed unmerged, and its `probe` job never reaches `main`.

Files:

- none on `main`. The probe lived only on branch `feat/sdk-probe`.

Interfaces:

- Produces the fact `SERVICES_OK = true`, recorded here. Task 16 uses a `services.postgres` block and skips the apt-installed Postgres fallback.

- [x] Wrote the probe job (a `services.postgres` block with image `pgvector/pgvector:pg16`, plus a `/dev/tcp` wait step echoing `services ok`) and ran `actionlint`: PASS.
- [x] Pushed `feat/sdk-probe` and opened draft PR #306: the job succeeded and logged `services ok`.
- [x] Recorded the outcome in this task and in the todo's evidence, and closed PR #306 unmerged.

## Task 2: Response schemas for the nine wrapped routes

Status: landed ahead of the plan on branch `fix/sdk-prereqs`, together with the Go route-map correction (see Task 3). This task is closed by verifying that work, not by redoing it.

Files:

- `api/openapi.yaml` (modified: 12 schemas in `components.schemas`, each referenced from its route: `RevokeResult`, `AdminUser`, `AdminUserList`, `ProvisionedUser`, `UserDeletion`, `UserDeletionPreview`, `QuotaResult`, `ContextPrefix`, `ExportedEntry`, `ExportPage`, `ImportResult` and `TokenDeleted`)
- `docs/api/openapi.json` and `go/internal/httpapi/openapi.json` (regenerated by `gen-contract`)

Interfaces:

- Task 3 writes these schema names into `routes.json` `response` fields, and Task 6 generates types from them. `DELETE /v1/admin/users/{id}`'s 200 is `oneOf [UserDeletion, UserDeletionPreview]`; routes.json names the right one per method, so the generator never walks the `oneOf`.
- Status codes now match the handlers: `POST /v1/admin/users` declares 201 (it used to say 200). `POST /v1/me/import` declares 201, and 400 with the same `ImportResult` body when every entry failed (it used to say 200).
- Nullability matches the handlers: `AdminUser.name` (`warmstore.UserRow.Name` is `*string`), `QuotaResult.quota.*` (`GetUserQuota` returns `*int`), `ExportedEntry.projectId`, `agentName`, `sourceType`, `capturedFrom` (`warmstore.Entry` pointer fields), and `ExportPage.nextAfterId`. `UserDeletionPreview.wouldDelete.email` is optional because the handler sets it only when the user appears in `ListUsers`.

- [ ] Verify the landed schemas with this check, which Task 3 later turns into `TestWrappedRoutesDeclareResponseSchema`:

```bash
python3 - <<'PY'
import json,sys
d=json.load(open('docs/api/openapi.json'))
want={('post','/v1/admin/tokens/revoke','200'):'RevokeResult',('get','/v1/admin/users','200'):'AdminUserList',('post','/v1/admin/users','201'):'ProvisionedUser',('delete','/v1/admin/users/{id}','200'):None,('put','/v1/admin/users/{id}/quota','200'):'QuotaResult',('get','/v1/context-prefix','200'):'ContextPrefix',('get','/v1/me/export','200'):'ExportPage',('post','/v1/me/import','201'):'ImportResult',('delete','/v1/me/tokens/{hash}','200'):'TokenDeleted'}
bad=[]
for (m,p,c),name in want.items():
    s=d['paths'][p][m]['responses'].get(c,{}).get('content',{}).get('application/json',{}).get('schema')
    if not s: bad.append(f'{m.upper()} {p} {c}')
    elif name and s.get('$ref')!=f'#/components/schemas/{name}': bad.append(f'{m.upper()} {p} -> {s}')
print('\n'.join(bad)); sys.exit(1 if bad else 0)
PY
```

Expect PASS (empty output, exit 0). Against `main` before the fix, it fails and lists all nine routes.

- [ ] Run `cd go && go run ./cmd/gen-contract && git diff --exit-code ../docs/api/openapi.json internal/httpapi/openapi.json`: expect PASS (clean). Run `cd go && go test ./internal/httpapi/...`: expect PASS.
- [ ] Record in the todo's evidence that the schemas are checked against real responses only by `TestResponsesMatchSchemas` (Task 16). Until that job runs, they are verified by transcription from the handlers named in Interfaces.

## Task 3: `clients/contract` module and `routes.json`

Files:

- `clients/contract/go.mod` (created: `module github.com/azrtydxb/novamem/clients/contract`, `go 1.23.0`, no requirements)
- `go.work` (modified: add `./clients/contract`)
- `clients/contract/routes.json` (created: the route map)
- `clients/contract/contract.go` (created: loaders shared by the scenario server and the tests)
- `clients/contract/contract_test.go` (created)
- `clients/go/routecoverage_test.go` (modified: reads `../contract/routes.json` instead of the in-file `routeMap`)
- `.github/workflows/ci.yml` (modified: the `go` job also runs `cd clients/contract && go vet ./... && go test -count=1 ./...`)

Interfaces:

- `routes.json` shape: `{"<METHOD> <path>": {"methods": [{"name": "<Class>.<Method>", "op": "<go op string>", "request": "<TypeName>" | absent, "params": ["<wireName>", ...] | absent, "response": "<SchemaName>" | null}]} | {"nonGoal": "<reason>"}}`.
- `contract.go` exports:
  - `type Method struct { Name, Op, Request string; Params []string; Response *string }`
  - `type Route struct { Methods []Method; NonGoal string }`
  - `func LoadRoutes(path string) (map[string]Route, error)`
  - `func Surface(routes map[string]Route) []Method`, which returns the 41 methods sorted by `Name`.
- The 41 method entries, which every later task uses verbatim:

| Route                                        | name                                     | op                   | request / params                                     | response            |
| -------------------------------------------- | ---------------------------------------- | -------------------- | ---------------------------------------------------- | ------------------- |
| POST /v1/capture                             | Client.Capture                           | capture              | CaptureRequest                                       | CaptureResult       |
| POST /v1/search                              | Client.Search                            | search               | SearchRequest                                        | SearchResult        |
| POST /v1/recent                              | Client.Recent                            | recent               | RecentRequest                                        | EntryList           |
| POST /v1/recent                              | Client.Today                             | recent               | RecentRequest                                        | EntryList           |
| POST /v1/neighbors                           | Client.Neighbors                         | neighbors            | NeighborsRequest                                     | SearchResult        |
| PUT /v1/memories/{id}                        | Client.Update                            | update               | params [id] + UpdateRequest (id travels in the path) | UpdateResult        |
| POST /v1/forget                              | Client.Forget                            | forget               | ForgetRequest                                        | ForgetResult        |
| POST /v1/remember                            | Client.Remember                          | remember             | CaptureRequest                                       | RememberResult      |
| POST /v1/context                             | Client.Context                           | context              | ContextRequest                                       | SearchResult        |
| POST /v1/session-recap                       | Client.SessionRecap                      | session-recap        | SessionRecapRequest                                  | SessionRecapResult  |
| GET /v1/context-prefix                       | Client.ContextPrefix                     | context-prefix       | params [project]                                     | ContextPrefix       |
| GET /v1/stats                                | Client.Stats                             | stats                | —                                                    | Stats               |
| GET /health                                  | Client.Health                            | health               | —                                                    | Health              |
| POST /v1/me/tokens                           | Management.MintToken                     | mint-token           | MintTokenRequest                                     | MintedToken         |
| GET /v1/me/tokens                            | Management.ListTokens                    | list-tokens          | —                                                    | TokenList           |
| DELETE /v1/me/tokens/{hash}                  | Management.RevokeToken                   | revoke-token         | params [hash]                                        | TokenDeleted        |
| GET /v1/me/projects                          | Management.ListProjects                  | list-projects        | —                                                    | ProjectList         |
| POST /v1/me/projects                         | Management.CreateProject                 | create-project       | params [name]                                        | Project             |
| DELETE /v1/me/projects/{id}                  | Management.DeleteProject                 | delete-project       | params [id]                                          | ProjectDeleted      |
| GET /v1/me/projects/{id}/members             | Management.ListProjectMembers            | list-members         | params [id]                                          | MemberList          |
| POST /v1/me/projects/{id}/members            | Management.AddProjectMember              | add-member           | params [id, email, role]                             | MemberAdded         |
| DELETE /v1/me/projects/{id}/members/{userId} | Management.RemoveProjectMember           | remove-member        | params [id, userId]                                  | MemberRemoved       |
| DELETE /v1/me/projects/{id}/members/{userId} | Management.RemoveProjectMemberByUsername | remove-member        | params [id, username]                                | MemberRemoved       |
| GET /v1/me/active-project                    | Management.ActiveProject                 | active-project       | —                                                    | ActiveProject       |
| PUT /v1/me/active-project                    | Management.SetActiveProject              | set-active-project   | params [project]                                     | ActiveProject       |
| DELETE /v1/me/active-project                 | Management.ClearActiveProject            | clear-active-project | —                                                    | null                |
| POST /v1/decay                               | Management.Decay                         | decay                | params [effectiveDays]                               | DecayResult         |
| POST /v1/hygiene                             | Management.Hygiene                       | hygiene              | params [k]                                           | HygieneReport       |
| POST /v1/evaluate                            | Management.Evaluate                      | evaluate             | params [suite]                                       | EvaluateReport      |
| POST /v1/adoption                            | Management.Adoption                      | adoption             | params [client]                                      | AdoptionReport      |
| POST /v1/observe                             | Management.Observe                       | observe              | params [project, limit]                              | ObserveResult       |
| GET /v1/me/changes                           | Management.Changes                       | changes              | params [since, afterSeq, limit]                      | ChangeFeed          |
| GET /v1/me/usage                             | Management.Usage                         | usage                | —                                                    | Usage               |
| GET /v1/me/export                            | Management.Export                        | export               | params [afterId, limit]                              | ExportPage          |
| POST /v1/me/import                           | Management.Import                        | import               | params [entries]                                     | ImportResult        |
| POST /v1/admin/users                         | Admin.ProvisionUser                      | provision-user       | ProvisionUserRequest                                 | ProvisionedUser     |
| POST /v1/admin/tokens/revoke                 | Admin.RevokeUserToken                    | revoke-user-token    | params [token]                                       | RevokeResult        |
| GET /v1/admin/users                          | Admin.ListUsers                          | list-users           | —                                                    | AdminUserList       |
| DELETE /v1/admin/users/{id}                  | Admin.PreviewDeleteUser                  | preview-delete-user  | params [id]                                          | UserDeletionPreview |
| DELETE /v1/admin/users/{id}                  | Admin.DeleteUser                         | delete-user          | params [id]                                          | UserDeletion        |
| PUT /v1/admin/users/{id}/quota               | Admin.SetUserQuota                       | set-user-quota       | params [id, maxEntries, writesPerMinute]             | QuotaResult         |

The class corrections in this table (`Management.Decay`, `.Evaluate`, `.Hygiene`, `.Observe` and `.Adoption`, plus `GET /v1/me/today` as a non-goal) already landed in `clients/go/routecoverage_test.go` on `fix/sdk-prereqs`, guarded by `TestRouteMapNamesRealMethods`. This task moves the corrected map into `routes.json`, and deletes that Go map and both of its tests in favour of `TestEveryRouteIsAccounted`.

Before writing each row, confirm the op strings for `update`, `context-prefix`, `remove-member`, `preview-delete-user`, `delete-user` and `set-user-quota` against the `c.do(ctx, "<op>", ...)` calls in `clients/go/*.go`. The Go code wins if it differs. `GET /v1/me/today` carries over its non-goal reason from the Go map. Every other `non-goal:` row of the old Go `routeMap` is carried over with its reason text unchanged.

- [ ] Write the failing tests in `clients/contract/contract_test.go`:

```go
package contract

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func loadSpec(t *testing.T) (paths map[string]map[string]json.RawMessage, schemas map[string]json.RawMessage) {
	t.Helper()
	raw, err := os.ReadFile("../../docs/api/openapi.json")
	if err != nil {
		t.Fatalf("read openapi.json: %v", err)
	}
	var doc struct {
		Paths      map[string]map[string]json.RawMessage `json:"paths"`
		Components struct {
			Schemas map[string]json.RawMessage `json:"schemas"`
		} `json:"components"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("parse openapi.json: %v", err)
	}
	return doc.Paths, doc.Components.Schemas
}

// proved by: deleting any route's entry from routes.json, or adding a path to api/openapi.yaml, fails this test.
func TestRoutesJSONCoversOpenAPI(t *testing.T) {
	routes, err := LoadRoutes("routes.json")
	if err != nil {
		t.Fatal(err)
	}
	paths, _ := loadSpec(t)
	seen := map[string]bool{}
	for p, ops := range paths {
		for m := range ops {
			switch m {
			case "get", "post", "put", "delete", "patch":
				key := strings.ToUpper(m) + " " + p
				seen[key] = true
				if _, ok := routes[key]; !ok {
					t.Errorf("%s is in openapi.json but not in routes.json", key)
				}
			}
		}
	}
	for key := range routes {
		if !seen[key] {
			t.Errorf("routes.json entry %s no longer exists in openapi.json", key)
		}
	}
}

// proved by: removing the RevokeResult schema from api/openapi.yaml fails this test.
func TestWrappedRoutesDeclareResponseSchema(t *testing.T) {
	routes, err := LoadRoutes("routes.json")
	if err != nil {
		t.Fatal(err)
	}
	_, schemas := loadSpec(t)
	for key, r := range routes {
		for _, m := range r.Methods {
			if m.Response != nil {
				if _, ok := schemas[*m.Response]; !ok {
					t.Errorf("%s (%s): response schema %q missing from openapi.json", key, m.Name, *m.Response)
				}
			}
		}
	}
}

// proved by: deleting any one method row from routes.json fails this test.
func TestSurfaceIsFortyOneMethods(t *testing.T) {
	routes, err := LoadRoutes("routes.json")
	if err != nil {
		t.Fatal(err)
	}
	if got := len(Surface(routes)); got != 41 {
		t.Fatalf("surface = %d methods, want 41", got)
	}
}
```

Run `cd clients/contract && go test ./...`: expect FAIL with `undefined: LoadRoutes`.

- [ ] Implement `contract.go`. `LoadRoutes` reads and unmarshals the file, and returns an error naming the key when an entry has both `methods` and `nonGoal`, or neither. `Surface` flattens every `Methods` slice and sorts by `Name`.
- [ ] Write `routes.json` with the 41 rows from the table above, plus the non-goal rows.
- [ ] Run `cd clients/contract && go test -count=1 ./...`: expect PASS (3 tests).
- [ ] Rewrite `clients/go/routecoverage_test.go`. Delete the `routeMap` variable and `TestEveryOpenAPIRouteIsMappedOrDeclaredNonGoal`, and add:

```go
package novamem

import (
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
)

// proved by: renaming Management.Decay in routes.json to Client.Decay fails this test.
func TestEveryRouteIsAccounted(t *testing.T) {
	raw, err := os.ReadFile("../contract/routes.json")
	if err != nil {
		t.Fatalf("read routes.json: %v", err)
	}
	var routes map[string]struct {
		Methods []struct{ Name string } `json:"methods"`
	}
	if err := json.Unmarshal(raw, &routes); err != nil {
		t.Fatal(err)
	}
	types := map[string]reflect.Type{
		"Client":     reflect.TypeOf(&Client{}),
		"Management": reflect.TypeOf(&Management{}),
		"Admin":      reflect.TypeOf(&Admin{}),
	}
	for key, r := range routes {
		for _, m := range r.Methods {
			class, method, _ := strings.Cut(m.Name, ".")
			typ, ok := types[class]
			if !ok {
				t.Errorf("%s: unknown class %q", key, class)
				continue
			}
			if _, ok := typ.MethodByName(method); !ok {
				t.Errorf("%s: %s has no method %s", key, class, method)
			}
		}
	}
}
```

Route-to-spec coverage now lives in `clients/contract`, so the Go client test checks only method resolution.

- [ ] Run `cd clients/go && go test -count=1 -run TestEveryRouteIsAccounted ./...`: expect PASS. Then change `Management.Decay` to `Client.Decay` in `routes.json` and re-run: expect FAIL with `POST /v1/decay: Client has no method Decay`. Revert the change.
- [ ] Add `./clients/contract` to `go.work`. In `.github/workflows/ci.yml`, in the `go` job after the `clients/go` step, add `- run: cd clients/contract && go build ./... && go vet ./... && go test -count=1 ./...`.
- [ ] Commit `feat(contract): one route map for every SDK, with method names checked`.

## Task 4: Scenario server and `scenarios.json`

Files:

- `clients/contract/scenario.go` (created: the scenario model and HTTP handler)
- `clients/contract/cmd/scenario-server/main.go` (created: the CLI wrapper)
- `clients/contract/scenario_test.go` (created)
- `clients/contract/scenarios.json` (created)

Interfaces:

- `scenario.go` exports:
  - `type Scenario struct { ID string; Call Call; Respond []Response; ExpectRequest []ExpectedRequest; Expect Expectation; Requires []string }`. `Respond` and `ExpectRequest` accept either a single object or an array in JSON, via a custom `UnmarshalJSON`.
  - `type Call struct { Class, Op, Method string; Args map[string]any; CancelAfterMs int }`. `Method` is the `routes.json` name (for example `Client.Search`); `Op` is informational.
  - `type Response struct { Status int; JSON any; Raw *string; Fault string }`
  - `type ExpectedRequest struct { Method, Path string; JSON any; Query map[string]string; NoBody bool }`
  - `type Expectation struct { Outcome string; Retryable *bool; StatusCode *int; Code string; Result any }`
  - `type File struct { Version int; Token string; TimeoutMs int; Scenarios []Scenario }`
  - `func LoadScenarios(path string) (*File, error)`
  - `func NewServer(f *File) http.Handler`
- The HTTP protocol (every SDK runner uses exactly this):

  - `ANY /s/{id}/{rest...}`: server-side checks, recorded as mismatch strings:

    - the method, and the path (`/` + rest), match `ExpectRequest[n]`;
    - `Authorization` equals `Bearer <token>`;
    - the JSON body is a superset of the expected JSON, when `JSON` is set;
    - the body is empty, when `NoBody` is set;
    - every expected query pair is present.

    It then replies with `Respond[n]`, where n is the count of requests received so far for that id (the last element repeats).

  - Faults:
    - `timeout`: sleep `TimeoutMs + 500` ms, then reply 200 `{}`.
    - `reset`: hijack the connection and close it without writing.
    - `oversize`: reply 200 `application/json` with a 9437184-byte body `{"results":[` + `0,` repeated + `0]}`.
    - `refused`: never reaches the server; the runner uses the `closed` port.
  - `GET /_verdict/{id}` returns `{"requests": n, "mismatches": [...]}` and resets that id's state.
  - An unknown id replies 599 `{"error":"unknown scenario <id>"}`.

- `scenario-server.sh` (created): builds `./cmd/scenario-server` into `$TMPDIR` and `exec`s it with the given flags, so killing the process an SDK runner started kills the server.
- `cmd/scenario-server`: its flags are `-scenarios <path>` and `-addr` (default `127.0.0.1:0`). At startup it binds, then releases, one extra port (the `closed` port). It prints exactly `listening http://127.0.0.1:<port> closed=<closedPort>\n` to stdout, flushes, then serves until killed.

- [ ] Write the failing test in `clients/contract/scenario_test.go`:

```go
package contract

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestScenarioServerReplaysAndRecords(t *testing.T) {
	f := &File{Version: 1, Token: "nm_T", TimeoutMs: 300, Scenarios: []Scenario{{
		ID:            "s1",
		Call:          Call{Class: "Client", Method: "Client.Search", Args: map[string]any{"query": "q"}},
		Respond:       []Response{{Status: 200, JSON: map[string]any{"results": []any{}, "degraded": true}}},
		ExpectRequest: []ExpectedRequest{{Method: "POST", Path: "/v1/search", JSON: map[string]any{"query": "q"}}},
		Expect:        Expectation{Outcome: "unavailable"},
	}}}
	srv := httptest.NewServer(NewServer(f))
	defer srv.Close()

	req, _ := http.NewRequest("POST", srv.URL+"/s/s1/v1/search", strings.NewReader(`{"query":"q","k":5}`))
	req.Header.Set("Authorization", "Bearer nm_T")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 || !strings.Contains(string(body), `"degraded":true`) {
		t.Fatalf("replay = %d %s", resp.StatusCode, body)
	}

	v, _ := http.Get(srv.URL + "/_verdict/s1")
	var verdict struct {
		Requests   int      `json:"requests"`
		Mismatches []string `json:"mismatches"`
	}
	_ = json.NewDecoder(v.Body).Decode(&verdict)
	if verdict.Requests != 1 || len(verdict.Mismatches) != 0 {
		t.Fatalf("verdict = %+v", verdict)
	}

	req2, _ := http.NewRequest("GET", srv.URL+"/s/s1/v1/search", nil)
	resp2, _ := http.DefaultClient.Do(req2)
	resp2.Body.Close()
	v2, _ := http.Get(srv.URL + "/_verdict/s1")
	_ = json.NewDecoder(v2.Body).Decode(&verdict)
	if len(verdict.Mismatches) < 2 {
		t.Fatalf("want method+auth mismatches, got %+v", verdict)
	}
}

// proved by: removing any method's scenario from scenarios.json fails this test.
func TestEveryMethodHasAScenario(t *testing.T) {
	routes, err := LoadRoutes("routes.json")
	if err != nil {
		t.Fatal(err)
	}
	f, err := LoadScenarios("scenarios.json")
	if err != nil {
		t.Fatal(err)
	}
	have := map[string]bool{}
	for _, s := range f.Scenarios {
		have[s.Call.Method] = true
	}
	for _, m := range Surface(routes) {
		if !have[m.Name] {
			t.Errorf("no scenario calls %s", m.Name)
		}
	}
}

// proved by: deleting the scenario for any error-table row fails this test.
func TestErrorTableIsCovered(t *testing.T) {
	f, err := LoadScenarios("scenarios.json")
	if err != nil {
		t.Fatal(err)
	}
	ids := map[string]bool{}
	for _, s := range f.Scenarios {
		ids[s.ID] = true
	}
	for _, op := range []string{"search", "capture"} {
		for _, row := range []string{"refused", "timeout", "reset", "500", "503", "429", "404", "400", "401", "403", "empty-body", "html-body", "oversize", "cancel"} {
			if id := op + "-" + row; !ids[id] {
				t.Errorf("missing scenario %s", id)
			}
		}
	}
	for _, id := range []string{"search-degraded-empty-is-unavailable", "search-degraded-with-results-is-data", "token-echoed-in-401-is-redacted", "forget-ok", "forget-404-not-deleted", "forget-500-error", "forget-blank-id-local", "capture-blank-content-local", "health-ok-false", "today-since-24h", "stats-get-sends-no-body", "ctor-blank-token", "ctor-relative-url", "remove-member-by-username-two-calls"} {
		if !ids[id] {
			t.Errorf("missing scenario %s", id)
		}
	}
}
```

Run `cd clients/contract && go test ./...`: expect FAIL with `undefined: File`.

- [ ] Implement `scenario.go` and `cmd/scenario-server/main.go` to the protocol above. Guard the per-id state with a `sync.Mutex`.
- [ ] Write `scenarios.json` with `"version": 1`, `"token": "nm_scenario_TOKEN_must_never_leak"` and `"timeoutMs": 300`, and these scenarios:
  - For each op in `search` and `capture` (call args `{"query":"coffee"}` for search, `{"content":"coffee"}` for capture), the 14 error-table rows below. Each `expect` gives `outcome`, then `retryable`, then `statusCode` where one is set:
    - `-refused`: `{fault:"refused"}`, expect unavailable / true.
    - `-timeout`: `{fault:"timeout"}`, expect unavailable / true.
    - `-reset`: `{fault:"reset"}`, expect unavailable / true.
    - `-500`: status 500 with body `{"error":"boom"}`, expect unavailable / true / 500.
    - `-503`: status 503, raw body `upstream down`, expect unavailable / true / 503.
    - `-429`: status 429 with body `{"error":"slow down","code":"rate_limited"}`, expect unavailable / true / 429, code `rate_limited`.
    - `-404`: status 404 with body `{"error":"not found"}`, expect not_found / false / 404.
    - `-400`: status 400 with body `{"error":"bad","code":"invalid_body"}`, expect error / false / 400, code `invalid_body`.
    - `-401`: status 401 with body `{"error":"unauthorized"}`, expect error / false / 401.
    - `-403`: status 403 with body `{"error":"forbidden"}`, expect error / false / 403.
    - `-empty-body`: status 200, raw body `""`, expect unavailable / false.
    - `-html-body`: status 200, raw body `<html>bad gateway</html>`, expect unavailable / false.
    - `-oversize`: `{fault:"oversize"}`, expect unavailable / false.
    - `-cancel`: `{fault:"timeout"}` with `cancelAfterMs: 50` and `requires: ["cancel"]`, expect canceled.
  - `search-degraded-empty-is-unavailable`: 200 `{"results":[],"degraded":true}`, expect unavailable / true.
  - `search-degraded-with-results-is-data`: 200 `{"results":[{"id":"e1","content":"c"}],"degraded":true}`, expect ok with `result: {"degraded": true}`.
  - `token-echoed-in-401-is-redacted`: search; 401 `{"error":"bad token nm_scenario_TOKEN_must_never_leak"}`, expect error / 401.
  - `forget-ok`: args `{"id":"e1"}`; 200 `{"deleted":true,"coldDeleteOk":true}`, expect ok with the same `result`.
  - `forget-404-not-deleted`: 404, expect ok with `result: {"deleted":false,"coldDeleteOk":true}`.
  - `forget-500-error`: 500, expect unavailable / true.
  - `forget-blank-id-local`: args `{"id":" "}`; respond 200 `{}`; `expectRequest: []` (zero requests allowed, so the runner asserts `requests == 0`); expect error, message contains `id is required`.
  - `capture-blank-content-local`: the same shape with `{"content":""}`, message contains `content is required`.
  - `health-ok-false`: `Client.Health`; 200 `{"ok":false}`; expect ok with `result: false`.
  - `today-since-24h`: `Client.Today`, args `{}`; 200 `{"results":[]}`; expectRequest POST `/v1/recent`; expect empty. The server also checks that `since` in the body parses as RFC 3339 and falls within now − 24 h ± 60 s. Implement this as a special rule keyed on the scenario id, recording mismatch `since out of range` when it fails.
  - `health-503-is-false`: `Client.Health`; 503 `{"ok":false}`; expect ok with `result: false` (the Go client treats `/health`'s own 503 as the answer "not healthy", not an outage).
  - `observe-503-observer-disabled`: `Management.Observe` with args `{"project":"p1"}`; 503 `{"error":"observer disabled"}`; expect error, not retryable, status 503, code `observer_disabled`.
  - `search-ok` and `capture-ok`: one plain success each, so the error-table ops also have a success path.
  - `stats-get-sends-no-body`: `Client.Stats`; expectRequest GET `/v1/stats` with `noBody: true`; 200 `{"byNamespace":{},"totals":{"warm":0,"cold":0}}`; expect ok.
  - `ctor-blank-token`: `call.class: "ctor"`, args `{"baseUrl":"<server>","token":"  "}`; expect error, `requests == 0`.
  - `ctor-relative-url`: `call.class: "ctor"`, args `{"baseUrl":"localhost:7778","token":"nm_scenario_TOKEN_must_never_leak"}`; expect error, message must not contain the token.
  - `remove-member-by-username-two-calls`: `Management.RemoveProjectMemberByUsername` with args `{"id":"p1","username":"bob"}`. Respond `[200 {"members":[{"userId":"u2","username":"bob","role":"member"}]}, 200 {"removed":true}]`. expectRequest `[GET /v1/me/projects/p1/members, DELETE /v1/me/projects/p1/members/u2]`. Expect ok.
  - One success scenario for every one of the 41 methods not already covered, id `<op>-ok`. Args are a minimal valid request (for example `Management.CreateProject {"name":"p"}`). `respond` is a minimal body that satisfies the method's response schema in `docs/api/openapi.json`. `expectRequest` gives method and path, and `json` or `query` where the method sends them. Expect ok, or empty for `Client.Recent`.
- [ ] Run `cd clients/contract && go test -count=1 ./...`: expect PASS (5 tests).
- [ ] Commit `feat(contract): scenario server and the shared behaviour suite`.

## Task 5: Go client runs the scenario suite

Files:

- `clients/go/scenarios_test.go` (created)

Interfaces:

- Consumes the Task 4 protocol. It builds `./cmd/scenario-server` into `t.TempDir()` and runs the binary with working directory `../contract`; it never uses `go run`, because killing `go run` leaves the compiled child holding the test's output open. Every other SDK uses `clients/contract/scenario-server.sh`, which builds and then `exec`s, for the same reason.
- Produces the reference runner that every other SDK's runner copies in its own language:

  1. start or locate the server;
  2. for each scenario, build the client at `<url>/s/<id>` (or `http://127.0.0.1:<closed>/s/<id>` for `refused`), call the method, classify the outcome, and check `expect`;
  3. check the token-leak invariant on every error;
  4. fetch `/_verdict/<id>` and fail on mismatches, or on `requests != 0` when `expectRequest` is `[]`.

- [ ] Write the failing test:

```go
package novamem

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

type scenarioFile struct {
	Token     string `json:"token"`
	TimeoutMs int    `json:"timeoutMs"`
	Scenarios []struct {
		ID   string `json:"id"`
		Call struct {
			Class         string         `json:"class"`
			Method        string         `json:"method"`
			Args          map[string]any `json:"args"`
			CancelAfterMs int            `json:"cancelAfterMs"`
		} `json:"call"`
		Respond       json.RawMessage `json:"respond"`
		ExpectRequest json.RawMessage `json:"expectRequest"`
		Expect        struct {
			Outcome    string `json:"outcome"`
			Retryable  *bool  `json:"retryable"`
			StatusCode *int   `json:"statusCode"`
			Code       string `json:"code"`
		} `json:"expect"`
	} `json:"scenarios"`
}

func startScenarioServer(t *testing.T) (base, closed string) {
	t.Helper()
	cmd := exec.Command("sh", "scenario-server.sh", "-scenarios", "scenarios.json")
	cmd.Dir = "../contract"
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill() })
	line, err := bufio.NewReader(out).ReadString('\n')
	if err != nil {
		t.Fatalf("scenario-server: %v", err)
	}
	f := strings.Fields(line) // listening <url> closed=<port>
	return f[1], strings.TrimPrefix(f[2], "closed=")
}

// proved by: deleting degradedEmpty's body fails search-degraded-empty-is-unavailable;
// deleting the [redacted] replacement fails token-echoed-in-401-is-redacted.
func TestScenarios(t *testing.T) {
	raw, err := os.ReadFile("../contract/scenarios.json")
	if err != nil {
		t.Fatal(err)
	}
	var f scenarioFile
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	base, closed := startScenarioServer(t)
	for _, s := range f.Scenarios {
		t.Run(s.ID, func(t *testing.T) {
			url := base + "/s/" + s.ID
			if strings.Contains(string(s.Respond), `"refused"`) {
				url = "http://127.0.0.1:" + closed + "/s/" + s.ID
			}
			ctx := context.Background()
			if s.Call.CancelAfterMs > 0 {
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				time.AfterFunc(time.Duration(s.Call.CancelAfterMs)*time.Millisecond, cancel)
			}
			result, err := dispatchScenario(ctx, url, f.Token, time.Duration(f.TimeoutMs)*time.Millisecond, s.Call.Class, s.Call.Method, s.Call.Args)
			got := classifyScenario(result, err)
			if got != s.Expect.Outcome {
				t.Fatalf("outcome = %s (err=%v), want %s", got, err, s.Expect.Outcome)
			}
			if err != nil {
				if strings.Contains(err.Error(), f.Token) || strings.Contains(fmt.Sprintf("%+v", err), f.Token) {
					t.Fatalf("token leaked: %v", err)
				}
				if s.Expect.Retryable != nil && Retryable(err) != *s.Expect.Retryable {
					t.Fatalf("retryable = %v, want %v", Retryable(err), *s.Expect.Retryable)
				}
				var e *Error
				if s.Expect.StatusCode != nil && (!errors.As(err, &e) || e.StatusCode != *s.Expect.StatusCode) {
					t.Fatalf("status = %v, want %d", e, *s.Expect.StatusCode)
				}
				if s.Expect.Code != "" && (!errors.As(err, &e) || e.Code != s.Expect.Code) {
					t.Fatalf("code = %v, want %s", e, s.Expect.Code)
				}
			}
			resp, err := http.Get(base + "/_verdict/" + s.ID)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			var v struct {
				Requests   int      `json:"requests"`
				Mismatches []string `json:"mismatches"`
			}
			_ = json.NewDecoder(resp.Body).Decode(&v)
			if len(v.Mismatches) > 0 {
				t.Fatalf("request mismatches: %v", v.Mismatches)
			}
			if string(s.ExpectRequest) == "[]" && v.Requests != 0 {
				t.Fatalf("expected no request, server saw %d", v.Requests)
			}
		})
	}
}

func classifyScenario(result any, err error) string {
	switch {
	case err == nil && isEmptyResult(result):
		return "empty"
	case err == nil:
		return "ok"
	case errors.Is(err, context.Canceled):
		return "canceled"
	case Unavailable(err):
		return "unavailable"
	case errors.Is(err, ErrNotFound):
		return "not_found"
	default:
		return "error"
	}
}

func isEmptyResult(result any) bool {
	b, _ := json.Marshal(result)
	s := strings.TrimSpace(string(b))
	if s == "[]" {
		return true
	}
	var obj map[string]json.RawMessage
	if json.Unmarshal(b, &obj) == nil {
		if r, ok := obj["results"]; ok && strings.TrimSpace(string(r)) == "[]" {
			return true
		}
	}
	return false
}
```

Also in `scenarios_test.go`, write `dispatchScenario(ctx, url, token, timeout, class, method, args) (any, error)`. It has one `case` per `routes.json` method name (41), plus `case "ctor"` calling `New(Config{BaseURL: args["baseUrl"], Token: args["token"]})`. Each case decodes `args` into the Go request type by `json.Marshal`-then-`json.Unmarshal` (for example `var r SearchRequest`), or reads scalar params (`args["name"].(string)`, with numbers as `int(args["k"].(float64))`). It then calls the method on a client built with `New` / `NewManagement` / `NewAdmin` (`Config{BaseURL: url, Token: token, Timeout: timeout}`). Methods that return several values wrap them in a map using wire names: `Decay` returns `map[string]int{"demoted": d, "promoted": p}`, and `ActiveProject` returns `map[string]string{"id": id, "name": name}`.

- [ ] Run `cd clients/go && go test -count=1 -run TestScenarios ./...`: expect FAIL. On the first run `dispatchScenario` is only a stub returning `nil, errors.New("todo-dispatch")`, which classifies as `error`, so it fails with `outcome = error`.
- [ ] Fill in all 41 dispatch cases. Run again: expect PASS for every sub-test. Any failure that isn't in the dispatch code means either `scenarios.json` disagrees with the Go client or the Go client has a bug. Read the Go method's comment. The Go client is the oracle unless it contradicts the spec's error table; in that case, fix the Go client and note the fix in the commit body.
- [ ] Mutation check: comment out the `if r.Degraded && len(r.Entries) == 0` block in `degradedEmpty` (in `clients/go/novamem.go`) and re-run. Expect FAIL on `search-degraded-empty-is-unavailable` with `outcome = empty`. Revert.
- [ ] Commit `test(sdk-go): run the shared scenario suite against the reference client`.

## Task 6: Type generator core

Files:

- `clients/gen/go.mod` (created: `module github.com/azrtydxb/novamem/clients/gen`, `go 1.23.0`, no requirements)
- `go.work` (modified: add `./clients/gen`)
- `clients/gen/main.go` (created: flags and orchestration)
- `clients/gen/ir.go` (created: OpenAPI JSON → intermediate representation)
- `clients/gen/naming.go` (created: identifier casing per language)
- `clients/gen/emit.go` (created: template execution, `-check` diffing)
- `clients/gen/templates/` (created: empty directory with a `.gitkeep`; each SDK task adds `<lang>.tmpl` plus `<lang>_dispatch.tmpl`)
- `clients/gen/gen_test.go` and `clients/gen/testdata/mini.json` (created)

Interfaces:

- CLI: `go run ./clients/gen -spec docs/api/openapi.json -routes clients/contract/routes.json -out clients [-check] [-lang python,typescript,...]`. The run executes every template present in `clients/gen/templates/`. `-check` writes nothing, prints `stale: <path>` for each file that differs, and exits 1 if any does.
- IR:
  - `type Type struct { Name string; Kind Kind; Fields []Field; Elem *TypeRef; Enum []string; Doc string }`, where `Kind` is one of `KObject`, `KEnum` or `KAlias`.
  - `type Field struct { Name, Wire string; Ref TypeRef; Required, Nullable bool; Doc string }`
  - `type TypeRef struct { Prim string; Named string; Array *TypeRef; Map *TypeRef }`. `Prim` is one of `string`, `int32`, `int64`, `float`, `bool`, `any` or `datetime`.
  - `type Model struct { Types []Type; Methods []contract.Method }`, sorted by name.
  - The generator imports `clients/contract` for `LoadRoutes` and `Surface`, through a `replace github.com/azrtydxb/novamem/clients/contract => ../contract` directive in `clients/gen/go.mod`.
- Naming rules:
  - Request types come from `routes.json` `request`.
  - Response types are the component schema names.
  - An inline nested object is named `<Parent><PascalField>` (for example `UserDeletionPreviewWouldDelete`).
  - An inline enum is named `<Parent><PascalField>` with Kind `KEnum`.
  - `integer` with `format: int64`, or a field named `seq`, `afterSeq` or `nextSeq`, maps to `int64`; any other `integer` maps to `int32`.
  - `format: date-time` maps to `datetime`.
  - `additionalProperties: true` with no properties maps to `Map{Prim:"any"}`.
  - `nullable: true` sets `Nullable`.
- Template data: each template receives `Model` plus helpers `pascal`, `camel`, `snake`, `upperSnake` and `wire`. Each template file begins with a first-line directive, `{{/* lang: <lang> out: <path relative to -out> */}}`. `-lang` filters on the directive's `lang`, never on the file name. The langs are `python`, `typescript`, `dotnet`, `java`, `rust`, `rust_ffi`, `ruby`, `php` and `swift`. A language's dispatch template carries the same `lang` as its types template, so `-lang rust` never selects the `rust_ffi` templates.
- Unsupported constructs (`oneOf`, `anyOf`, `allOf`, or `$ref` to a missing schema) inside any type reachable from a `routes.json` method make the generator exit 2, printing `unsupported <construct> at <json pointer>`.

- [ ] Write `clients/gen/testdata/mini.json`: an OpenAPI 3.0.3 document with one path, `POST /v1/search`. Its inline request body has `query` (string, required), `k` (integer) and `contentMode` (enum `full`/`snippet`). Its 200 response `$ref`s the schema `SearchResult`, which has `results` (an array of `MemoryEntry`, where `MemoryEntry` has `id` string and `seq` integer) and `degraded` (boolean). Write `clients/gen/testdata/routes.json` as `{"POST /v1/search":{"methods":[{"name":"Client.Search","op":"search","request":"SearchRequest","response":"SearchResult"}]}}`.
- [ ] Write the failing tests:

```go
package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestBuildModel(t *testing.T) {
	m, err := BuildModel("testdata/mini.json", "testdata/routes.json")
	if err != nil {
		t.Fatal(err)
	}
	byName := map[string]Type{}
	for _, ty := range m.Types {
		byName[ty.Name] = ty
	}
	req, ok := byName["SearchRequest"]
	if !ok {
		t.Fatalf("types = %v, want SearchRequest", m.Types)
	}
	if req.Fields[0].Wire != "contentMode" || req.Fields[0].Ref.Named != "SearchRequestContentMode" {
		t.Errorf("contentMode field = %+v", req.Fields[0])
	}
	if e := byName["SearchRequestContentMode"]; e.Kind != KEnum || len(e.Enum) != 2 {
		t.Errorf("enum = %+v", e)
	}
	if f := byName["MemoryEntry"].Fields; f[1].Wire != "seq" || f[1].Ref.Prim != "int64" {
		t.Errorf("seq = %+v, want int64", f[1])
	}
	for _, f := range req.Fields {
		if f.Wire == "query" && !f.Required {
			t.Error("query must be required")
		}
	}
}

func TestCheckReportsStale(t *testing.T) {
	dir := t.TempDir()
	tmpl := filepath.Join(dir, "tmpl")
	_ = os.MkdirAll(tmpl, 0o755)
	_ = os.WriteFile(filepath.Join(tmpl, "x.tmpl"), []byte("{{/* lang: x out: x/types.txt */}}{{range .Types}}{{.Name}}\n{{end}}"), 0o644)
	out := filepath.Join(dir, "out")
	if err := Run(Options{Spec: "testdata/mini.json", Routes: "testdata/routes.json", Templates: tmpl, Out: out}); err != nil {
		t.Fatal(err)
	}
	stale, err := Check(Options{Spec: "testdata/mini.json", Routes: "testdata/routes.json", Templates: tmpl, Out: out})
	if err != nil || len(stale) != 0 {
		t.Fatalf("fresh output reported stale: %v %v", stale, err)
	}
	_ = os.WriteFile(filepath.Join(out, "x/types.txt"), []byte("edited"), 0o644)
	stale, _ = Check(Options{Spec: "testdata/mini.json", Routes: "testdata/routes.json", Templates: tmpl, Out: out})
	if len(stale) != 1 || stale[0] != "x/types.txt" {
		t.Fatalf("stale = %v, want [x/types.txt]", stale)
	}
}

func TestUnsupportedConstructFails(t *testing.T) {
	_, err := BuildModel("testdata/oneof.json", "testdata/routes.json")
	if err == nil || err.Error() != "unsupported oneOf at #/components/schemas/SearchResult/properties/results" {
		t.Fatalf("err = %v", err)
	}
}
```

Write `testdata/oneof.json` as a copy of `mini.json` in which `SearchResult.results` is `{"oneOf":[{"type":"string"},{"type":"integer"}]}`. Fields are emitted in wire-name alphabetical order, which is why `contentMode` is `Fields[0]` and `seq` is `Fields[1]` of `MemoryEntry`.

Run `cd clients/gen && go test ./...`: expect FAIL with `undefined: BuildModel`.

- [ ] Implement `ir.go` (`BuildModel`), `naming.go`, `emit.go` (`Run` and `Check`, with `Options{Spec, Routes, Templates, Out string; Langs []string}`) and `main.go` (flags; `-templates` defaults to `clients/gen/templates`). Output files are written with a trailing newline and LF line endings.
- [ ] Run `cd clients/gen && go test -count=1 ./...`: expect PASS (3 tests). Then run `go run ./clients/gen -spec docs/api/openapi.json -routes clients/contract/routes.json -out clients -check`: expect PASS (no templates yet, so no output and exit 0). A non-zero exit here with `unsupported …` means a construct needs handling. `DELETE /v1/admin/users/{id}`'s `oneOf` is never walked, because routes.json names `UserDeletion` and `UserDeletionPreview` directly.
- [ ] Add to `.github/workflows/sdk.yml` a `generated` job (`runs-on: arc-azrtydxb-amd64`, `timeout-minutes: 10`) with steps `actions/checkout@v7`, `actions/setup-go@v6` with `go-version-file: go.work`, and `go run ./clients/gen -spec docs/api/openapi.json -routes clients/contract/routes.json -out clients -check`.
- [ ] Commit `feat(gen): OpenAPI-to-SDK type generator with a staleness check`.

## Task 7: Python SDK

Status: built on `feat/sdk-python`. Where the build differs from the steps below, the build is right:

- Async cancellation surfaces as the native `asyncio.CancelledError`. It is never converted into a `CanceledError` class (which doesn't exist), because converting it would break `asyncio.timeout()` and `TaskGroup`, and every other SDK with cancellation also uses its platform's native signal.
- Every method returns the generated type named by routes.json `response` (`list_tokens()` → `TokenList`, `decay()` → `DecayResult`). The exceptions are `health()` → `bool` and `clear_active_project()` → `None`.
- Python keywords get a trailing underscore: `Management.Import` is `import_` (the generator's `pyident`).
- The runner starts the server with `sh scenario-server.sh`. The dispatch table is shared by the sync and async clients (`ADISPATCH = DISPATCH`).
- Ruff excludes the two generated files (`[tool.ruff] extend-exclude` in `clients/python/pyproject.toml`). This follows the `.prettierignore` rule for generated outputs.

Files:

- `clients/gen/templates/python.tmpl` (created; out: `python/src/novamem/_types.py`): `@dataclass(frozen=True)` per object type. It has `to_wire(self) -> dict` (omitting fields that are `None` or `""`, and rendering `datetime` as UTC `...Z`) and `@classmethod from_wire(cls, d: dict)` (ignoring unknown keys). Enums are `class X(str, Enum)`.
- `clients/gen/templates/python_dispatch.tmpl` (created; out: `python/tests/_dispatch.py`): `DISPATCH: dict[str, Callable[[dict, dict], Any]]` and `ADISPATCH` (the async twin), keyed by `routes.json` name. Each entry takes `(clients, args)`, where `clients` is `{"Client": ..., "Management": ..., "Admin": ...}`, and calls the method with `<Request>.from_wire(args)` or keyword scalars named by `snake(param)`.
- `clients/python/pyproject.toml` (created: name `novamem`, version `0.1.0`, `requires-python = ">=3.10"`, `dependencies = []`, build backend `setuptools.build_meta` with `requires = ["setuptools>=69"]`, package dir `src`)
- `clients/python/src/novamem/__init__.py` (created: re-exports `Client`, `Management`, `Admin`, `AsyncClient`, `AsyncManagement`, `AsyncAdmin`, the errors and every generated type)
- `clients/python/src/novamem/_errors.py` (created)
- `clients/python/src/novamem/_transport.py` (created: the single `_do` request function)
- `clients/python/src/novamem/_client.py` (created: `Client`, `Management`, `Admin`)
- `clients/python/src/novamem/_async.py` (created: the async wrappers)
- `clients/python/tests/test_scenarios.py`, `clients/python/tests/test_routes.py` (created)
- `clients/python/smoke.py` (created; used by Task 16)

Interfaces:

- `Client(base_url: str, token: str, *, timeout: float = 15.0)`. `Management` and `Admin` take the same arguments.
- Errors:
  - `class NovamemError(Exception)` with attributes `op: str`, `status_code: int`, `code: str`, `message: str`, `unavailable: bool`, `retryable: bool`, and `__str__` of the form `novamem <op>: <status> [<code>]: <message>` (the same format as Go `Error.Error()`).
  - `UnavailableError(NovamemError)` and `NotFoundError(NovamemError)`.
  - `CanceledError(NovamemError)`, raised only by the async classes when the awaiting task is cancelled. The async wrapper catches `asyncio.CancelledError` and re-raises it as `CanceledError` from within the cancelled task.
  - `ConfigError(ValueError)`, raised by constructors.
- Method names are `snake(<Go method>)`, for example `session_recap`, `remove_project_member_by_username`. Multi-value Go returns come back as generated types: `decay` → `DecayResult`, `active_project` → `ActiveProject`.
- Consumes the Task 4 protocol and the Task 6 generator.

- [ ] Write the failing test `clients/python/tests/test_scenarios.py`:

```python
import asyncio, json, subprocess, threading, unittest, urllib.request
from pathlib import Path

import novamem
from _dispatch import DISPATCH, ADISPATCH

CLIENTS = Path(__file__).resolve().parents[2]
SCEN = json.loads((CLIENTS / "contract" / "scenarios.json").read_text())
TOKEN = SCEN["token"]


def start_server():
    p = subprocess.Popen(
        ["sh", "scenario-server.sh", "-scenarios", "scenarios.json"],
        cwd=CLIENTS / "contract", stdout=subprocess.PIPE, text=True)
    _, url, closed = p.stdout.readline().split()
    return p, url, closed.split("=")[1]


def is_empty(result):
    wire = result.to_wire() if hasattr(result, "to_wire") else result
    return wire == [] or (isinstance(wire, dict) and wire.get("results") == [])


def classify(result, err):
    if err is None:
        return "empty" if is_empty(result) else "ok"
    if isinstance(err, novamem.CanceledError):
        return "canceled"
    if isinstance(err, novamem.UnavailableError):
        return "unavailable"
    if isinstance(err, novamem.NotFoundError):
        return "not_found"
    return "error"


class Scenarios(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.proc, cls.url, cls.closed = start_server()

    @classmethod
    def tearDownClass(cls):
        cls.proc.kill()

    def base(self, s):
        if '"refused"' in json.dumps(s.get("respond")):
            return f"http://127.0.0.1:{self.closed}/s/{s['id']}"
        return f"{self.url}/s/{s['id']}"

    def verdict(self, s):
        with urllib.request.urlopen(f"{self.url}/_verdict/{s['id']}") as r:
            v = json.load(r)
        self.assertEqual(v["mismatches"], [], s["id"])
        if s.get("expectRequest") == []:
            self.assertEqual(v["requests"], 0, s["id"])

    def check(self, s, result, err):
        exp = s["expect"]
        self.assertEqual(classify(result, err), exp["outcome"], f"{s['id']}: {err!r}")
        if err is not None:
            self.assertNotIn(TOKEN, str(err), s["id"])
            self.assertNotIn(TOKEN, repr(err), s["id"])
            if "retryable" in exp:
                self.assertEqual(getattr(err, "retryable", False), exp["retryable"], s["id"])
            if "statusCode" in exp:
                self.assertEqual(err.status_code, exp["statusCode"], s["id"])
            if "code" in exp:
                self.assertEqual(err.code, exp["code"], s["id"])

    def run_one(self, s, is_async):
        call, timeout = s["call"], SCEN["timeoutMs"] / 1000
        if call["class"] == "ctor":
            a = call["args"]
            try:
                novamem.Client(a["baseUrl"].replace("<server>", self.url), a["token"])
                return None, None
            except (novamem.ConfigError, novamem.NovamemError) as e:
                return None, e
        base = self.base(s)
        if not is_async:
            clients = {k: getattr(novamem, k)(base, TOKEN, timeout=timeout) for k in ("Client", "Management", "Admin")}
            try:
                return DISPATCH[call["method"]](clients, call["args"]), None
            except novamem.NovamemError as e:
                return None, e
        clients = {k: getattr(novamem, "Async" + k)(base, TOKEN, timeout=timeout) for k in ("Client", "Management", "Admin")}

        async def go():
            task = asyncio.ensure_future(ADISPATCH[call["method"]](clients, call["args"]))
            if call.get("cancelAfterMs"):
                asyncio.get_running_loop().call_later(call["cancelAfterMs"] / 1000, task.cancel)
            try:
                return await task, None
            except novamem.NovamemError as e:
                return None, e
        return asyncio.run(go())

    def test_sync(self):
        for s in SCEN["scenarios"]:
            if "cancel" in s.get("requires", []):
                print(f"skip (sync has no cancellation): {s['id']}")
                continue
            with self.subTest(s["id"]):
                self.check(s, *self.run_one(s, False))
                self.verdict(s)

    def test_async(self):
        for s in SCEN["scenarios"]:
            with self.subTest(s["id"]):
                self.check(s, *self.run_one(s, True))
                self.verdict(s)


if __name__ == "__main__":
    unittest.main()
```

Write `clients/python/tests/test_routes.py`:

```python
import json, unittest
from pathlib import Path
import novamem

ROUTES = json.loads((Path(__file__).resolve().parents[2] / "contract" / "routes.json").read_text())


def snake(s):
    return "".join("_" + c.lower() if c.isupper() else c for c in s).lstrip("_")


class Routes(unittest.TestCase):
    # proved by: renaming Client.session_recap fails this test.
    def test_every_method_resolves(self):
        for key, r in ROUTES.items():
            for m in r.get("methods", []):
                cls, meth = m["name"].split(".")
                for c in (getattr(novamem, cls), getattr(novamem, "Async" + cls)):
                    with self.subTest(f"{key} {c.__name__}.{snake(meth)}"):
                        self.assertTrue(callable(getattr(c, snake(meth), None)))
```

Run `cd clients/python && PYTHONPATH=src:tests python -m unittest discover -s tests`: expect FAIL with `ModuleNotFoundError: No module named 'novamem'`.

- [ ] Write both templates. Run `go run ./clients/gen -spec docs/api/openapi.json -routes clients/contract/routes.json -out clients -lang python`: expect PASS, creating `clients/python/src/novamem/_types.py` and `clients/python/tests/_dispatch.py`, each beginning with `# Code generated by clients/gen. DO NOT EDIT.`.
- [ ] Implement `_transport._do(cfg, op, method, path, body=None, query=None, expect_body=True)`, using `urllib.request` with `timeout=cfg.timeout`. It follows the Constraints' classification exactly:
  - `urllib.error.HTTPError` is classified by its `code`.
  - `urllib.error.URLError` and `ConnectionError` are unavailable and retryable.
  - `TimeoutError` and `socket.timeout` are unavailable and retryable, with message `timed out`.
  - The body is read with `resp.read(8388609)`, and a length over 8388608 is unavailable with message `response body exceeds 8 MiB`.
  - A 2xx with an empty body when `expect_body` is set is unavailable with message `empty response body`.
  - `json.JSONDecodeError` is unavailable with message `malformed response body`.
  - `message.replace(cfg.token, "[redacted]")` is applied to every error message before raising.
  - The `Authorization` header is set on the `Request` object; the token is never put into a URL.
  - The constructor validates with `urllib.parse.urlsplit`: scheme in `{"http","https"}` and a non-empty netloc, otherwise `ConfigError("novamem: base_url is not an absolute http(s) URL")`. A blank token raises `ConfigError("novamem: token is required")`. Keep the token in a private attribute `_token`, and give the config class `__repr__` returning `Config(base_url=..., token=[redacted])`.
- [ ] Implement the 41 methods in `_client.py`. Each is 2–4 lines calling `_do` with the op, method and path from the Task 3 table, and returning `<Response>.from_wire(...)`. Apply the special rules:

  - `forget`: 404 means `ForgetResult(deleted=False, cold_delete_ok=True)`; a blank id raises `NovamemError(op="forget", message="id is required")`.
  - `capture` and `remember`: blank content raises `content is required`.
  - `search`, `recent`, `today` and `neighbors`: `degraded` with empty `results` raises `UnavailableError(op, 200, message="store answered degraded with no results, so this is not evidence of absence", retryable=True)`.
  - `today`: sets `since=datetime.now(timezone.utc) - timedelta(hours=24)`.
  - `health` returns `bool(body["ok"])`.
  - `remove_project_member_by_username`: `list_project_members` then `remove_project_member`; an unknown username raises `NovamemError(op="remove-member", message="unknown member '<username>'")`.

  Implement `_async.py`: each async method is `return await asyncio.to_thread(self._sync.<name>, *a, **kw)`, wrapped in a `try/except asyncio.CancelledError: raise CanceledError(op=<op>, message="canceled")`.

- [ ] Run `cd clients/python && PYTHONPATH=src:tests python -m unittest discover -s tests -v`: expect PASS for both `test_sync` and `test_async`, and for `test_every_method_resolves`. Run with `python3.10` and with `python3.13`.
- [ ] Mutation check: delete the `.replace(cfg.token, "[redacted]")` call and re-run. Expect FAIL in `token-echoed-in-401-is-redacted`. Revert.
- [ ] Check dependencies: `python -m venv /tmp/nm && /tmp/nm/bin/pip install ./clients/python && /tmp/nm/bin/pip list --format=freeze | grep -v -E '^(pip|setuptools)='` prints exactly `novamem==0.1.0`.
- [ ] Write `clients/python/smoke.py`. It reads `NOVAMEM_SMOKE_URL` and `NOVAMEM_SMOKE_TOKEN`, and takes `argv[1]` as `up` or `down`.
  - `up`: `capture(CaptureRequest(content="sdk-smoke python <uuid4>", namespace="sdk-smoke", force=True))`, and assert `saved`. Then `search(SearchRequest(query="<uuid4>"))`, and assert any `results[i].id` equals the captured id. Then `forget(ForgetRequest(id=...))`, and assert `deleted`. Then search again, and assert the id is absent.
  - `down`: `search(SearchRequest(query="x"))` must raise `UnavailableError`.
  - Every failure prints `python <step>: <detail>` and exits 1.
- [ ] Add a `python` job to `.github/workflows/sdk.yml`:
  - `runs-on: arc-azrtydxb-amd64`, `timeout-minutes: 15`, `needs: [generated]`.
  - A matrix of `python: ["3.10", "3.13"]`, using `actions/setup-python@v6` and `actions/setup-go@v6` (`go-version-file: go.work`).
  - Run: `cd clients/python && PYTHONPATH=src:tests python -m unittest discover -s tests -v`.
- [ ] Commit `feat(sdk-python): novamem Python SDK held to the shared scenario suite`.

## Task 8: TypeScript SDK

Files:

- `clients/gen/templates/typescript.tmpl` (created; out: `typescript/src/types.ts`): `export interface` per object type, using wire field names and `?` for optional fields. `int64` becomes `number`, request `datetime` becomes `string | Date`, enums become union string literal types, and maps become `Record<string, unknown>`.
- `clients/gen/templates/typescript_dispatch.tmpl` (created; out: `typescript/test/dispatch.ts`): `export const DISPATCH: Record<string, (c: Clients, args: any, signal?: AbortSignal) => Promise<unknown>>`, keyed by `routes.json` name, calling `c.<Class>.<camel(method)>(args, {signal})` or, for scalars, `(args.<p1>, args.<p2>, …, {signal})`.
- `clients/typescript/package.json` (created: `"name": "@azrtydxb/novamem"`, `"version": "2.0.0"`, `"type": "module"`, `"engines": {"node": ">=20"}`, `"exports": {".": {"types": "./dist/index.d.ts", "import": "./dist/index.js"}}`, `"files": ["dist"]`, no `dependencies`, `devDependencies` of `{"typescript": "5.9.3"}` only, and scripts `build: tsc -p .` and `test: tsc -p tsconfig.test.json && node --test dist-test/test/`)
- `clients/typescript/tsconfig.json`, `clients/typescript/tsconfig.test.json` (created: `strict`, `target ES2022`, `module NodeNext`)
- `clients/typescript/src/index.ts`, `src/errors.ts`, `src/transport.ts`, `src/client.ts` (created)
- `clients/typescript/test/scenarios.test.ts`, `clients/typescript/test/routes.test.ts` (created)
- `clients/typescript/smoke.mjs` (created)
- `pnpm-workspace.yaml` is not modified: `clients/typescript` is a standalone npm package outside the pnpm workspace, and `scripts/assert-nothing-publishable.mjs` scans only `packages/`.

Interfaces:

- `new Client({baseUrl, token, timeoutMs?: number, fetch?: typeof fetch})`. `Management` and `Admin` take the same options.
- Every method's last parameter is `opts?: {signal?: AbortSignal}`.
- `class NovamemError extends Error { op; statusCode; code; unavailable; retryable; notFound; canceled }`, plus the exported functions `isUnavailable(e)`, `isRetryable(e)` and `isNotFound(e)`. Cancellation (an `AbortError` from the caller's signal) becomes `NovamemError{canceled: true}`. A timeout comes from an internal `AbortSignal.timeout(timeoutMs)` combined with the caller's signal through `AbortSignal.any`, and is distinguished from cancellation by checking which signal fired.
- `toJSON()` and `util.inspect.custom` on the client and its config return objects with `token: "[redacted]"`.

- [ ] Write the failing test `clients/typescript/test/scenarios.test.ts`:

```ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import { createInterface } from "node:readline";
import * as nm from "../src/index.js";
import { DISPATCH } from "./dispatch.js";

const CLIENTS = new URL("../../../", import.meta.url);
const SCEN = JSON.parse(
  readFileSync(new URL("contract/scenarios.json", CLIENTS), "utf8"),
);
let proc: ChildProcess,
  url = "",
  closed = "";

before(async () => {
  proc = spawn(
    "go",
    ["run", "./cmd/scenario-server", "-scenarios", "scenarios.json"],
    {
      cwd: new URL("contract/", CLIENTS),
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  const line: string = await new Promise((res) =>
    createInterface({ input: proc.stdout! }).once("line", res),
  );
  const [, u, c] = line.split(" ");
  url = u;
  closed = c.split("=")[1];
});
after(() => proc.kill());

function isEmpty(r: unknown): boolean {
  return (
    (Array.isArray(r) && r.length === 0) ||
    (typeof r === "object" &&
      r !== null &&
      Array.isArray((r as any).results) &&
      (r as any).results.length === 0)
  );
}

function classify(r: unknown, e: unknown): string {
  if (e === undefined) return isEmpty(r) ? "empty" : "ok";
  if (!(e instanceof nm.NovamemError)) throw e;
  if (e.canceled) return "canceled";
  if (e.unavailable) return "unavailable";
  if (e.notFound) return "not_found";
  return "error";
}

for (const s of SCEN.scenarios) {
  test(s.id, async () => {
    const call = s.call;
    let r: unknown, e: unknown;
    if (call.class === "ctor") {
      try {
        new nm.Client({
          baseUrl: call.args.baseUrl.replace("<server>", url),
          token: call.args.token,
        });
      } catch (err) {
        e = err;
      }
    } else {
      const base = JSON.stringify(s.respond).includes('"refused"')
        ? `http://127.0.0.1:${closed}/s/${s.id}`
        : `${url}/s/${s.id}`;
      const o = { baseUrl: base, token: SCEN.token, timeoutMs: SCEN.timeoutMs };
      const clients = {
        Client: new nm.Client(o),
        Management: new nm.Management(o),
        Admin: new nm.Admin(o),
      };
      const ac = new AbortController();
      if (call.cancelAfterMs) setTimeout(() => ac.abort(), call.cancelAfterMs);
      try {
        r = await DISPATCH[call.method](clients, call.args, ac.signal);
      } catch (err) {
        e = err;
      }
    }
    assert.equal(classify(r, e), s.expect.outcome, `${s.id}: ${String(e)}`);
    if (e) {
      const err = e as nm.NovamemError;
      assert.ok(
        !String(err).includes(SCEN.token) &&
          !inspect(err).includes(SCEN.token) &&
          !JSON.stringify(err).includes(SCEN.token),
        "token leaked",
      );
      if ("retryable" in s.expect)
        assert.equal(err.retryable ?? false, s.expect.retryable);
      if ("statusCode" in s.expect)
        assert.equal(err.statusCode, s.expect.statusCode);
      if ("code" in s.expect) assert.equal(err.code, s.expect.code);
    }
    const v = await (await fetch(`${url}/_verdict/${s.id}`)).json();
    assert.deepEqual(v.mismatches, []);
    if (Array.isArray(s.expectRequest) && s.expectRequest.length === 0)
      assert.equal(v.requests, 0);
  });
}
```

Write `clients/typescript/test/routes.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as nm from "../src/index.js";

const ROUTES = JSON.parse(
  readFileSync(
    new URL("../../../contract/routes.json", import.meta.url),
    "utf8",
  ),
);
const camel = (s: string) => s[0].toLowerCase() + s.slice(1);

// proved by: renaming Client.prototype.sessionRecap fails this test.
test("every routes.json method resolves", () => {
  for (const [key, r] of Object.entries<any>(ROUTES)) {
    for (const m of r.methods ?? []) {
      const [cls, meth] = m.name.split(".");
      assert.equal(
        typeof (nm as any)[cls].prototype[camel(meth)],
        "function",
        `${key} ${m.name}`,
      );
    }
  }
});
```

`tsconfig.test.json` sets `rootDir: "."` and `outDir: "dist-test"`, so these files run from `dist-test/test/`, and `../../../` resolves to `clients/`.

Run `cd clients/typescript && npm install && npm test`: expect FAIL with `Cannot find module '../src/index.js'` (TS2307).

- [ ] Write both templates, then run `go run ./clients/gen -spec docs/api/openapi.json -routes clients/contract/routes.json -out clients -lang typescript`: expect PASS, creating `src/types.ts` and `test/dispatch.ts`, each with the header `// Code generated by clients/gen. DO NOT EDIT.`.
- [ ] Implement `transport.ts`, with a `do(op, method, path, {body, query, expectBody, signal})` that uses `this.fetch`:
  - Read the body with a reader loop that aborts past 8388608 bytes (unavailable, `response body exceeds 8 MiB`).
  - A `TypeError` from fetch (network failure) is unavailable and retryable.
  - The timeout signal firing is unavailable and retryable, with message `timed out`.
  - The caller's signal firing is canceled.
  - Status handling follows the Constraints. Apply `replaceAll(token, "[redacted]")` to every message.
  - `since` values are accepted as `Date | string` and sent as `new Date(x).toISOString()`.
  - The constructor validates with `new URL(baseUrl)` inside try/catch, requiring protocol `http:` or `https:` and a non-empty host. It throws `new NovamemError({op: "config", message: "novamem: baseUrl is not an absolute http(s) URL"})` or `"novamem: token is required"`.
- [ ] Implement the 41 methods in `client.ts` with the special rules listed in Task 7 (forget, capture/remember, degraded, today, health, removeProjectMemberByUsername), using camelCase names and the same messages.
- [ ] Run `cd clients/typescript && npm test` on Node 20 and on Node 24: expect PASS for every scenario and the routes test.
- [ ] Mutation check: remove the degraded-empty check from `search` and re-run. Expect FAIL on `search-degraded-empty-is-unavailable` with `empty !== unavailable`. Revert.
- [ ] Check dependencies: `cd clients/typescript && npm run build && npm pack --dry-run --json | node -e 'const p=JSON.parse(require("fs").readFileSync(0))[0];process.exit(p.files.every(f=>f.path.startsWith("dist/")||["package.json","README.md","LICENSE"].includes(f.path))?0:1)'` exits 0, and `node -e 'process.exit(require("./clients/typescript/package.json").dependencies?1:0)'` exits 0.
- [ ] Write `clients/typescript/smoke.mjs`, importing `./dist/index.js`, with the same up/down steps and failure format as Task 7's `smoke.py`, prefixed `typescript`.
- [ ] Add a `typescript` job to `.github/workflows/sdk.yml`:
  - `runs-on: arc-azrtydxb-amd64`, `timeout-minutes: 15`, `needs: [generated]`.
  - A matrix of `node: [20, 24]`, using `actions/setup-node@v5` and `actions/setup-go@v6`.
  - Run: `cd clients/typescript && npm ci && npm test`.
  - Commit the `package-lock.json` produced by `npm install`.
- [ ] Commit `feat(sdk-typescript): novamem TypeScript SDK 2.0.0 held to the shared scenario suite`.

## Task 9: .NET SDK

Files:

- `clients/gen/templates/dotnet.tmpl` (created; out: `dotnet/src/Novamem/Types.g.cs`): `public sealed record` per object type, with `[JsonPropertyName("<wire>")]` on every property. Optional properties are nullable, and the class-level `[JsonConverter]` is left out; the client instead sets `JsonSerializerOptions { DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull }`. Enums are `[JsonConverter(typeof(JsonStringEnumConverter<T>))]` with `[JsonStringEnumMemberName("<wire>")]` on each member. `datetime` becomes `DateTimeOffset`, `int64` becomes `long`, and maps become `Dictionary<string, JsonElement>`.
- `clients/gen/templates/dotnet_dispatch.tmpl` (created; out: `dotnet/tests/Novamem.Tests/Dispatch.g.cs`): `static class Dispatch { public static readonly Dictionary<string, Func<Clients, JsonElement, CancellationToken, Task<object?>>> Table }`. Request-type methods deserialize `args` into the request record; scalar methods read `args.GetProperty("<p>")`.
- `clients/dotnet/Novamem.sln`, `clients/dotnet/src/Novamem/Novamem.csproj` (created: `net8.0`, `<PackageId>Novamem</PackageId>`, `<Version>0.1.0</Version>`, `<Nullable>enable</Nullable>`, no `PackageReference`)
- `clients/dotnet/src/Novamem/NovamemException.cs`, `Transport.cs`, `Client.cs`, `Management.cs`, `Admin.cs`, `NovamemOptions.cs` (created)
- `clients/dotnet/tests/Novamem.Tests/Novamem.Tests.csproj` (created: `net8.0`, with `PackageReference` entries for `Microsoft.NET.Test.Sdk` 17.14.1, `xunit` 2.9.3 and `xunit.runner.visualstudio` 3.1.4 — test-only)
- `clients/dotnet/tests/Novamem.Tests/ScenarioTests.cs`, `RouteTests.cs` (created)
- `clients/dotnet/smoke/Smoke.csproj`, `clients/dotnet/smoke/Program.cs` (created)

Interfaces:

- `new Client(new NovamemOptions { BaseUrl = "...", Token = "...", Timeout = TimeSpan.FromSeconds(15), HttpClient = null })`. `Management` and `Admin` take the same options. Construction throws `ArgumentException` whose message names the field and never contains the value.
- `NovamemException : Exception` with `Op`, `StatusCode`, `Code`, `IsUnavailable`, `IsRetryable` and `IsNotFound`. Caller cancellation surfaces as `OperationCanceledException`, never wrapped. A timeout is `NovamemException { IsUnavailable = true, IsRetryable = true, Message = "novamem <op>: timed out" }`, told apart from cancellation by checking `ct.IsCancellationRequested` in the catch.
- `NovamemOptions.ToString()` returns `NovamemOptions { BaseUrl = <url>, Token = [redacted] }`.

- [ ] Write the failing test `clients/dotnet/tests/Novamem.Tests/ScenarioTests.cs`:

```csharp
using System.Diagnostics;
using System.Net.Http.Json;
using System.Text.Json;
using Xunit;

namespace Novamem.Tests;

public sealed class ScenarioServer : IDisposable
{
    public readonly string Url, Closed;
    readonly Process _p;
    public ScenarioServer()
    {
        var contract = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../../contract"));
        _p = Process.Start(new ProcessStartInfo("sh", "scenario-server.sh -scenarios scenarios.json")
            { WorkingDirectory = contract, RedirectStandardOutput = true })!;
        var parts = _p.StandardOutput.ReadLine()!.Split(' ');
        Url = parts[1]; Closed = parts[2].Split('=')[1];
    }
    public void Dispose() => _p.Kill(true);
}

public sealed class ScenarioTests(ScenarioServer srv) : IClassFixture<ScenarioServer>
{
    static readonly JsonElement Scen = JsonDocument.Parse(File.ReadAllText(Path.GetFullPath(
        Path.Combine(AppContext.BaseDirectory, "../../../../../../contract/scenarios.json")))).RootElement;
    static string Token => Scen.GetProperty("token").GetString()!;

    public static IEnumerable<object[]> Ids() =>
        Scen.GetProperty("scenarios").EnumerateArray().Select(s => new object[] { s.GetProperty("id").GetString()! });

    static bool IsEmpty(object? r)
    {
        var el = JsonSerializer.SerializeToElement(r);
        return (el.ValueKind == JsonValueKind.Array && el.GetArrayLength() == 0) ||
               (el.ValueKind == JsonValueKind.Object && el.TryGetProperty("results", out var res) && res.GetArrayLength() == 0);
    }

    // proved by: removing the degraded-empty check in Client.SearchAsync fails search-degraded-empty-is-unavailable.
    [Theory, MemberData(nameof(Ids))]
    public async Task TestScenarios(string id)
    {
        var s = Scen.GetProperty("scenarios").EnumerateArray().First(x => x.GetProperty("id").GetString() == id);
        var call = s.GetProperty("call");
        object? result = null; Exception? err = null;
        if (call.GetProperty("class").GetString() == "ctor")
        {
            var a = call.GetProperty("args");
            try { _ = new Client(new NovamemOptions { BaseUrl = a.GetProperty("baseUrl").GetString()!.Replace("<server>", srv.Url), Token = a.GetProperty("token").GetString()! }); }
            catch (Exception e) { err = e; }
        }
        else
        {
            var baseUrl = s.GetProperty("respond").GetRawText().Contains("\"refused\"")
                ? $"http://127.0.0.1:{srv.Closed}/s/{id}" : $"{srv.Url}/s/{id}";
            var o = new NovamemOptions { BaseUrl = baseUrl, Token = Token, Timeout = TimeSpan.FromMilliseconds(Scen.GetProperty("timeoutMs").GetInt32()) };
            var clients = new Clients(new Client(o), new Management(o), new Admin(o));
            using var cts = new CancellationTokenSource();
            if (call.TryGetProperty("cancelAfterMs", out var c)) cts.CancelAfter(c.GetInt32());
            try { result = await Dispatch.Table[call.GetProperty("method").GetString()!](clients, call.GetProperty("args"), cts.Token); }
            catch (Exception e) { err = e; }
        }
        var outcome = err switch
        {
            null => IsEmpty(result) ? "empty" : "ok",
            OperationCanceledException => "canceled",
            NovamemException { IsUnavailable: true } => "unavailable",
            NovamemException { IsNotFound: true } => "not_found",
            _ => "error",
        };
        var exp = s.GetProperty("expect");
        Assert.Equal(exp.GetProperty("outcome").GetString(), outcome);
        if (err is not null)
        {
            Assert.DoesNotContain(Token, err.ToString());
            if (err is NovamemException ne)
            {
                if (exp.TryGetProperty("retryable", out var r)) Assert.Equal(r.GetBoolean(), ne.IsRetryable);
                if (exp.TryGetProperty("statusCode", out var sc)) Assert.Equal(sc.GetInt32(), ne.StatusCode);
                if (exp.TryGetProperty("code", out var code)) Assert.Equal(code.GetString(), ne.Code);
            }
        }
        using var http = new HttpClient();
        var v = await http.GetFromJsonAsync<JsonElement>($"{srv.Url}/_verdict/{id}");
        Assert.Equal(0, v.GetProperty("mismatches").GetArrayLength());
        if (s.TryGetProperty("expectRequest", out var er) && er.ValueKind == JsonValueKind.Array && er.GetArrayLength() == 0)
            Assert.Equal(0, v.GetProperty("requests").GetInt32());
    }
}
```

Write `RouteTests.cs`:

```csharp
using System.Text.Json;
using Xunit;

namespace Novamem.Tests;

public class RouteTests
{
    // proved by: renaming Client.SessionRecapAsync fails this test.
    [Fact]
    public void TestEveryRouteIsAccounted()
    {
        var routes = JsonDocument.Parse(File.ReadAllText(Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../../contract/routes.json")))).RootElement;
        foreach (var route in routes.EnumerateObject())
        {
            if (!route.Value.TryGetProperty("methods", out var ms)) continue;
            foreach (var m in ms.EnumerateArray())
            {
                var parts = m.GetProperty("name").GetString()!.Split('.');
                var type = typeof(Client).Assembly.GetType("Novamem." + parts[0])!;
                Assert.True(type.GetMethod(parts[1] + "Async") is not null, $"{route.Name} {parts[0]}.{parts[1]}Async");
            }
        }
    }
}
```

`Clients` is a `public sealed record Clients(Client Client, Management Management, Admin Admin);` emitted by the dispatch template.

Run `cd clients/dotnet && dotnet test`: expect FAIL with `error CS0246: The type or namespace name 'NovamemOptions' could not be found`.

- [ ] Write both templates, then run `go run ./clients/gen -spec docs/api/openapi.json -routes clients/contract/routes.json -out clients -lang dotnet`: expect PASS, creating `Types.g.cs` and `Dispatch.g.cs`, each with the header `// <auto-generated>Code generated by clients/gen. DO NOT EDIT.</auto-generated>`.
- [ ] Implement `Transport.cs` using `HttpClient`, with a per-call `CancellationTokenSource.CreateLinkedTokenSource(ct)` plus `CancelAfter(timeout)`:
  - Read the body with `ReadAsStreamAsync` into a buffer capped at 8388609 bytes.
  - `HttpRequestException` is unavailable and retryable.
  - `TaskCanceledException` or `OperationCanceledException` is canceled when `ct.IsCancellationRequested`, and otherwise unavailable and retryable (`timed out`).
  - `JsonException` is unavailable, `malformed response body`.
  - Status handling follows the Constraints, and every message is redacted with `Replace(token, "[redacted]")`.
  - The default `HttpClient` is created per client instance with `new HttpClient(new SocketsHttpHandler { PooledConnectionLifetime = TimeSpan.FromMinutes(2) }) { Timeout = Timeout.InfiniteTimeSpan }`.
- [ ] Implement the 41 `…Async` methods with the special rules from Task 7, using .NET names (`ForgetAsync`, `TodayAsync`, `RemoveProjectMemberByUsernameAsync`).
- [ ] Run `cd clients/dotnet && dotnet test`: expect PASS for all theories and `TestEveryRouteIsAccounted`.
- [ ] Mutation check: remove the redaction and re-run. Expect FAIL on `token-echoed-in-401-is-redacted`. Revert.
- [ ] Check dependencies: `dotnet list clients/dotnet/src/Novamem/Novamem.csproj package` prints `No packages were found for this project.`
- [ ] Write `clients/dotnet/smoke/Program.cs` (up/down, prefix `dotnet`), referencing `../src/Novamem/Novamem.csproj`.
- [ ] Add a `dotnet` job to `.github/workflows/sdk.yml`: `runs-on: arc-azrtydxb-amd64`, `timeout-minutes: 15`, `needs: [generated]`, using `actions/setup-dotnet@v5` with `dotnet-version: 8.0.x` and `actions/setup-go@v6`. Run: `cd clients/dotnet && dotnet test`.
- [ ] Commit `feat(sdk-dotnet): Novamem .NET SDK held to the shared scenario suite`.

## Task 10: Java SDK

Files:

- `clients/gen/templates/java.tmpl` (created; out: `java/src/main/java/com/azrtydxb/novamem/types/Types.java`). One file holds `public final class Types` with a `public record` per object type, annotated `@JsonInclude(JsonInclude.Include.NON_NULL)` and `@JsonIgnoreProperties(ignoreUnknown = true)`, with `@JsonProperty("<wire>")` on each component. Enums use `@JsonValue` on the wire string, plus an `UNKNOWN` constant marked `@JsonEnumDefaultValue` so a value this version does not know still reads. Every record carries a `builder()` / `toBuilder()`. Required fields are `@JsonInclude(ALWAYS)` (and `required = true` when not nullable); optional strings are `NON_EMPTY`. The directive names `fmt: google-java-format`: the generator pipes the output through it, because gjf lays lines out by length and no template can match it alone. `datetime` becomes `java.time.Instant`, `int64` becomes `Long`, `int32` becomes `Integer`, and maps become `Map<String, Object>`. All records are nested in one generated file, so the generator writes one path per language. That file matches the spec's `types/*.java` path.
- `clients/gen/templates/java_dispatch.tmpl` (created; out: `java/src/test/java/com/azrtydxb/novamem/Dispatch.java`): `static final Map<String, Dispatch.Fn> TABLE` and the nested `record Clients(Client client, Management management, Admin admin)`, where `interface Fn { Object call(Clients c, JsonNode args, boolean async, long cancelAfterMs) throws Exception; }`. With `async` set it calls the `…Async` variant, cancels the future after `cancelAfterMs` when that's above 0, then calls `join()`.
- `clients/java/pom.xml` (created):
  - `groupId com.azrtydxb`, `artifactId novamem`, `version 0.1.0`, `maven.compiler.release 17`.
  - Dependency `com.fasterxml.jackson.core:jackson-databind:2.22.3` (plus `jackson-datatype-jsr310` is NOT added; `Instant` is serialised through a small hand-written serializer and deserializer registered on the client's `ObjectMapper`, which keeps the one-dependency rule).
  - Test dependency `org.junit.jupiter:junit-jupiter:5.13.4`.
  - Plugins `maven-surefire-plugin:3.5.3`, `maven-source-plugin:3.3.1`, `maven-javadoc-plugin:3.11.2`, `maven-gpg-plugin:3.2.8` and `org.sonatype.central:central-publishing-maven-plugin:0.8.0`, the last two in a `release` profile only.
- `clients/java/src/main/java/com/azrtydxb/novamem/{Client,Management,Admin,NovamemConfig,NovamemException,Transport,InstantCodec}.java` (created)
- `clients/java/src/test/java/com/azrtydxb/novamem/{ScenarioTest,RouteTest,TransportTest}.java` (created). TransportTest covers what no shared scenario reaches: a body that stalls after its headers still times out, cancelling a mapped future cancels its source, and a network-path `Location` is another origin.
- `clients/java/src/test/java/com/azrtydxb/novamem/Smoke.java` (created; run as `java -cp "$(cat cp.txt):target/classes:target/test-classes" com.azrtydxb.novamem.Smoke <up|down>`, where `cp.txt` comes from `mvn -q dependency:build-classpath -Dmdep.outputFile=cp.txt`)

Interfaces:

- `new Client(NovamemConfig.builder().baseUrl(...).token(...).timeout(Duration.ofSeconds(15)).httpClient(null).build())`. `build()` throws `IllegalArgumentException` naming the field. `Management` and `Admin` take the same config.
- Each method exists as a sync version (`search(SearchRequest)`) and an async version (`searchAsync(SearchRequest)` returning `CompletableFuture<SearchResult>`).
- `NovamemException extends RuntimeException` with `op()`, `statusCode()`, `code()`, `isUnavailable()`, `isRetryable()` and `isNotFound()`. Cancelling the async future surfaces as `java.util.concurrent.CancellationException`.
- `NovamemConfig.toString()` returns `NovamemConfig[baseUrl=<url>, token=[redacted]]`.

- [ ] Write the failing test `ScenarioTest.java`:

```java
package com.azrtydxb.novamem;

import static org.junit.jupiter.api.Assertions.*;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Path;
import java.time.Duration;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletionException;
import java.util.stream.Stream;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;

class ScenarioTest {
  static final ObjectMapper M = new ObjectMapper();
  static final Path CONTRACT = Path.of("..", "contract").toAbsolutePath().normalize();
  static JsonNode scen;
  static Process proc;
  static String url, closed;

  @BeforeAll
  static void start() throws Exception {
    scen = M.readTree(CONTRACT.resolve("scenarios.json").toFile());
    proc = new ProcessBuilder("sh", "scenario-server.sh", "-scenarios", "scenarios.json")
        .directory(CONTRACT.toFile()).redirectError(ProcessBuilder.Redirect.INHERIT).start();
    String[] parts = new BufferedReader(new InputStreamReader(proc.getInputStream())).readLine().split(" ");
    url = parts[1];
    closed = parts[2].split("=")[1];
  }

  @AfterAll
  static void stop() { proc.destroyForcibly(); }

  static Stream<String> ids() throws Exception {
    JsonNode s = M.readTree(CONTRACT.resolve("scenarios.json").toFile()).get("scenarios");
    return Stream.iterate(0, i -> i < s.size(), i -> i + 1).map(i -> s.get(i).get("id").asText());
  }

  static boolean isEmpty(Object r) {
    JsonNode n = M.valueToTree(r);
    return (n.isArray() && n.isEmpty()) || (n.isObject() && n.has("results") && n.get("results").isEmpty());
  }

  // proved by: removing the degraded-empty check from Client.search fails search-degraded-empty-is-unavailable.
  @ParameterizedTest
  @MethodSource("ids")
  void testScenarios(String id) throws Exception {
    JsonNode s = null;
    for (JsonNode x : scen.get("scenarios")) if (x.get("id").asText().equals(id)) s = x;
    JsonNode call = s.get("call");
    String token = scen.get("token").asText();
    Object result = null;
    Throwable err = null;
    if (call.get("class").asText().equals("ctor")) {
      JsonNode a = call.get("args");
      try {
        new Client(NovamemConfig.builder().baseUrl(a.get("baseUrl").asText().replace("<server>", url)).token(a.get("token").asText()).build());
      } catch (Exception e) { err = e; }
    } else {
      String base = s.get("respond").toString().contains("\"refused\"")
          ? "http://127.0.0.1:" + closed + "/s/" + id : url + "/s/" + id;
      NovamemConfig cfg = NovamemConfig.builder().baseUrl(base).token(token)
          .timeout(Duration.ofMillis(scen.get("timeoutMs").asLong())).build();
      Dispatch.Clients c = new Dispatch.Clients(new Client(cfg), new Management(cfg), new Admin(cfg));
      boolean cancel = call.has("cancelAfterMs");
      try {
        result = Dispatch.TABLE.get(call.get("method").asText())
            .call(c, call.get("args"), cancel, cancel ? call.get("cancelAfterMs").asLong() : 0);
      } catch (CompletionException e) { err = e.getCause(); } catch (Exception e) { err = e; }
    }
    String outcome =
        err == null ? (isEmpty(result) ? "empty" : "ok")
        : err instanceof CancellationException ? "canceled"
        : err instanceof NovamemException ne && ne.isUnavailable() ? "unavailable"
        : err instanceof NovamemException ne2 && ne2.isNotFound() ? "not_found"
        : "error";
    JsonNode exp = s.get("expect");
    assertEquals(exp.get("outcome").asText(), outcome, id + ": " + err);
    if (err != null) {
      assertFalse(String.valueOf(err).contains(token), "token leaked");
      if (err instanceof NovamemException ne) {
        if (exp.has("retryable")) assertEquals(exp.get("retryable").asBoolean(), ne.isRetryable());
        if (exp.has("statusCode")) assertEquals(exp.get("statusCode").asInt(), ne.statusCode());
        if (exp.has("code")) assertEquals(exp.get("code").asText(), ne.code());
      }
    }
    HttpResponse<String> v = HttpClient.newHttpClient().send(
        HttpRequest.newBuilder(URI.create(url + "/_verdict/" + id)).build(), HttpResponse.BodyHandlers.ofString());
    JsonNode verdict = M.readTree(v.body());
    assertEquals(0, verdict.get("mismatches").size(), verdict.toString());
    if (s.has("expectRequest") && s.get("expectRequest").isArray() && s.get("expectRequest").isEmpty())
      assertEquals(0, verdict.get("requests").asInt());
  }
}
```

The scenarios with `requires: ["cancel"]` run through the async variant; every other scenario runs through the sync variant. The dispatch template chooses by the `async` flag. `junit-jupiter-params` comes with the `junit-jupiter` aggregate artifact.

Write `RouteTest.java`:

```java
package com.azrtydxb.novamem;

import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Path;
import java.util.Arrays;
import org.junit.jupiter.api.Test;

class RouteTest {
  // proved by: renaming Client.sessionRecap fails this test.
  @Test
  void testEveryRouteIsAccounted() throws Exception {
    JsonNode routes = new ObjectMapper().readTree(Path.of("..", "contract", "routes.json").toFile());
    for (var it = routes.fields(); it.hasNext(); ) {
      var e = it.next();
      if (!e.getValue().has("methods")) continue;
      for (JsonNode m : e.getValue().get("methods")) {
        String[] p = m.get("name").asText().split("\\.");
        Class<?> cls = Class.forName("com.azrtydxb.novamem." + p[0]);
        String name = Character.toLowerCase(p[1].charAt(0)) + p[1].substring(1);
        // "import" is a Java keyword (clients/gen javamethod).
        name = name.equals("import") ? "importEntries" : name;
        for (String n : new String[] {name, name + "Async"})
          assertTrue(Arrays.stream(cls.getMethods()).anyMatch(x -> x.getName().equals(n)), e.getKey() + " " + p[0] + "." + n);
      }
    }
  }
}
```

Run `cd clients/java && mvn -B verify`: expect FAIL with `cannot find symbol` / `class NovamemConfig`.

- [ ] Write both templates, then run `go run ./clients/gen -spec docs/api/openapi.json -routes clients/contract/routes.json -out clients -lang java`: expect PASS, creating `Types.java` and `Dispatch.java`, each with the header `// Code generated by clients/gen. DO NOT EDIT.`.
- [ ] Implement `Transport.java` using `java.net.http.HttpClient`, with `HttpRequest.timeout(cfg.timeout())` and `BodyHandlers.ofInputStream()`, reading at most 8388609 bytes:
  - `HttpTimeoutException` is unavailable and retryable (`timed out`).
  - `IOException` is unavailable and retryable.
  - `JsonProcessingException` is unavailable (`malformed response body`).
  - Status handling follows the Constraints, and every message is redacted.
  - Every call is async at the core (`sendAsync`); the blocking method waits on the async one. The body is read by a `BodySubscriber` that cancels once 8 MiB is crossed. The call's own deadline (HttpRequest.timeout stops at the headers) completes the future with `timed out`. Redirects are followed by hand with `Redirect.NEVER`. Cancelling the returned future — or any future mapped from it through `Base.then` — cancels the exchange in flight.
  - `Management.Import` is `importEntries` (`import` is a Java keyword; clients/gen `javamethod`).
- [ ] Implement the 41 methods, sync and async, with the special rules from Task 7 and camelCase names.
- [ ] Run `cd clients/java && mvn -B verify` on Java 17 and Java 21: expect PASS (`Tests run: <n>, Failures: 0, Errors: 0`).
- [ ] Mutation check: remove the 404 handling in `forget` and re-run. Expect FAIL on `forget-404-not-deleted` (`expected: <ok> but was: <not_found>`). Revert.
- [ ] Check dependencies: `mvn -B dependency:tree -Dscope=runtime -DoutputType=text` lists only `jackson-databind`, `jackson-core` and `jackson-annotations` under `com.azrtydxb:novamem`.
- [ ] Write `Smoke.java` (up/down, prefix `java`).
- [ ] Add a `java` job to `.github/workflows/sdk.yml`:
  - `runs-on: arc-azrtydxb-amd64`, `timeout-minutes: 20`, `needs: [generated]`.
  - A matrix of `java: [17, 21]`, run in the `maven:3.9-eclipse-temurin-<java>` image (the runner has no Maven), plus `actions/setup-go`.
  - The `generated` job installs google-java-format 1.36.1 (the version Homebrew ships), because `-check` runs the Java templates through it.
  - Run: `cd clients/java && mvn -B verify`.
- [ ] Commit `feat(sdk-java): novamem Java SDK held to the shared scenario suite`.

## Task 11: Rust SDK

Status: built on `feat/sdk-rust`. Where the build differs from the steps below, the build is right:

- reqwest is pinned to 0.12.28 with only `rustls-tls`. 0.13 needs Rust 1.85 and defaults to `aws-lc-rs`, which requires cmake. The `json` feature isn't needed, since bodies are serde_json bytes. Runtime dependencies are exactly reqwest, serde, serde_json, thiserror and tokio (a CI step checks this).
- The generated dispatch table lives at `tests/dispatch/mod.rs`, because Cargo compiles every top-level file in `tests/` as its own crate. Both it and `src/types.rs` are `#[rustfmt::skip]`.
- Scalar params come from routes.json's typed `params` (`{name, type, required}`, added on this branch for the statically typed SDKs): required strings are `&str`, optional ones `Option<&str>`, numbers `Option<i32|i64>`, and `Import` takes `Vec<serde_json::Value>`.
- Cross-origin redirects rely on reqwest, which strips `Authorization` when the host changes; `tests/redirect.rs` pins that behaviour.
- The two cancel scenarios are skipped, because dropping a Rust future leaves no outcome to classify.

Files:

- `clients/gen/templates/rust.tmpl` (created; out: `rust/src/types.rs`): `#[derive(Debug, Clone, Default, Serialize, Deserialize)]` structs with `#[serde(rename = "<wire>")]` per field. Optional fields are `Option<T>` with `#[serde(skip_serializing_if = "Option::is_none")]`. Enums use `#[serde(rename_all …)]` per variant `rename`. `datetime` becomes `String` (RFC 3339; the client formats it with a hand-written UTC formatter in `src/time.rs`, so no `chrono` dependency is added). `int64` becomes `i64`, `int32` becomes `i32`, and maps become `serde_json::Map<String, serde_json::Value>`.
- `clients/gen/templates/rust_dispatch.tmpl` (created; out: `rust/tests/dispatch.rs`): `pub async fn dispatch(c: &Clients, method: &str, args: &serde_json::Value) -> Result<serde_json::Value, novamem::Error>` with one match arm per `routes.json` method, deserialising `args` into the request type or reading scalars, and serialising the result to `serde_json::Value`.
- `clients/rust/Cargo.toml` (created):
  - `name = "novamem"`, `version = "0.1.0"`, `edition = "2021"`, `rust-version = "1.80"`, `license = "Apache-2.0"`.
  - Dependencies: `reqwest = { version = "0.12", default-features = false, features = ["rustls-tls", "json"] }`, `serde = { version = "1", features = ["derive"] }`, `serde_json = "1"`, `tokio = { version = "1", features = ["rt-multi-thread", "time"] }`, `thiserror = "2"`.
  - Dev-dependencies: `tokio = { version = "1", features = ["macros", "rt-multi-thread", "process", "io-util", "time"] }`.
  - Commit `Cargo.lock`.
- `clients/rust/src/{lib.rs,error.rs,transport.rs,client.rs,management.rs,admin.rs,time.rs}` (created)
- `clients/rust/tests/scenarios.rs`, `clients/rust/tests/routes.rs` (created)
- `clients/rust/examples/smoke.rs` (created)

Interfaces:

- `Client::new(Config { base_url: String, token: String, timeout: Option<Duration>, http: Option<reqwest::Client> }) -> Result<Client, Error>`. `Management::new` and `Admin::new` have the same signature.
- `#[derive(thiserror::Error)] pub struct Error { op: String, status: u16, code: String, message: String, unavailable: bool, retryable: bool, not_found: bool }`, with accessors `op()`, `status()`, `code()`, `is_unavailable()`, `is_retryable()` and `is_not_found()`. `Display` renders `novamem <op>: <status> [<code>]: <message>`. `Debug` is implemented by hand and prints the same fields; no token is ever stored in `Error`. `Config`'s `Debug` prints `token: "[redacted]"`.
- Every method is `pub async fn <snake>(&self, …) -> Result<T, Error>`.
- The C SDK (Task 12) depends on: every public method, the `Clients`-free constructors, and `types.rs`.

- [ ] Write the failing test `clients/rust/tests/scenarios.rs`:

```rust
mod dispatch;

use novamem::{Admin, Client, Config, Management};
use serde_json::Value;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

pub struct Clients {
    pub client: Client,
    pub management: Management,
    pub admin: Admin,
}

fn contract() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../contract")
}

fn is_empty(v: &Value) -> bool {
    v.as_array().map_or(false, |a| a.is_empty())
        || v.get("results").and_then(|r| r.as_array()).map_or(false, |a| a.is_empty())
}

// proved by: removing the degraded-empty check in Client::search fails search-degraded-empty-is-unavailable.
#[tokio::test(flavor = "multi_thread")]
async fn test_scenarios() {
    let scen: Value = serde_json::from_str(&std::fs::read_to_string(contract().join("scenarios.json")).unwrap()).unwrap();
    let token = scen["token"].as_str().unwrap().to_string();
    let timeout = Duration::from_millis(scen["timeoutMs"].as_u64().unwrap());
    let mut child = Command::new("sh")
        .args(["scenario-server.sh", "-scenarios", "scenarios.json"])
        .current_dir(contract())
        .stdout(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap()).read_line(&mut line).await.unwrap();
    let parts: Vec<&str> = line.split_whitespace().collect();
    let (url, closed) = (parts[1].to_string(), parts[2].trim_start_matches("closed=").to_string());
    let http = reqwest::Client::new();
    let mut failures = Vec::new();

    for s in scen["scenarios"].as_array().unwrap() {
        let id = s["id"].as_str().unwrap();
        let call = &s["call"];
        if s["requires"].as_array().map_or(false, |r| r.iter().any(|x| x == "cancel")) {
            println!("skip (rust has no cancellation outcome): {id}");
            continue;
        }
        let outcome: (String, Option<novamem::Error>) = if call["class"] == "ctor" {
            let a = &call["args"];
            let r = Client::new(Config {
                base_url: a["baseUrl"].as_str().unwrap().replace("<server>", &url),
                token: a["token"].as_str().unwrap().into(),
                timeout: None,
                http: None,
            });
            match r { Ok(_) => ("ok".into(), None), Err(e) => ("error".into(), Some(e)) }
        } else {
            let base = if s["respond"].to_string().contains("\"refused\"") {
                format!("http://127.0.0.1:{closed}/s/{id}")
            } else {
                format!("{url}/s/{id}")
            };
            let cfg = || Config { base_url: base.clone(), token: token.clone(), timeout: Some(timeout), http: None };
            let c = Clients {
                client: Client::new(cfg()).unwrap(),
                management: Management::new(cfg()).unwrap(),
                admin: Admin::new(cfg()).unwrap(),
            };
            match dispatch::dispatch(&c, call["method"].as_str().unwrap(), &call["args"]).await {
                Ok(v) => (if is_empty(&v) { "empty" } else { "ok" }.into(), None),
                Err(e) if e.is_unavailable() => ("unavailable".into(), Some(e)),
                Err(e) if e.is_not_found() => ("not_found".into(), Some(e)),
                Err(e) => ("error".into(), Some(e)),
            }
        };
        let exp = &s["expect"];
        if outcome.0 != exp["outcome"].as_str().unwrap() {
            failures.push(format!("{id}: outcome {} (err {:?}), want {}", outcome.0, outcome.1, exp["outcome"]));
        }
        if let Some(e) = &outcome.1 {
            if e.to_string().contains(&token) || format!("{e:?}").contains(&token) {
                failures.push(format!("{id}: token leaked"));
            }
            if let Some(r) = exp["retryable"].as_bool() {
                if e.is_retryable() != r { failures.push(format!("{id}: retryable {}", e.is_retryable())); }
            }
            if let Some(sc) = exp["statusCode"].as_u64() {
                if e.status() as u64 != sc { failures.push(format!("{id}: status {}", e.status())); }
            }
            if let Some(code) = exp["code"].as_str() {
                if e.code() != code { failures.push(format!("{id}: code {}", e.code())); }
            }
        }
        let v: Value = http.get(format!("{url}/_verdict/{id}")).send().await.unwrap().json().await.unwrap();
        if !v["mismatches"].as_array().unwrap().is_empty() {
            failures.push(format!("{id}: mismatches {}", v["mismatches"]));
        }
        if s["expectRequest"].as_array().map_or(false, |a| a.is_empty()) && v["requests"] != 0 {
            failures.push(format!("{id}: expected no request"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
```

The generated `tests/dispatch.rs` refers to `crate::Clients` (the struct defined in `scenarios.rs`), so the template emits `use super::Clients;`.

Add `reqwest` to `[dev-dependencies]` as well. It's already a normal dependency, so this adds nothing to the tree.

Write `clients/rust/tests/routes.rs`. Rust has no runtime reflection, so this test checks that the generated dispatch table has one arm per `routes.json` method name. The dispatch file only compiles if each arm's method exists, so a missing method is a compile error in `cargo test`.

```rust
use serde_json::Value;

// proved by: deleting an arm from tests/dispatch.rs, or renaming Client::session_recap, fails this test or its compilation.
#[test]
fn test_every_route_is_accounted() {
    let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let routes: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("../contract/routes.json")).unwrap()).unwrap();
    let table = std::fs::read_to_string(dir.join("tests/dispatch.rs")).unwrap();
    for (key, r) in routes.as_object().unwrap() {
        for m in r["methods"].as_array().into_iter().flatten() {
            let name = m["name"].as_str().unwrap();
            assert!(table.contains(&format!("\"{name}\" =>")), "{key}: no dispatch arm for {name}");
        }
    }
}
```

Run `cd clients/rust && cargo test`: expect FAIL with `error[E0432]: unresolved import novamem::Client`.

- [ ] Write both templates, then run `go run ./clients/gen -spec docs/api/openapi.json -routes clients/contract/routes.json -out clients -lang rust`: expect PASS, creating `src/types.rs` and `tests/dispatch.rs`, each with the header `// Code generated by clients/gen. DO NOT EDIT.`.
- [ ] Implement `transport.rs` with `reqwest`:
  - Wrap each call in `tokio::time::timeout(self.timeout, …)`; elapsed is unavailable and retryable (`timed out`).
  - `reqwest::Error` from `send()` is unavailable and retryable.
  - Stream the body with `resp.chunk()` into a `Vec`, bailing once it exceeds 8388608 bytes.
  - `serde_json::Error` is unavailable (`malformed response body`).
  - Status handling follows the Constraints, and every message is redacted.
  - The default `reqwest::Client` is built with `reqwest::Client::builder().use_rustls_tls().build()`.
- [ ] Implement the 41 async methods with the special rules from Task 7 and snake_case names.
- [ ] Run `cd clients/rust && cargo +1.80 test && cargo +stable test`: expect PASS for `test_scenarios` and `test_every_route_is_accounted`.
- [ ] Mutation check: remove the redaction and re-run. Expect FAIL with `token-echoed-in-401-is-redacted: token leaked`. Revert.
- [ ] Check dependencies: `cargo tree --depth 1 -e normal --prefix none | sort -u` prints exactly `novamem v0.1.0`, `reqwest v0.12.*`, `serde v1.*`, `serde_json v1.*`, `thiserror v2.*` and `tokio v1.*`.
- [ ] Write `examples/smoke.rs` (up/down, prefix `rust`), run as `cargo run --example smoke -- up`.
- [ ] Add a `rust` job to `.github/workflows/sdk.yml`:
  - `runs-on: arc-azrtydxb-amd64`, `timeout-minutes: 20`, `needs: [generated]`.
  - A matrix of `toolchain: ["1.80", stable]`, using `dtolnay/rust-toolchain@master` with `toolchain: ${{ matrix.toolchain }}`, plus `actions/setup-go@v6`.
  - Run: `cd clients/rust && cargo test --locked`.
- [ ] Commit `feat(sdk-rust): novamem Rust SDK held to the shared scenario suite`.

## Task 12: C and C++ SDK over the Rust crate

Status: built on `feat/sdk-c`. Where the build differs from the steps below, the build is right:

- No cbindgen. `clients/gen` generates the C header (`c_header.tmpl`), the Rust `#[repr(C)]` mirror (`rust_ffi.tmpl`), the 41 C functions plus the test entry point (`rust_ffi_methods.tmpl`), and the C++ wrapper (`cpp.tmpl`), all from one model. The C and Rust sides therefore can't disagree about layout, and nothing extra runs at build time.
- `Model.CKind` maps every field to one of ten shapes: `str`/`enum`/`json` are `char*`; `i32`/`i64`/`f64`/`bool` get a `has_` flag when optional; `obj` is a struct pointer; `arr_str` and `arr_obj` are a pointer plus `_len`. Names that are C or C++ keywords take a trailing underscore (`namespace_`, `export_`).
- `novamem-ffi` is a member of the root Cargo workspace, and the Makefile links `target/release/libnovamem_ffi.a`. The C job runs in a `rust:1-bookworm` container so valgrind installs without sudo.
- The vcpkg port and Conan recipe move to Task 17: they need a release archive's SHA-512, and placeholder hashes would be wrong.
- Leaks were checked locally with macOS `leaks` (0 leaks on search, export, list-users and session-recap round trips; disabling `novamem_search_result_free` → "3 leaks for 144 total leaked bytes"). valgrind runs in CI.

Files:

- `clients/gen/templates/rust_ffi.tmpl` (created; out: `c/novamem-ffi/src/types_ffi.rs`):
  - A `#[repr(C)]` mirror struct `novamem_<snake type>` per IR object type. Strings become `*mut c_char`; optional fields add a `has_<field>: bool` flag; arrays become `{ ptr: *mut T, len: usize }` structs named `novamem_<snake type>_array`; maps and `any` become `*mut c_char` holding JSON text.
  - `impl From<&types::X> for novamem_x` and `fn to_rust(&novamem_x_request) -> types::XRequest`.
  - `#[no_mangle] pub extern "C" fn novamem_<snake type>_free(p: *mut novamem_<snake type>)`.
- `clients/gen/templates/rust_ffi_methods.tmpl` (created; out: `c/novamem-ffi/src/methods_ffi.rs`): for each of the 41 methods, `#[no_mangle] pub extern "C" fn novamem_<class>_<snake method>(h: *const novamem_<class>, <request or scalars>, out: *mut *mut novamem_<response>, err: *mut novamem_error) -> novamem_status`. The body calls `RUNTIME.block_on(h.inner.<method>(…))`, and converts either the `Ok` value into a boxed mirror or the `Err` into `*err`. No-payload methods omit `out`.
- `clients/c/novamem-ffi/Cargo.toml` (created: `crate-type = ["staticlib", "cdylib"]`, depending on `novamem = { path = "../../rust" }`, `tokio`, `serde_json`, with feature `test-dispatch = []` and build-dependency `cbindgen = "0.29"`)
- `clients/c/novamem-ffi/build.rs` (created: runs cbindgen with `language = "C"`, `include_guard = "NOVAMEM_H"` and `cpp_compat = true`, writing `../include/novamem.h` and `../include/novamem_types.h`)
- `clients/c/novamem-ffi/src/lib.rs` (created: the lazy global `RUNTIME: tokio::runtime::Runtime` via `std::sync::OnceLock`, handle types, `novamem_error`, `novamem_status`, constructors and destructors)
- `clients/c/include/novamem.hpp` (created: a header-only C++17 wrapper with RAII handle classes `novamem::Client`, `novamem::Management` and `novamem::Admin`. Each method calls the C function and throws `novamem::Error`, which carries the same fields as `novamem_error`, when the status is `NOVAMEM_ERR`.)
- `clients/c/tests/scenarios.c`, `clients/c/tests/scenarios.cpp`, `clients/c/tests/routes.sh` (created)
- `clients/c/Makefile` (created: targets `lib`, `test`, `memcheck` and `smoke`)
- `clients/c/smoke.c` (created)
- `clients/c/port/vcpkg/portfile.cmake`, `clients/c/port/vcpkg/vcpkg.json`, `clients/c/port/conan/conanfile.py` (created; these download the GitHub-release archive for the tag and install `include/` and `lib/`)

Interfaces:

- C API:
  - `novamem_client *novamem_client_new(const char *base_url, const char *token, uint32_t timeout_ms, novamem_error *err)`; it returns NULL and fills `err` on invalid config. `novamem_management_new` and `novamem_admin_new` have the same shape.
  - `void novamem_client_free(novamem_client *)`, and likewise for the other handles.
  - `typedef struct { char op[64]; int32_t status_code; char code[64]; char message[512]; bool unavailable, retryable, not_found, canceled; } novamem_error;`. Fixed buffers mean `novamem_error` never needs freeing. The message is truncated to 511 bytes plus NUL, after redaction.
  - `typedef enum { NOVAMEM_OK = 0, NOVAMEM_ERR = 1 } novamem_status;`
- Every result struct is freed with its `novamem_<type>_free`.
- The C++ API is `novamem::Client c{base_url, token, std::chrono::milliseconds{15000}};` and `auto r = c.search(req);`, where `req` is a `novamem_search_request` built by the caller. Errors are thrown as `novamem::Error`.
- Depends on Task 11's crate.

- [ ] Write the failing test `clients/c/tests/scenarios.c`:

```c
#include "novamem.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* The scenario file is read and walked by tests/run_scenarios.py, the
 * harness that starts the scenario server, then calls this binary once
 * per scenario:  scenarios_c <base_url> <token> <timeout_ms> <method> <args_json>
 * It prints one line:  <outcome> <retryable 0|1> <status> <code|-> <leaked 0|1>
 * The harness compares that line with the scenario's expect block and
 * checks /_verdict. Keeping JSON parsing out of C keeps the C runner free
 * of a JSON dependency. */
int main(int argc, char **argv) {
    if (argc != 6) { fprintf(stderr, "usage\n"); return 2; }
    const char *base = argv[1], *token = argv[2], *method = argv[4], *args = argv[5];
    uint32_t timeout = (uint32_t)atoi(argv[3]);
    novamem_error err; memset(&err, 0, sizeof err);
    char *result = NULL;
    novamem_status st;
    if (strcmp(method, "ctor") == 0) {
        novamem_client *c = novamem_client_new(base, token, timeout, &err);
        st = c ? NOVAMEM_OK : NOVAMEM_ERR;
        if (c) novamem_client_free(c);
    } else {
        st = novamem_test_call_by_name(base, token, timeout, method, args, &result, &err);
    }
    int leaked = strstr(err.message, "nm_scenario_TOKEN_must_never_leak") != NULL;
    if (st == NOVAMEM_OK) {
        int empty = result && (strcmp(result, "[]") == 0 || strstr(result, "\"results\":[]") != NULL);
        printf("%s 0 0 - 0\n", empty ? "empty" : "ok");
    } else {
        const char *o = err.unavailable ? "unavailable" : err.not_found ? "not_found" : "error";
        printf("%s %d %d %s %d\n", o, err.retryable, err.status_code, err.code[0] ? err.code : "-", leaked);
    }
    novamem_string_free(result);
    return 0;
}
```

`novamem_test_call_by_name(base, token, timeout, method, args_json, &result_json, &err)` is the test entry point, compiled only with the `test-dispatch` feature. `rust_ffi_methods.tmpl` emits it into `methods_ffi.rs` as one match arm per `routes.json` method. Each arm constructs the handle for the method's class, deserialises `args_json` into the `#[repr(C)]` request mirror (or scalars), and calls the typed `extern "C"` function. That way the typed C surface is what the scenarios exercise, while the C runner needs no JSON parser. The arm then frees the handle and returns the result serialised to JSON. `novamem_string_free(char*)` is part of the public API and is NULL-safe.

Write `clients/c/tests/scenarios.cpp` as the same program using `novamem.hpp`: construct `novamem::Client` inside try/catch and map `novamem::Error` fields to the same output line. It calls the C++ test entry `novamem::test_call(base, token, timeout, method, args)`, which `novamem.hpp` provides only when `NOVAMEM_TEST_DISPATCH` is defined; it wraps `novamem_test_call_by_name` and throws `novamem::Error`.

Write `clients/c/tests/run_scenarios.py`, a stdlib-only harness. It starts the scenario server exactly as Task 7's `start_server` does (`sh scenario-server.sh -scenarios scenarios.json` in `clients/contract`), and for each scenario runs `[binary, base, token, timeoutMs, method, json.dumps(args)]`, using `ctor` as the method for ctor scenarios with `args.baseUrl` and `args.token` as base and token. It skips `requires: cancel` scenarios, printing `skip (blocking API has no cancellation): <id>`. It parses the output line, asserts outcome, retryable, statusCode and code against `expect`, asserts `leaked == 0`, and checks `/_verdict`. It exits 1 listing every failure. It takes the binary path as `argv[1]`.

Write `clients/c/tests/routes.sh`:

```sh
#!/bin/sh
# proved by: removing any novamem_<class>_<method> from the header fails this script.
set -eu
cd "$(dirname "$0")/.."
python3 - <<'EOF'
import json, re, sys
routes = json.load(open("../contract/routes.json"))
header = open("include/novamem.h").read()
snake = lambda s: re.sub(r"(?<!^)([A-Z])", r"_\1", s).lower()
missing = [m["name"] for r in routes.values() for m in r.get("methods", [])
           if f"novamem_{snake(m['name'].split('.')[0])}_{snake(m['name'].split('.')[1])}(" not in header]
print("\n".join(missing)); sys.exit(1 if missing else 0)
EOF
```

Makefile targets:

- `lib`: `cargo build --release --features test-dispatch --manifest-path novamem-ffi/Cargo.toml`.
- `test`: `lib`, then `cc -std=c11 -Wall -Werror -Iinclude tests/scenarios.c target/release/libnovamem_ffi.a -lpthread -ldl -lm -o build/scenarios_c`, `c++ -std=c++17 -Wall -Werror -DNOVAMEM_TEST_DISPATCH -Iinclude tests/scenarios.cpp target/release/libnovamem_ffi.a -lpthread -ldl -lm -o build/scenarios_cpp`, `python3 tests/run_scenarios.py build/scenarios_c`, `python3 tests/run_scenarios.py build/scenarios_cpp` and `sh tests/routes.sh`.
- `memcheck`: `test`, then `NOVAMEM_WRAP="valgrind --error-exitcode=1 --leak-check=full --errors-for-leak-kinds=definite" python3 tests/run_scenarios.py build/scenarios_c`; the harness prefixes the binary with `$NOVAMEM_WRAP` when it's set.
- The release archive is built by `cargo build --release` _without_ `test-dispatch`.

Run `make -C clients/c test`: expect FAIL with `error: could not find Cargo.toml` (missing `novamem-ffi`).

- [ ] Write `rust_ffi.tmpl` and `rust_ffi_methods.tmpl`, then run `go run ./clients/gen -spec docs/api/openapi.json -routes clients/contract/routes.json -out clients -lang rust_ffi`: expect PASS, creating `types_ffi.rs` and `methods_ffi.rs`.
- [ ] Implement `lib.rs`: the handles hold the Rust clients; `RUNTIME` is `OnceLock<Runtime>` built with `tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all()`. Every `extern "C"` function wraps its body in `std::panic::catch_unwind`; a panic becomes `NOVAMEM_ERR` with message `internal panic`. Fill `novamem_error` from `novamem::Error`. The Rust error already has the token redacted, and `op`, `code` and `message` are copied with truncation.
- [ ] Implement `novamem.hpp`.
- [ ] Run `make -C clients/c test`: expect PASS (both runners report 0 failures, and `routes.sh` exits 0). Run `make -C clients/c memcheck`: expect PASS (valgrind exits 0 for every scenario).
- [ ] Mutation check: make `novamem_forget_result_free` a no-op and run `make memcheck`. Expect FAIL (`definitely lost` on `forget-ok`). Revert.
- [ ] Write `clients/c/smoke.c` (up/down, prefix `c`) and the `smoke` Makefile target.
- [ ] Write the vcpkg port and Conan recipe. Each downloads `https://github.com/azrtydxb/novamem/releases/download/clients%2Fc%2Fv${VERSION}/novamem-c-${VERSION}-<triplet>.tar.gz`; the triplets are `linux-x86_64` and `linux-aarch64` (CI has no macOS runner, so no macOS archive is built). Each checks the archive's SHA-512, which the release workflow (Task 17) substitutes in.
- [ ] Add a `c` job to `.github/workflows/sdk.yml`:
  - `runs-on: arc-azrtydxb-amd64`, `timeout-minutes: 25`, `needs: [rust]`.
  - Steps: `dtolnay/rust-toolchain@stable`, `actions/setup-go@v6`, then `sudo apt-get install -y valgrind`, then `make -C clients/c memcheck`.
- [ ] Commit `feat(sdk-c): C and C++ SDK as a C ABI over the Rust crate`.

## Task 13: Ruby SDK

Files:

- `clients/gen/templates/ruby.tmpl` (created; out: `ruby/lib/novamem/types.rb`): `module Novamem` with, per object type, `X = Struct.new(:snake_field, …, keyword_init: true)`, reopened to add `def self.from_h(h)` (ignoring unknown keys and mapping wire names to snake) and `def to_h_wire` (wire names, omitting `nil` and `""`, and formatting `Time` values with `.utc.iso8601(3)`). Enums are modules of frozen string constants.
- `clients/gen/templates/ruby_dispatch.tmpl` (created; out: `ruby/test/dispatch.rb`): `DISPATCH = { "Client.Search" => ->(c, a) { c[:Client].search(Novamem::SearchRequest.from_h(a)) }, … }.freeze`. Scalar methods pass keyword arguments named `snake(param)`.
- `clients/ruby/novamem.gemspec` (created: name `novamem`, version `0.1.0`, `required_ruby_version >= 3.2`, `files = Dir["lib/**/*.rb"]`, no `add_dependency`)
- `clients/ruby/lib/novamem.rb`, `lib/novamem/{version,errors,transport,client,management,admin}.rb` (created; requires only `net/http`, `json`, `uri` and `time`)
- `clients/ruby/test/scenarios_test.rb`, `clients/ruby/test/routes_test.rb` (created; `minitest`, bundled with Ruby)
- `clients/ruby/Rakefile` (created: `Rake::TestTask` over `test/*_test.rb`, `libs << "lib" << "test"`)
- `clients/ruby/smoke.rb` (created)

Interfaces:

- `Novamem::Client.new(base_url:, token:, timeout: 15)`. `Management` and `Admin` take the same arguments. Invalid configuration raises `Novamem::ConfigError < ArgumentError`, naming the field.
- `Novamem::Error < StandardError` with `op`, `status_code`, `code`, `unavailable?` and `retryable?`. Its subclasses are `Novamem::UnavailableError` and `Novamem::NotFoundError`. `#inspect` on clients and configs shows `token=[redacted]`.
- Method names are snake_case, using keyword arguments for scalars (`create_project(name:)`).

- [ ] Write the failing test `clients/ruby/test/scenarios_test.rb`:

```ruby
require "minitest/autorun"
require "json"
require "net/http"
require "novamem"
require "dispatch"

CONTRACT = File.expand_path("../../contract", __dir__)
SCEN = JSON.parse(File.read(File.join(CONTRACT, "scenarios.json")))
TOKEN = SCEN.fetch("token")

class ScenariosTest < Minitest::Test
  def self.server
    @server ||= begin
      io = IO.popen(["sh", "scenario-server.sh", "-scenarios", "scenarios.json"], chdir: CONTRACT)
      _, url, closed = io.gets.split
      Minitest.after_run { Process.kill("KILL", io.pid) }
      [url, closed.split("=").last]
    end
  end

  def empty?(r)
    w = r.respond_to?(:to_h_wire) ? r.to_h_wire : r
    w == [] || (w.is_a?(Hash) && w["results"] == [])
  end

  def classify(r, e)
    return(empty?(r) ? "empty" : "ok") if e.nil?
    return "unavailable" if e.is_a?(Novamem::UnavailableError)
    return "not_found" if e.is_a?(Novamem::NotFoundError)
    "error"
  end

  SCEN.fetch("scenarios").each do |s|
    define_method("test_#{s["id"].tr("-", "_")}") do
      skip "ruby has no cancellation primitive: #{s["id"]}" if Array(s["requires"]).include?("cancel")
      url, closed = self.class.server
      call = s["call"]
      r = e = nil
      if call["class"] == "ctor"
        begin
          Novamem::Client.new(base_url: call["args"]["baseUrl"].sub("<server>", url), token: call["args"]["token"])
        rescue Novamem::ConfigError, Novamem::Error => err
          e = err
        end
      else
        base = s["respond"].to_json.include?('"refused"') ? "http://127.0.0.1:#{closed}/s/#{s["id"]}" : "#{url}/s/#{s["id"]}"
        opts = { base_url: base, token: TOKEN, timeout: SCEN["timeoutMs"] / 1000.0 }
        clients = { Client: Novamem::Client.new(**opts), Management: Novamem::Management.new(**opts), Admin: Novamem::Admin.new(**opts) }
        begin
          r = DISPATCH.fetch(call["method"]).call(clients, call["args"])
        rescue Novamem::Error => err
          e = err
        end
      end
      exp = s["expect"]
      assert_equal exp["outcome"], classify(r, e), "#{s["id"]}: #{e.inspect}"
      if e
        refute_includes e.message, TOKEN
        refute_includes e.inspect, TOKEN
        assert_equal exp["retryable"], e.respond_to?(:retryable?) && e.retryable? if exp.key?("retryable")
        assert_equal exp["statusCode"], e.status_code if exp.key?("statusCode")
        assert_equal exp["code"], e.code if exp.key?("code")
      end
      v = JSON.parse(Net::HTTP.get(URI("#{url}/_verdict/#{s["id"]}")))
      assert_equal [], v["mismatches"]
      assert_equal 0, v["requests"] if s["expectRequest"] == []
    end
  end
end
```

Write `clients/ruby/test/routes_test.rb`:

```ruby
require "minitest/autorun"
require "json"
require "novamem"

class RoutesTest < Minitest::Test
  # proved by: renaming Novamem::Client#session_recap fails this test.
  def test_every_route_is_accounted
    routes = JSON.parse(File.read(File.expand_path("../../contract/routes.json", __dir__)))
    routes.each do |key, r|
      Array(r["methods"]).each do |m|
        cls, meth = m["name"].split(".")
        name = meth.gsub(/([A-Z])/) { "_" + $1.downcase }.sub(/\A_/, "")
        assert Novamem.const_get(cls).method_defined?(name), "#{key} #{cls}##{name}"
      end
    end
  end
end
```

Run `cd clients/ruby && ruby -Ilib -Itest test/scenarios_test.rb`: expect FAIL with `cannot load such file -- novamem (LoadError)`.

- [ ] Write both templates, then run `go run ./clients/gen -spec docs/api/openapi.json -routes clients/contract/routes.json -out clients -lang ruby`: expect PASS, creating `lib/novamem/types.rb` and `test/dispatch.rb`, each with the header `# Code generated by clients/gen. DO NOT EDIT.`.
- [ ] Implement `transport.rb` with `Net::HTTP.start(host, port, use_ssl:, open_timeout: t, read_timeout: t, write_timeout: t)`, streaming the body with `read_body` in chunks and stopping past 8388608 bytes:
  - `Net::OpenTimeout` and `Net::ReadTimeout` are unavailable and retryable (`timed out`).
  - `SystemCallError`, `SocketError`, `IOError`, `EOFError` and `OpenSSL::SSL::SSLError` are unavailable and retryable.
  - `JSON::ParserError` is unavailable (`malformed response body`).
  - Status handling follows the Constraints, and every message is redacted with `gsub(token, "[redacted]")`.
  - The constructor validates with `URI.parse`, requiring `URI::HTTP` or `URI::HTTPS` and a non-empty host.
- [ ] Implement the 41 methods with the special rules from Task 7.
- [ ] Run `cd clients/ruby && ruby -Ilib -e 'require "novamem"'` with `GEM_HOME` pointed at an empty directory: expect PASS. Run `cd clients/ruby && rake test`: expect PASS (the cancel scenarios show as skips with their ids).
- [ ] Mutation check: remove the `degraded` check and re-run. Expect FAIL on `test_search_degraded_empty_is_unavailable`. Revert.
- [ ] Write `smoke.rb` (up/down, prefix `ruby`).
- [ ] Add a `ruby` job to `.github/workflows/sdk.yml`: `runs-on: arc-azrtydxb-amd64`, `timeout-minutes: 15`, `needs: [generated]`, using `ruby/setup-ruby@v1` with `ruby-version: "3.2"` and `actions/setup-go@v6`. Run: `cd clients/ruby && rake test`.
- [ ] Commit `feat(sdk-ruby): novamem Ruby gem held to the shared scenario suite`.

## Task 14: PHP SDK

Files:

- `clients/gen/templates/php.tmpl` (created; out: `php/src/Types.php`): `namespace Novamem\Types;` with a `final readonly class X` per object type. Each has a constructor with named, typed, nullable-default parameters, plus `public static function fromArray(array $a): self` (ignoring unknown keys) and `public function toArray(): array` (wire names, omitting `null` and `''`, and formatting `\DateTimeInterface` values as UTC `Y-m-d\TH:i:s.v\Z`). Enums are `enum X: string`. The spec lists `clients/php/src/Types/*.php`; one generated `Types.php` holding every class satisfies it, and Composer's `classmap` autoload covers a single file with many classes.
- `clients/gen/templates/php_dispatch.tmpl` (created; out: `php/tests/Dispatch.php`): `final class Dispatch { public static function table(): array }`, returning `'Client.Search' => fn(array $c, array $a) => $c['Client']->search(SearchRequest::fromArray($a))`. Scalar methods pass named arguments `camel(param)`.
- `clients/php/composer.json` (created):
  - `"name": "azrtydxb/novamem"`, `"type": "library"`, `"license": "Apache-2.0"`.
  - `"require": {"php": ">=8.2", "ext-curl": "*", "ext-json": "*"}`, `"require-dev": {"phpunit/phpunit": "^11.5"}`.
  - `"autoload": {"psr-4": {"Novamem\\": "src/"}, "classmap": ["src/Types.php"]}`, `"autoload-dev": {"classmap": ["tests/"]}`.
  - No `version` field; Packagist reads versions from tags.
- `clients/php/src/{Client,Management,Admin,Config,NovamemException,Transport}.php` (created)
- `clients/php/tests/{ScenarioTest,RouteTest}.php`, `clients/php/phpunit.xml` (created)
- `clients/php/smoke.php` (created)

Interfaces:

- `new Novamem\Client(new Novamem\Config(baseUrl: '...', token: '...', timeoutMs: 15000))`. `Management` and `Admin` take the same config. Invalid configuration throws `\InvalidArgumentException` naming the field.
- `Novamem\NovamemException extends \RuntimeException` with `op()`, `statusCode()`, `code()` (the server code as a string; PHP's built-in `getCode()` stays at 0), `isUnavailable()`, `isRetryable()` and `isNotFound()`.
- `Config::__debugInfo()` returns `['baseUrl' => …, 'token' => '[redacted]']`, and the token is stored in a `#[\SensitiveParameter]`-annotated constructor parameter, so stack traces don't carry it.

- [ ] Write the failing test `clients/php/tests/ScenarioTest.php`:

```php
<?php
declare(strict_types=1);

use Novamem\{Admin, Client, Config, Management, NovamemException};
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

final class ScenarioTest extends TestCase
{
  private static $proc;
  private static string $url = "";
  private static string $closed = "";
  private static array $scen = [];

  public static function setUpBeforeClass(): void
  {
    $contract = realpath(__DIR__ . "/../../contract");
    self::$scen = json_decode(
      file_get_contents("$contract/scenarios.json"),
      true,
    );
    self::$proc = proc_open(
      ["sh", "scenario-server.sh", "-scenarios", "scenarios.json"],
      [1 => ["pipe", "w"]],
      $pipes,
      $contract,
    );
    [, self::$url, $closed] = explode(" ", trim(fgets($pipes[1])));
    self::$closed = explode("=", $closed)[1];
  }

  public static function tearDownAfterClass(): void
  {
    proc_terminate(self::$proc, 9);
  }

  public static function ids(): array
  {
    $s = json_decode(
      file_get_contents(__DIR__ . "/../../contract/scenarios.json"),
      true,
    );
    return array_map(fn($x) => [$x["id"]], $s["scenarios"]);
  }

  private static function isEmpty(mixed $r): bool
  {
    $w = is_object($r) && method_exists($r, "toArray") ? $r->toArray() : $r;
    return $w === [] ||
      (is_array($w) && array_key_exists("results", $w) && $w["results"] === []);
  }

  // proved by: removing the degraded-empty check in Client::search fails search-degraded-empty-is-unavailable.
  #[DataProvider("ids")]
  public function testScenarios(string $id): void
  {
    $s = array_values(
      array_filter(self::$scen["scenarios"], fn($x) => $x["id"] === $id),
    )[0];
    if (in_array("cancel", $s["requires"] ?? [], true)) {
      $this->markTestSkipped("php has no cancellation primitive: $id");
    }
    $call = $s["call"];
    $token = self::$scen["token"];
    $r = null;
    $e = null;
    if ($call["class"] === "ctor") {
      try {
        new Client(
          new Config(
            baseUrl: str_replace(
              "<server>",
              self::$url,
              $call["args"]["baseUrl"],
            ),
            token: $call["args"]["token"],
          ),
        );
      } catch (\InvalidArgumentException | NovamemException $err) {
        $e = $err;
      }
    } else {
      $base = str_contains(json_encode($s["respond"]), '"refused"')
        ? "http://127.0.0.1:" . self::$closed . "/s/$id"
        : self::$url . "/s/$id";
      $cfg = new Config(
        baseUrl: $base,
        token: $token,
        timeoutMs: self::$scen["timeoutMs"],
      );
      $clients = [
        "Client" => new Client($cfg),
        "Management" => new Management($cfg),
        "Admin" => new Admin($cfg),
      ];
      try {
        $r = Dispatch::table()[$call["method"]]($clients, $call["args"]);
      } catch (NovamemException $err) {
        $e = $err;
      }
    }
    $outcome = match (true) {
      $e === null => self::isEmpty($r) ? "empty" : "ok",
      $e instanceof NovamemException && $e->isUnavailable() => "unavailable",
      $e instanceof NovamemException && $e->isNotFound() => "not_found",
      default => "error",
    };
    $exp = $s["expect"];
    $this->assertSame(
      $exp["outcome"],
      $outcome,
      "$id: " . ($e?->getMessage() ?? ""),
    );
    if ($e !== null) {
      $this->assertStringNotContainsString($token, (string) $e);
      $this->assertStringNotContainsString($token, print_r($e, true));
      if ($e instanceof NovamemException) {
        if (array_key_exists("retryable", $exp)) {
          $this->assertSame($exp["retryable"], $e->isRetryable());
        }
        if (array_key_exists("statusCode", $exp)) {
          $this->assertSame($exp["statusCode"], $e->statusCode());
        }
        if (array_key_exists("code", $exp)) {
          $this->assertSame($exp["code"], $e->code());
        }
      }
    }
    $v = json_decode(file_get_contents(self::$url . "/_verdict/$id"), true);
    $this->assertSame([], $v["mismatches"]);
    if (($s["expectRequest"] ?? null) === []) {
      $this->assertSame(0, $v["requests"]);
    }
  }
}
```

Write `clients/php/tests/RouteTest.php`:

```php
<?php
declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class RouteTest extends TestCase
{
  // proved by: renaming Novamem\Client::sessionRecap fails this test.
  public function testEveryRouteIsAccounted(): void
  {
    $routes = json_decode(
      file_get_contents(__DIR__ . "/../../contract/routes.json"),
      true,
    );
    foreach ($routes as $key => $r) {
      foreach ($r["methods"] ?? [] as $m) {
        [$cls, $meth] = explode(".", $m["name"]);
        $this->assertTrue(
          method_exists("Novamem\\$cls", lcfirst($meth)),
          "$key $cls::" . lcfirst($meth),
        );
      }
    }
  }
}
```

Run `cd clients/php && composer install && vendor/bin/phpunit`: expect FAIL with `Class "Novamem\Config" not found`.

- [ ] Write both templates, then run `go run ./clients/gen -spec docs/api/openapi.json -routes clients/contract/routes.json -out clients -lang php`: expect PASS, creating `src/Types.php` and `tests/Dispatch.php`, each with `// Code generated by clients/gen. DO NOT EDIT.` on the line after `<?php`.
- [ ] Implement `Transport.php` with curl: `CURLOPT_TIMEOUT_MS => timeoutMs`, `CURLOPT_RETURNTRANSFER => false`, and a `CURLOPT_WRITEFUNCTION` that appends to a buffer and returns `-1` (aborting) past 8388608 bytes, with `CURLOPT_HTTPHEADER` carrying the `Authorization` header:
  - `curl_errno` `CURLE_OPERATION_TIMEDOUT` is unavailable and retryable (`timed out`).
  - `CURLE_WRITE_ERROR` after the cap is unavailable, not retryable (`response body exceeds 8 MiB`).
  - Any other non-zero `curl_errno` is unavailable and retryable.
  - `json_decode` with `JSON_THROW_ON_ERROR` throwing `\JsonException` is unavailable (`malformed response body`).
  - Status handling follows the Constraints, and every message is redacted with `str_replace($token, '[redacted]', …)`.
  - The constructor validates with `parse_url`, requiring scheme `http` or `https` and a non-empty host.
- [ ] Implement the 41 methods with the special rules from Task 7.
- [ ] Run `cd clients/php && vendor/bin/phpunit` on PHP 8.2 and on PHP 8.4: expect PASS (cancel scenarios skipped). Run `cd clients/php && rm -rf vendor && composer install --no-dev && composer show --no-dev`: expect no output.
- [ ] Mutation check: remove the redaction and re-run. Expect FAIL on `token-echoed-in-401-is-redacted`. Revert.
- [ ] Write `smoke.php` (up/down, prefix `php`).
- [ ] Add a `php` job to `.github/workflows/sdk.yml`:
  - `runs-on: arc-azrtydxb-amd64`, `timeout-minutes: 15`, `needs: [generated]`.
  - A matrix of `php: ["8.2", "8.4"]`, using `shivammathur/setup-php@v2` with `extensions: curl, json` and `tools: composer`, plus `actions/setup-go@v6`.
  - Run: `cd clients/php && composer install && vendor/bin/phpunit`.
- [ ] Commit `feat(sdk-php): novamem PHP package held to the shared scenario suite`.

## Task 15: Swift SDK

Status: built on `feat/sdk-swift`. Where the build differs from the steps below, the build is right:

- Int is `Int` (int64 is `Int64`), and enum-typed fields are plain `String`, with the values as static constants on a namespace enum, so an unknown value is kept. Keyword identifiers are backticked (`import`, `public`) by the generator's `swiftident`.
- The transport wraps `dataTask` in a continuation with a cancellation handler (no reliance on the async `data(for:)`, which differs between Darwin and swift-corelibs). A session delegate handles redirects: URLSession drops `Authorization` on every redirect, so the delegate re-adds it for same-origin hops and leaves it off otherwise.
- The redirect guarantee is tested through two new shared scenarios (`redirect-cross-origin-drops-bearer` and `redirect-same-origin-keeps-bearer`, added to `clients/contract` on this branch) rather than a Swift-only server. Every SDK now runs them, and they caught Swift dropping the bearer on a same-origin hop.
- CI runs in the official `swift:5.9-jammy` and `swift:6.3-noble` images. `.swiftformat` excludes the generated files and disables the test-unwrap rule, which rewrote casts into code that doesn't compile.

Files:

- `clients/gen/templates/swift.tmpl` (created; out: `swift/Sources/Novamem/Types.swift`): a `public struct X: Codable, Sendable` per object type, with `CodingKeys` mapping camelCase properties to wire names. Optionals use `encodeIfPresent`; a custom `encode(to:)` also omits empty strings. `datetime` becomes `Date`, encoded through the client's `JSONEncoder.dateEncodingStrategy = .custom` (ISO 8601 UTC with fractional seconds and `Z`). `int64` becomes `Int64`, `int32` becomes `Int32`, and maps become `[String: JSONValue]`, where `JSONValue` is a small hand-written `Codable` enum in `Sources/Novamem/JSONValue.swift`. Enums are `public enum X: String, Codable, Sendable`.
- `clients/gen/templates/swift_dispatch.tmpl` (created; out: `swift/Tests/NovamemTests/Dispatch.swift`): `let dispatchTable: [String: @Sendable (Clients, Data) async throws -> Data]`. Each entry decodes `Data` (the args JSON) into the request type with `JSONDecoder`, calls the method, and encodes the result.
- `clients/swift/Package.swift` (created): `swift-tools-version:5.9`, `platforms: [.macOS(.v13), .iOS(.v16)]`, product `.library(name: "Novamem", targets: ["Novamem"])`, no `dependencies`, test target `NovamemTests`.
- `clients/swift/Sources/Novamem/{Client,Management,Admin,Config,NovamemError,Transport,JSONValue}.swift` (created). `Transport.swift` has `#if canImport(FoundationNetworking) import FoundationNetworking #endif`.
- `clients/swift/Tests/NovamemTests/{ScenarioTests,RouteTests}.swift` (created)
- `clients/swift/Sources/NovamemSmoke/main.swift` (created) and an executable product `novamem-smoke` in `Package.swift`

Interfaces:

- `try Client(Config(baseURL: "...", token: "...", timeout: .seconds(15)))`. `Management` and `Admin` take the same config. The initialiser throws `NovamemError(op: "config", …)` naming the field.
- `public struct NovamemError: Error, CustomStringConvertible, CustomDebugStringConvertible, Sendable` with `op`, `statusCode`, `code`, `message`, `isUnavailable`, `isRetryable` and `isNotFound`. Cancellation surfaces as `CancellationError`, when the enclosing `Task` is cancelled during `URLSession.data(for:)`, which throws `URLError(.cancelled)` and is mapped to `CancellationError()`.
- `Config`'s `description` and `debugDescription` show `token: [redacted]`.
- Every method is `public func name(…) async throws -> T`. Types are `Sendable`, and the classes are `final class …: Sendable`, holding only immutable state.

- [ ] Write the failing test `clients/swift/Tests/NovamemTests/ScenarioTests.swift`:

```swift
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import Novamem

struct Clients: Sendable { let client: Client; let management: Management; let admin: Admin }

final class ScenarioTests: XCTestCase {
    static let contract = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .appendingPathComponent("../../../contract").standardizedFileURL

    func startServer() throws -> (Process, String, String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        p.arguments = ["sh", "scenario-server.sh", "-scenarios", "scenarios.json"]
        p.currentDirectoryURL = Self.contract
        let pipe = Pipe(); p.standardOutput = pipe
        try p.run()
        var line = Data()
        while true {
            let b = pipe.fileHandleForReading.readData(ofLength: 1)
            if b.isEmpty || b == Data([0x0A]) { break }
            line.append(b)
        }
        let parts = String(decoding: line, as: UTF8.self).split(separator: " ").map(String.init)
        return (p, parts[1], String(parts[2].split(separator: "=")[1]))
    }

    func isEmpty(_ d: Data) -> Bool {
        let o = try? JSONSerialization.jsonObject(with: d, options: [.fragmentsAllowed])
        if let a = o as? [Any] { return a.isEmpty }
        if let m = o as? [String: Any], let r = m["results"] as? [Any] { return r.isEmpty }
        return false
    }

    // proved by: removing the degraded-empty check in Client.search fails search-degraded-empty-is-unavailable.
    func testScenarios() async throws {
        let scen = try JSONSerialization.jsonObject(with: Data(contentsOf: Self.contract.appendingPathComponent("scenarios.json"))) as! [String: Any]
        let token = scen["token"] as! String
        let timeout = Duration.milliseconds(scen["timeoutMs"] as! Int)
        let (proc, url, closed) = try startServer()
        defer { proc.terminate() }
        var failures: [String] = []

        for s in scen["scenarios"] as! [[String: Any]] {
            let id = s["id"] as! String
            let call = s["call"] as! [String: Any]
            var result: Data? = nil
            var err: Error? = nil
            if call["class"] as! String == "ctor" {
                let a = call["args"] as! [String: String]
                do { _ = try Client(Config(baseURL: a["baseUrl"]!.replacingOccurrences(of: "<server>", with: url), token: a["token"]!)) }
                catch { err = error }
            } else {
                let respond = String(decoding: try JSONSerialization.data(withJSONObject: s["respond"]!, options: [.fragmentsAllowed]), as: UTF8.self)
                let base = respond.contains("\"refused\"") ? "http://127.0.0.1:\(closed)/s/\(id)" : "\(url)/s/\(id)"
                let cfg = Config(baseURL: base, token: token, timeout: timeout)
                let c = Clients(client: try Client(cfg), management: try Management(cfg), admin: try Admin(cfg))
                let args = try JSONSerialization.data(withJSONObject: call["args"] ?? [:])
                let fn = dispatchTable[call["method"] as! String]!
                let task = Task { try await fn(c, args) }
                if let ms = call["cancelAfterMs"] as? Int {
                    Task { try await Task.sleep(for: .milliseconds(ms)); task.cancel() }
                }
                do { result = try await task.value } catch { err = error }
            }
            let outcome: String
            switch err {
            case nil: outcome = isEmpty(result ?? Data()) ? "empty" : "ok"
            case is CancellationError: outcome = "canceled"
            case let e as NovamemError where e.isUnavailable: outcome = "unavailable"
            case let e as NovamemError where e.isNotFound: outcome = "not_found"
            default: outcome = "error"
            }
            let exp = s["expect"] as! [String: Any]
            if outcome != exp["outcome"] as! String { failures.append("\(id): outcome \(outcome) (\(String(describing: err)))") }
            if let e = err {
                if "\(e)".contains(token) || String(reflecting: e).contains(token) { failures.append("\(id): token leaked") }
                if let ne = e as? NovamemError {
                    if let r = exp["retryable"] as? Bool, r != ne.isRetryable { failures.append("\(id): retryable") }
                    if let sc = exp["statusCode"] as? Int, sc != ne.statusCode { failures.append("\(id): status \(ne.statusCode)") }
                    if let code = exp["code"] as? String, code != ne.code { failures.append("\(id): code \(ne.code)") }
                }
            }
            let (vd, _) = try await URLSession.shared.data(from: URL(string: "\(url)/_verdict/\(id)")!)
            let v = try JSONSerialization.jsonObject(with: vd) as! [String: Any]
            if !(v["mismatches"] as! [Any]).isEmpty { failures.append("\(id): mismatches \(v["mismatches"]!)") }
            if let er = s["expectRequest"] as? [Any], er.isEmpty, v["requests"] as! Int != 0 { failures.append("\(id): expected no request") }
        }
        XCTAssert(failures.isEmpty, failures.joined(separator: "\n"))
    }
}
```

Write `clients/swift/Tests/NovamemTests/RouteTests.swift`. Swift has no runtime method lookup on non-`@objc` classes, so this test checks that the generated dispatch table has a key for every `routes.json` method. Each table entry calls the method directly, so a missing method fails compilation of `swift test`.

```swift
import Foundation
import XCTest

final class RouteTests: XCTestCase {
    // proved by: deleting a dispatch entry, or renaming Client.sessionRecap, fails this test or its compilation.
    func testEveryRouteIsAccounted() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../contract/routes.json").standardizedFileURL
        let routes = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: [String: Any]]
        for (key, r) in routes {
            for m in (r["methods"] as? [[String: Any]]) ?? [] {
                let name = m["name"] as! String
                XCTAssertNotNil(dispatchTable[name], "\(key): no dispatch entry for \(name)")
            }
        }
    }
}
```

Run `cd clients/swift && swift test`: expect FAIL with `error: no such module 'Novamem'` or `cannot find 'Config' in scope`.

- [ ] Write both templates, then run `go run ./clients/gen -spec docs/api/openapi.json -routes clients/contract/routes.json -out clients -lang swift`: expect PASS, creating `Types.swift` and `Dispatch.swift`, each with the header `// Code generated by clients/gen. DO NOT EDIT.`.
- [ ] Implement `Transport.swift` with a per-client `URLSession(configuration: .ephemeral)` whose `timeoutIntervalForRequest` is the timeout, and `session.bytes(for:)`. On Linux, where `bytes(for:)` is unavailable in FoundationNetworking, use `data(for:)` and check the length after the read; the 8 MiB cap is then enforced post-read on Linux. Wrap the call in `withThrowingTaskGroup` racing a `Task.sleep(for: timeout)` child.
  - `URLError(.timedOut)` or the sleep winning is unavailable and retryable (`timed out`).
  - `URLError(.cancelled)` while `Task.isCancelled` is `CancellationError()`.
  - Any other `URLError` is unavailable and retryable.
  - A `DecodingError` is unavailable (`malformed response body`).
  - Status handling follows the Constraints, and every message is redacted with `replacingOccurrences(of: token, with: "[redacted]")`.
  - `Config` validates with `URL(string:)`, requiring `scheme` `http` or `https` and a non-empty `host`.
- [ ] Implement the 41 methods with the special rules from Task 7.
- [ ] Run `cd clients/swift && swift test` on Linux with Swift 5.9 (`swift:5.9-jammy` toolchain) and on the latest release: expect PASS for `testScenarios` and `testEveryRouteIsAccounted`. Run `swift package show-dependencies`: expect `No external dependencies found`.
- [ ] Mutation check: remove the `forget` blank-id guard and re-run. Expect FAIL on `forget-blank-id-local` (either `outcome ok` or `expected no request`). Revert.
- [ ] Write `Sources/NovamemSmoke/main.swift` (up/down, prefix `swift`).
- [ ] Add a `swift` job to `.github/workflows/sdk.yml`:
  - `runs-on: arc-azrtydxb-amd64`, `timeout-minutes: 25`, `needs: [generated]`.
  - A matrix of `swift: ["5.9", "6.2"]`, using `swift-actions/setup-swift@v2` with `swift-version: ${{ matrix.swift }}`, plus `actions/setup-go@v6`.
  - Run: `cd clients/swift && swift test`.
- [ ] Commit `feat(sdk-swift): Novamem Swift package held to the shared scenario suite`.

## Task 16: Live smoke job against a server built from the PR

Files:

- `clients/smoke/go.mod` (created: `module github.com/azrtydxb/novamem/clients/smoke`, `go 1.23.0`, no requirements; added to `go.work`)
- `clients/smoke/cmd/mint/main.go` (created: signs in the bootstrap admin and prints a fresh `nm_` token)
- `clients/smoke/cmd/embed/main.go` (created: a deterministic OpenAI-compatible `/v1/embeddings` stand-in). Without an embedder the server marks every search `degraded` (go/internal/engine/search.go), and a degraded search with no results is — correctly — `unavailable` in every SDK, so the search-after-forget step could never pass. The stand-in hashes words into a unit vector of `-dim` (default 384, the server's `NOVAMEM_EMBEDDINGS_DIM` default), so the same text embeds identically and no model is downloaded.
- `clients/smoke/schema.go` (created: a minimal OpenAPI-subset validator)
- `clients/smoke/schema_test.go` (created: `TestResponsesMatchSchemas`, plus the validator's own unit test)
- `clients/smoke/run.sh` (created: `run.sh <lang> <build|up|down>` runs one SDK's smoke phase)
- `.github/workflows/sdk.yml` (modified: add the `sdk-smoke` job)

Interfaces:

- `mint` flags: `-url` (default `http://127.0.0.1:7778`), `-email`, `-password`, `-label` (default `sdk-smoke`) and `-wait` (default `0`: when set, poll `GET /ready` until 200 or the duration passes, so minimal images need no curl). It does `POST /api/auth/sign-in/email` with `Origin: <url>` and body `{"email","password"}`, takes every `Set-Cookie` name=value pair, then does `POST /v1/me/tokens` with that `Cookie` header, `Origin: <url>` and body `{"label":"<label>"}`. It prints the `token` field on stdout and exits non-zero with the status and body on any non-2xx.
- `schema.go` exports `func Validate(doc map[string]any, schemaName string, v any) error`, which checks `type`, `required`, `properties` (recursively), `items`, `nullable` and `$ref` (resolved against `doc.components.schemas`). Unknown fields pass. The error names the JSON path.
- `TestResponsesMatchSchemas` reads the environment variables `NOVAMEM_SMOKE_URL` and `NOVAMEM_SMOKE_ADMIN_TOKEN` (the minted admin token). If either is unset it calls `t.Skip("NOVAMEM_SMOKE_URL unset: live schema check needs the sdk-smoke job")`, a loud skip.
- `run.sh <lang> <build|up|down>`: `build` prepares that SDK (`npm ci && npm run build`, `mvn -B -q test-compile dependency:build-classpath -Dmdep.outputFile=cp.txt`, `cargo build --example smoke`, `make -C clients/c build/smoke`, `composer install --no-dev`, `swift build --product novamem-smoke`, `dotnet build clients/dotnet/smoke`; nothing for python and ruby). `up` and `down` run the smoke with `NOVAMEM_SMOKE_URL` and `NOVAMEM_SMOKE_TOKEN` from the environment and never build, so `down` measures the stopped server rather than a compile. The commands:

  - python: `python3 clients/python/smoke.py`
  - typescript: `node clients/typescript/smoke.mjs`
  - dotnet: `dotnet run --no-build --project clients/dotnet/smoke --`
  - java: `java -cp "$(cat clients/java/cp.txt):clients/java/target/classes:clients/java/target/test-classes" com.azrtydxb.novamem.Smoke`
  - rust: `target/debug/examples/smoke` (the workspace target dir)
  - c: `clients/c/build/smoke`
  - ruby: `ruby -Iclients/ruby/lib clients/ruby/smoke.rb`
  - php: `php clients/php/smoke.php`
  - swift: `clients/swift/.build/debug/novamem-smoke`

  Each is invoked with the mode as its argument; an unknown language exits 2.

- [ ] Write the failing tests `clients/smoke/schema_test.go`:

```go
package smoke

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
)

func loadDoc(t *testing.T) map[string]any {
	t.Helper()
	raw, err := os.ReadFile("../../docs/api/openapi.json")
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	return doc
}

func TestValidateCatchesMissingRequired(t *testing.T) {
	doc := loadDoc(t)
	if err := Validate(doc, "RevokeResult", map[string]any{"revoked": true}); err != nil {
		t.Fatalf("valid body rejected: %v", err)
	}
	err := Validate(doc, "RevokeResult", map[string]any{})
	if err == nil || !strings.Contains(err.Error(), "$.revoked") {
		t.Fatalf("err = %v, want missing $.revoked", err)
	}
	err = Validate(doc, "AdminUserList", map[string]any{"users": []any{map[string]any{"id": 1}}})
	if err == nil || !strings.Contains(err.Error(), "$.users[0].id") {
		t.Fatalf("err = %v, want type error at $.users[0].id", err)
	}
}

// proved by: removing `tokenCount` from AdminUser in the handler (or adding a required field
// the handler never sends to the schema) fails this test in the sdk-smoke job.
func TestResponsesMatchSchemas(t *testing.T) {
	base, admin := os.Getenv("NOVAMEM_SMOKE_URL"), os.Getenv("NOVAMEM_SMOKE_ADMIN_TOKEN")
	if base == "" || admin == "" {
		t.Skip("NOVAMEM_SMOKE_URL unset: live schema check needs the sdk-smoke job")
	}
	doc := loadDoc(t)
	call := func(method, path, token string, body any) (int, any) {
		var rd io.Reader
		if body != nil {
			b, _ := json.Marshal(body)
			rd = bytes.NewReader(b)
		}
		req, _ := http.NewRequest(method, base+path, rd)
		req.Header.Set("Authorization", "Bearer "+token)
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("%s %s: %v", method, path, err)
		}
		defer resp.Body.Close()
		var v any
		_ = json.NewDecoder(resp.Body).Decode(&v)
		return resp.StatusCode, v
	}
	check := func(route, schema string, status, want int, v any) {
		t.Helper()
		if status != want {
			t.Errorf("%s: status %d, want %d (%v)", route, status, want, v)
			return
		}
		if err := Validate(doc, schema, v); err != nil {
			t.Errorf("%s: %v", route, err)
		}
	}

	st, prov := call("POST", "/v1/admin/users", admin, map[string]any{"email": "smoke-user@example.com", "password": "smoke-password-1", "name": "smoke", "tokenLabel": "smoke"})
	check("POST /v1/admin/users", "ProvisionedUser", st, 201, prov)
	userID := prov.(map[string]any)["userId"].(string)
	userToken := prov.(map[string]any)["token"].(string)

	st, v := call("GET", "/v1/admin/users", admin, nil)
	check("GET /v1/admin/users", "AdminUserList", st, 200, v)
	st, v = call("PUT", "/v1/admin/users/"+userID+"/quota", admin, map[string]any{"maxEntries": 100, "writesPerMinute": 10})
	check("PUT /v1/admin/users/{id}/quota", "QuotaResult", st, 200, v)

	st, v = call("POST", "/v1/me/import", userToken, map[string]any{"entries": []any{map[string]any{"content": "smoke import"}}})
	check("POST /v1/me/import", "ImportResult", st, 201, v)
	st, v = call("GET", "/v1/me/export?limit=10", userToken, nil)
	check("GET /v1/me/export", "ExportPage", st, 200, v)

	st, minted := call("POST", "/v1/me/tokens", userToken, map[string]any{"label": "smoke-2"})
	if st != 201 {
		t.Fatalf("mint second token: %d %v", st, minted)
	}
	st, list := call("GET", "/v1/me/tokens", userToken, nil)
	if st != 200 {
		t.Fatalf("list tokens: %d", st)
	}
	var hash string
	for _, tok := range list.(map[string]any)["tokens"].([]any) {
		if m := tok.(map[string]any); m["label"] == "smoke-2" {
			hash, _ = m["tokenHash"].(string)
		}
	}
	st, v = call("DELETE", "/v1/me/tokens/"+hash, userToken, nil)
	check("DELETE /v1/me/tokens/{hash}", "TokenDeleted", st, 200, v)

	// The observer is disabled in the smoke server, so the documented answer is 404.
	st, v = call("GET", "/v1/context-prefix", userToken, nil)
	check("GET /v1/context-prefix (observer off)", "Error", st, 404, v)

	st, v = call("POST", "/v1/admin/tokens/revoke", admin, map[string]any{"token": userToken})
	check("POST /v1/admin/tokens/revoke", "RevokeResult", st, 200, v)
	st, v = call("DELETE", "/v1/admin/users/"+userID+"?dryRun=true", admin, nil)
	check("DELETE /v1/admin/users/{id}?dryRun=true", "UserDeletionPreview", st, 200, v)
	st, v = call("DELETE", "/v1/admin/users/"+userID, admin, nil)
	check("DELETE /v1/admin/users/{id}", "UserDeletion", st, 200, v)
}
```

The `GET /v1/me/tokens` list key is `tokens`, and each item carries `label` and `tokenHash` (`clients/go/management.go` `Token`).

Run `cd clients/smoke && go test ./...`: expect FAIL with `undefined: Validate`.

- [ ] Implement `schema.go`. Run `cd clients/smoke && go test -count=1 ./...`: expect PASS (`TestValidateCatchesMissingRequired` passes, and `TestResponsesMatchSchemas` shows as SKIP with its reason).
- [ ] Implement `cmd/mint/main.go` and `run.sh`.
- [ ] Add two jobs to `.github/workflows/sdk.yml`. The toolchain setup actions for Ruby, PHP and Swift do not work on the ARC runners (Tasks 12–15 moved those jobs into containers), so each language runs in its own image instead of one host job with nine setup actions:
  - `sdk-smoke-build` (`runs-on: arc-azrtydxb-amd64`, `needs: [python, typescript, dotnet, java, rust, c, ruby, php, swift]`): `actions/setup-go`, then `CGO_ENABLED=0 go build` of `./go/cmd/novamem-server`, `./clients/smoke/cmd/mint` and `./clients/smoke/cmd/embed` into `smoke-bin/`, uploaded with `actions/upload-artifact` as `smoke-bin`.
  - `sdk-smoke` (`needs: [sdk-smoke-build]`, `timeout-minutes: 30`, `fail-fast: false`): a matrix of `{lang, image}` — python `python:3.13-bookworm`, typescript `node:24-bookworm`, dotnet `mcr.microsoft.com/dotnet/sdk:8.0`, java `maven:3.9-eclipse-temurin-21`, rust and c `rust:1-bookworm`, ruby `ruby:3.2-bookworm`, php `composer:2`, swift `swift:6.3-noble`, and schema `golang:1.26-bookworm` — with `container.image: ${{ matrix.image }}` and a `services.postgres` block: image `pgvector/pgvector:pg16`, `POSTGRES_USER=novamem`, `POSTGRES_PASSWORD=novamem`, `POSTGRES_DB=novamem`, options `--health-cmd "pg_isready -U novamem" --health-interval 5s --health-timeout 5s --health-retries 20`. Steps:
    1. `actions/checkout`, `actions/download-artifact` (`smoke-bin`), `chmod +x smoke-bin/*`, and `sh clients/smoke/run.sh <lang> build` (before the server starts: a build is not what `down` measures).
    2. Start `smoke-bin/embed -addr 127.0.0.1:7779` and `smoke-bin/novamem-server` in the background, writing the server's PID to `$RUNNER_TEMP/server.pid`, with `NOVAMEM_WARM_URL=postgres://novamem:novamem@postgres:5432/novamem?sslmode=disable`, `NOVAMEM_COLD_PROVIDER=pgvector`, `NOVAMEM_EMBEDDINGS_PROVIDER=openai-compatible`, `NOVAMEM_EMBEDDINGS_ENDPOINT=http://127.0.0.1:7779/v1`, `NOVAMEM_EMBEDDINGS_MODEL=smoke-hash`, `NOVAMEM_AUTH_MODE=user`, `NOVAMEM_COOKIE_SECRET=sdk-smoke-cookie-secret-0123456789`, `NOVAMEM_BOOTSTRAP_ADMIN_EMAIL=smoke-admin@example.com`, `NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD=smoke-admin-password`, `NOVAMEM_INSECURE_COOKIES=1`, `NOVAMEM_PORT=7778` and `NOVAMEM_BASE_URL=http://127.0.0.1:7778`.
    3. `ADMIN=$(smoke-bin/mint -wait 90s -email smoke-admin@example.com -password smoke-admin-password)`, `echo "::add-mask::$ADMIN"`, exported as `NOVAMEM_SMOKE_ADMIN_TOKEN`; a second token with `-label sdk-smoke-user`, masked, exported as `NOVAMEM_SMOKE_TOKEN`.
    4. schema: `NOVAMEM_SMOKE_URL=http://127.0.0.1:7778 go test -count=1 -v -run TestResponsesMatchSchemas ./clients/smoke/...`. Every other language: `sh clients/smoke/run.sh <lang> up`.
    5. Stop the server (`kill "$(cat "$RUNNER_TEMP/server.pid")"`) and wait, in a `sleep 1` loop of at most 30 s, until the process is gone or a zombie (`/proc/<pid>/status` State `Z`: the job container's PID 1 does not reap children, and an exited process has closed its socket).
    6. Every language but schema: `sh clients/smoke/run.sh <lang> down`.
- [ ] Run `actionlint .github/workflows/sdk.yml`: expect PASS. Push and open the PR: expect every `sdk-smoke` matrix leg green, each with the log lines `PASS <lang> up` and `PASS <lang> down`, and the schema leg with `TestResponsesMatchSchemas` PASS (not SKIP).
- [ ] Falsifiability check on a scratch commit (dropped before merge): make `clients/python/smoke.py`'s `down` step accept an empty result. Expect `sdk-smoke` to fail with `FAIL python`. Separately, add `bogus` to `ProvisionedUser.required` in `api/openapi.yaml` and regenerate: expect `TestResponsesMatchSchemas` to fail with `POST /v1/admin/users: $.bogus: required field missing`. Drop both.
- [ ] Commit `ci(sdk): live smoke of every SDK against a server built from the PR`.

## Task 17: Release workflows

Files:

- `.github/workflows/release-sdk-python.yml`, `release-sdk-typescript.yml`, `release-sdk-dotnet.yml`, `release-sdk-java.yml`, `release-sdk-rust.yml`, `release-sdk-c.yml`, `release-sdk-ruby.yml`, `release-sdk-php.yml`, `release-sdk-swift.yml` (created)
- `scripts/check-sdk-tag-triggers.sh` (created)
- `.github/dependabot.yml` (modified: entries for `pip` `/clients/python`, `npm` `/clients/typescript`, `nuget` `/clients/dotnet`, `maven` `/clients/java`, `cargo` `/clients/rust` and `/clients/c/novamem-ffi`, `bundler` `/clients/ruby`, `composer` `/clients/php`, `swift` `/clients/swift`, and `gomod` `/clients/contract`, `/clients/gen`, `/clients/smoke`; all `interval: weekly`)
- `.github/actionlint.yaml` (unchanged: the runners are already listed)
- `.github/workflows/sdk.yml` (modified: a `triggers` job running `sh scripts/check-sdk-tag-triggers.sh`)

Interfaces:

- Each workflow triggers on `on: push: tags: ["clients/<lang>/v*"]` only, uses `permissions: contents: write, id-token: write` where the registry supports trusted publishing, and runs on `arc-azrtydxb-amd64`. Its jobs are:
  - `verify`: `uses: ./.github/workflows/sdk.yml` — the whole SDK workflow (now also `on: workflow_call`), live smoke included, rather than a copy of one job's steps that could drift from it.
  - `version-matches-tag`: fails unless the manifest version equals the tag's `X.Y.Z`. The manifest version comes from `pyproject.toml`, `package.json`, the `.csproj`, `pom.xml`, `Cargo.toml` or `novamem.gemspec`. PHP and Swift have no manifest version, so this job is skipped for them.
  - `publish`, with `needs: [verify, version-matches-tag]`.
- Publish commands and secrets:
  - python: `python -m pip install build==1.3.0 && python -m build clients/python`, then `pypa/gh-action-pypi-publish@release/v1` with `packages-dir: clients/python/dist` (trusted publishing; no secret).
  - typescript: `npm publish --provenance --access public` in `clients/typescript`, with `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`. Then a `TestNpmDeprecationState` step: `test -z "$(npm view @azrtydxb/novamem@${VERSION} deprecated)"` and `test -n "$(npm view @azrtydxb/novamem@1.1.3 deprecated)"`.
  - dotnet: `dotnet pack -c Release clients/dotnet/src/Novamem -o out && dotnet nuget push out/*.nupkg --api-key ${{ secrets.NUGET_API_KEY }} --source https://api.nuget.org/v3/index.json`.
  - java: `mvn -B -P release deploy`, with `MAVEN_CENTRAL_USERNAME`, `MAVEN_CENTRAL_PASSWORD`, `MAVEN_GPG_PRIVATE_KEY` and `MAVEN_GPG_PASSPHRASE` secrets through `actions/setup-java@v5`'s `server-id: central` and `gpg-private-key` inputs.
  - rust: `cargo publish --locked --manifest-path clients/rust/Cargo.toml`, with `CARGO_REGISTRY_TOKEN: ${{ secrets.CARGO_REGISTRY_TOKEN }}`.
  - c: a matrix job builds `cargo build --release --manifest-path clients/c/novamem-ffi/Cargo.toml` on `arc-azrtydxb-amd64` (linux-x86_64) and `arc-azrtydxb-publish` (linux-aarch64, the arm64 runner ci.yml's image build uses), then archives `include/` plus `libnovamem_ffi.a` and `libnovamem_ffi.so` as `novamem-c-${VERSION}-<triplet>.tar.gz`. Only these two Linux triplets exist, matching the recipes from Task 12. It then runs `gh release create "$GITHUB_REF_NAME" --title "novamem C/C++ SDK $VERSION" <archives>` and rewrites the SHA-512s in `clients/c/port/vcpkg/portfile.cmake` and `clients/c/port/conan/conanfile.py`. It opens a PR with those two files (`gh pr create --title "chore(sdk-c): pin ${VERSION} archive hashes"`), because submitting to the vcpkg and Conan central indexes is a manual upstream PR, documented in `clients/c/README.md`.
  - ruby: `gem build clients/ruby/novamem.gemspec && gem push novamem-${VERSION}.gem`, with `GEM_HOST_API_KEY: ${{ secrets.RUBYGEMS_API_KEY }}`.
  - php: the job runs `git subtree split --prefix clients/php -b php-split`, then `git push "https://x-access-token:${{ secrets.SDK_MIRROR_TOKEN }}@github.com/azrtydxb/novamem-php" php-split:main`, then tags the mirror `v${VERSION}` and pushes the tag. Packagist has the mirror registered with its GitHub hook, so it picks up the tag. `SDK_MIRROR_TOKEN` is a fine-grained PAT with `contents: write` on the two mirror repos only.
  - swift: the job runs `swift package describe --package-path clients/swift`, then `git subtree split --prefix clients/swift -b swift-split`, then pushes to `azrtydxb/novamem-swift` `main` with `SDK_MIRROR_TOKEN`, tagging the mirror `${VERSION}` (no `v`, as SwiftPM expects). Consumers use `.package(url: "https://github.com/azrtydxb/novamem-swift", from: "0.1.0")`.
- `scripts/check-sdk-tag-triggers.sh` fails:

  - if any `release-sdk-*.yml` has a tag pattern other than `clients/<its lang>/v*`;
  - or if a `tags` pattern of `release-binaries.yml` or `ci.yml` would match any `clients/<lang>/v0.1.0` (neither does: glob `v*` is anchored at the start). `ci.yml` triggers on `v*` on purpose — server releases publish semver image tags — so the check is that SDK tags never match, not that ci.yml has no tag trigger.

- [ ] Write the failing check `scripts/check-sdk-tag-triggers.sh`:

```sh
#!/bin/sh
# proved by: changing a release-sdk workflow's tag pattern to "v*" fails this script.
set -eu
cd "$(dirname "$0")/.."
fail=0
for lang in python typescript dotnet java rust c ruby php swift; do
  f=".github/workflows/release-sdk-$lang.yml"
  [ -f "$f" ] || { echo "missing $f"; fail=1; continue; }
  pats=$(python3 -c "import sys,yaml;d=yaml.safe_load(open('$f'));print('\n'.join((d.get(True) or d.get('on'))['push']['tags']))")
  [ "$pats" = "clients/$lang/v*" ] || { echo "$f: tags = $pats, want clients/$lang/v*"; fail=1; }
done
python3 - <<'EOF' || fail=1
import fnmatch, sys, yaml
d = yaml.safe_load(open(".github/workflows/release-binaries.yml"))
pats = (d.get(True) or d.get("on"))["push"]["tags"]
bad = [p for p in pats if fnmatch.fnmatchcase("clients/python/v0.1.0", p)]
if bad: print("release-binaries.yml matches SDK tags:", bad); sys.exit(1)
EOF
exit $fail
```

The script uses PyYAML. The `arc-azrtydxb-amd64` runner image provides `python3-yaml`; if it doesn't, add `sudo apt-get install -y python3-yaml` to the `triggers` job.

Run `sh scripts/check-sdk-tag-triggers.sh`: expect FAIL, printing `missing .github/workflows/release-sdk-python.yml` and eight more `missing` lines.

- [ ] Write the nine workflows. Run `actionlint .github/workflows/release-sdk-*.yml`: expect PASS. Run `sh scripts/check-sdk-tag-triggers.sh`: expect PASS (exit 0).
- [ ] Before the first release, confirm each name is free or already owned by azrtydxb, recording the result in the PR description:

  - `curl -s -o /dev/null -w '%{http_code}' https://pypi.org/pypi/novamem/json` (404 means free)
  - `npm view @azrtydxb/novamem name` (owned)
  - `curl -s https://api.nuget.org/v3-flatcontainer/novamem/index.json` (404 means free)
  - `curl -s "https://central.sonatype.com/api/internal/browse/component/versions?namespace=com.azrtydxb&name=novamem"`
  - `curl -s -o /dev/null -w '%{http_code}' https://crates.io/api/v1/crates/novamem`
  - `curl -s -o /dev/null -w '%{http_code}' https://rubygems.org/api/v1/gems/novamem.json`
  - `curl -s -o /dev/null -w '%{http_code}' https://repo.packagist.org/p2/azrtydxb/novamem.json`

  A name that turns out to be taken by someone else stops this task: record it with `procoder ask` and put it to the user. Never pick a new name unilaterally.

- [ ] Add the dependabot entries and the `triggers` job, then commit `ci(sdk): tag-triggered release workflow per SDK`.
- [ ] One-time setup before the first php and swift releases: create the empty repos `azrtydxb/novamem-php` and `azrtydxb/novamem-swift`, each with a README line saying "Read-only mirror of clients/<lang> in azrtydxb/novamem — open issues and PRs there". Create the `SDK_MIRROR_TOKEN` repo secret, and register `https://github.com/azrtydxb/novamem-php` on Packagist. These are outward-facing actions: confirm with the user before each one.

## Task 18: Documentation

Files:

- `clients/python/README.md`, `clients/typescript/README.md`, `clients/dotnet/README.md`, `clients/java/README.md`, `clients/rust/README.md`, `clients/c/README.md`, `clients/ruby/README.md`, `clients/php/README.md`, `clients/swift/README.md` (created). Each follows the section order of `clients/go/README.md`: title and install line, Quickstart, "The error contract" (the error table in that language's terms), and "Operations" (a table of all 41 methods with route and notes). It also states the server version requirement and the concurrency guarantee.
- `scripts/check-sdk-readmes.sh` (created)
- `docs/sdks.md` (created — the site's pages live in `docs/`, `srcDir` of packages/docs-site) and `packages/docs-site/.vitepress/config.mts` (modified: an "SDKs" sidebar group)
- `README.md` (modified: an "SDKs" table with language, package, install line and a link to each README)
- `.github/workflows/sdk.yml` (modified: a `readmes` matrix job — a `tables` leg and one quickstart leg per language, each in the image its smoke leg uses, running `sh clients/smoke/run.sh <lang> build` then `sh scripts/check-sdk-readmes.sh <lang>`)

Interfaces:

- In each README, the Quickstart is the first fenced code block tagged with the language (`python`, `ts`, `csharp`, `java`, `rust`, `c`, `ruby`, `php`, `swift`), and it's written to compile or run against `NOVAMEM_URL`.
- The script extracts that block into a scratch file and compiles it with the SDK's own toolchain:
  - python: `python -m py_compile`
  - ts: `npx tsc --noEmit`, with the block wrapped in an async function
  - csharp: a throwaway console project referencing the csproj
  - java: `javac` against `target/classes` and the classpath
  - rust: `cargo check --example readme` from a generated `examples/readme.rs`
  - c: `cc -fsyntax-only -Iinclude`
  - ruby: `ruby -c`
  - php: `php -l`
  - swift: `swiftc -parse`
- It counts operations-table rows whose first cell names a method from `routes.json` in the language's casing, and requires all 41. A keyword takes the name the SDK uses: Python `import_`, Java `importEntries`.
- `scripts/check-sdk-readmes.sh [tables|<lang>]`: `tables` checks every README's table, `<lang>` compiles that SDK's Quickstart, and no argument does both for all nine — so CI can run each language in its own image.

- [ ] Write the failing check `scripts/check-sdk-readmes.sh`:

```sh
#!/bin/sh
# proved by: deleting a method row from any clients/<lang>/README.md operations table fails this script.
set -eu
cd "$(dirname "$0")/.."
python3 - <<'EOF'
import json, re, sys, pathlib
routes = json.load(open("clients/contract/routes.json"))
methods = sorted({m["name"] for r in routes.values() for m in r.get("methods", [])})
snake = lambda s: re.sub(r"(?<!^)([A-Z])", r"_\1", s).lower()
camel = lambda s: s[0].lower() + s[1:]
case = {"python": snake, "ruby": snake, "rust": snake, "typescript": camel, "java": camel,
        "swift": camel, "php": camel, "dotnet": lambda s: s + "Async",
        "c": lambda s: None}
fail = []
for lang, f in case.items():
    text = pathlib.Path(f"clients/{lang}/README.md").read_text()
    for m in methods:
        cls, meth = m.split(".")
        name = f"novamem_{snake(cls)}_{snake(meth)}" if lang == "c" else f(meth)
        if not re.search(rf"^\|\s*`{re.escape(name)}\b", text, re.M):
            fail.append(f"{lang}: operations table has no row for {name}")
print("\n".join(fail)); sys.exit(1 if fail else 0)
EOF
for lang in python typescript dotnet java rust c ruby php swift; do
  sh "clients/$lang/check-readme.sh" || { echo "FAIL $lang quickstart"; exit 1; }
done
```

Each `clients/<lang>/check-readme.sh` (created in this task, and listed here as part of each SDK's Files) extracts and compiles the Quickstart as described in Interfaces.

Run `sh scripts/check-sdk-readmes.sh`: expect FAIL with `FileNotFoundError: ... clients/python/README.md`.

- [ ] Write the nine READMEs and the nine `check-readme.sh` scripts. Run `sh scripts/check-sdk-readmes.sh`: expect PASS.
- [ ] Mutation check: delete the `search` row from `clients/python/README.md` and re-run. Expect FAIL with `python: operations table has no row for search`. Revert.
- [ ] Write `docs/sdks.md`, with one heading per language and its install line (`pip install novamem`, `npm install @azrtydxb/novamem`, `dotnet add package Novamem`, the Maven coordinates `com.azrtydxb:novamem:0.1.0`, `cargo add novamem`, the release archive and vcpkg/Conan note for C/C++, `gem install novamem`, `composer require azrtydxb/novamem`, and SwiftPM `.package(url: "https://github.com/azrtydxb/novamem-swift", from: "0.1.0")`). Add the sidebar entry. Run `cd packages/docs-site && pnpm build`: expect PASS.
- [ ] Add the SDK table to the root `README.md`.
- [ ] Add the `readmes` matrix job to `sdk.yml` (`needs: [generated]`; the quickstart checks need only toolchains, not a green SDK suite).
- [ ] Commit `docs(sdk): READMEs, docs-site SDK page and root SDK table`.
