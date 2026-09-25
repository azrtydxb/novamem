# language-sdks

Status: complete

Decision record: [ADR 0009](../adr/0009-language-sdks-held-to-one-shared-contract.md).
Reference implementation: `clients/go` (its behaviour is the contract; this
spec transcribes it, it does not redefine it).

## Problem

novamem's only client library is Go (`clients/go`). Everyone else calls the
HTTP API directly, which means every integrator has to rediscover the rules
that keep an agent honest. The main one: "nothing is stored about that" must
never be confused with "I could not reach the store". Getting it wrong ships
an agent that tells a person "I have no record of that" while a pod is
restarting. Most agent frameworks live in Python and TypeScript, and
enterprise integrators live on .NET and the JVM. None of them get the
contract today. ADR 0002 refused extra bindings because hand-kept bindings
drift. This spec ships nine bindings with drift made mechanically impossible
to miss.

## Users

- **Application / agent developers** in Python, TypeScript/JS, C#/.NET,
  Java/Kotlin, Rust, C/C++, Ruby, PHP, Swift. They need a typed client whose
  errors say whether the store was consulted, installable from their
  language's registry, with zero or near-zero transitive dependencies.
- **Orchestrator authors** provisioning one novamem user per agent. They need
  the `Admin` surface (ProvisionUser, RevokeUserToken, …) in their language.
- **novamem maintainers.** When they change `api/openapi.yaml`, CI must
  show which SDK is now out of date. When they fix contract behaviour, one
  shared scenario file must prove all ten bindings (Go included) agree.

## In scope

- [S-16] **Fill the response-schema gaps in `api/openapi.yaml`.** Nine
  routes the SDKs wrap declare no response schema:
  `POST /v1/admin/tokens/revoke`, `GET /v1/admin/users`,
  `POST /v1/admin/users`, `DELETE /v1/admin/users/{id}` (both the dry-run
  and the real shape), `PUT /v1/admin/users/{id}/quota`,
  `GET /v1/context-prefix`, `GET /v1/me/export`, `POST /v1/me/import` and
  `DELETE /v1/me/tokens/{hash}`. Each gets a named schema in the spec's
  components section, transcribed from the Go handler that writes it.
  Handlers are not changed. `gen-contract` regenerates
  `docs/api/openapi.json`, and the live smoke job (S-13) checks each
  route's real response against its schema. The three dashboard-only
  routes that also lack schemas (`GET /v1/admin/audit-log`,
  `GET /v1/admin/metrics`, `GET /v1/me/metrics`) stay non-goals and stay
  unschema'd.
- [S-1] **Shared behaviour suite.** `clients/contract/scenarios.json` (shape
  in Data), plus a scenario runner in `clients/go` that runs every scenario
  against the Go client. Go is retrofitted first and must pass every
  scenario before any other SDK starts.
- [S-2] **Shared route map.** `clients/contract/routes.json` becomes the
  single list of API routes and how each is covered: the method name, or
  a non-goal with its reason. The existing Go `routeMap` moves into it.
  Every SDK's route-coverage test reads it and asserts (a) every route in
  `docs/api/openapi.json` has an entry, and (b) every entry mapped to a
  method resolves to a public method in that SDK. Each method entry also
  names its request type (for example `SearchRequest`), which is the name
  the generator gives that operation's inline request body. The move also
  corrects five existing entries that name the wrong class:
  `Client.Adoption`, `Client.Decay`, `Client.Evaluate`, `Client.Hygiene`
  and `Client.Observe` are `Management` methods. `GET /v1/me/today`
  pointed at a `Management.Today` that doesn't exist, and is now a non-goal.
  These corrections landed first in `clients/go/routecoverage_test.go` (PR
  #305, guarded by `TestRouteMapNamesRealMethods`); S-2 carries them into
  `routes.json`.
- [S-3] **Type generator.** `clients/gen`, a Go module added to the repo's Go workspace file.
  It reads `docs/api/openapi.json` (the generated JSON copy of
  `api/openapi.yaml`) and `clients/contract/routes.json`, and writes request/response types for all
  nine languages from one template per language. The generated files are
  checked in, and CI regenerates them and fails on any diff.
- [S-4] **Python SDK** in `clients/python`, published to PyPI as `novamem`.
- [S-5] **TypeScript SDK** in `clients/typescript`, published to npm as
  `@azrtydxb/novamem` 2.0.0; publishing it lifts the 1.x deprecation.
- [S-6] **.NET SDK** in `clients/dotnet`, published to NuGet as `Novamem`.
- [S-7] **Java SDK** in `clients/java`, published to Maven Central as
  `com.azrtydxb:novamem`.
- [S-8] **Rust SDK** in `clients/rust`, published to crates.io as `novamem`.
- [S-9] **C/C++ SDK** in `clients/c`: a C ABI over the Rust SDK (a
  `novamem-ffi` crate using cbindgen) plus a header-only C++17 wrapper
  `clients/c/include/novamem.hpp`. Shipped as GitHub-release archives per platform and as a
  vcpkg port and a Conan recipe.
- [S-10] **Ruby SDK** in `clients/ruby`, published to RubyGems as `novamem`.
- [S-11] **PHP SDK** in `clients/php`, published to Packagist as
  `azrtydxb/novamem` from the read-only mirror repo `azrtydxb/novamem-php`,
  which the release workflow fills with `git subtree split` of `clients/php`
  and tags `vX.Y.Z` (Packagist reads the Composer manifest only from a repo root).
- [S-12] **Swift SDK** in `clients/swift`, a SwiftPM package with product
  `Novamem`, consumed from the read-only mirror repo
  `azrtydxb/novamem-swift`, which the release workflow fills with
  `git subtree split` of `clients/swift` and tags `X.Y.Z` (SwiftPM resolves
  only a root-level package manifest and root semver tags).
- [S-13] **Live smoke job.** One CI job on `arc-azrtydxb-amd64` that runs
  Postgres (pgvector) as a service container and the server built from the
  PR's source, then runs each SDK's smoke test (capture → search → forget)
  against it.
- [S-14] **Release workflows.** One tag-triggered workflow per SDK. The tag
  is `clients/<lang>/vX.Y.Z`, where `<lang>` is one of `python`,
  `typescript`, `dotnet`, `java`, `rust`, `c`, `ruby`, `php`, `swift`.
  Each workflow runs the SDK's suite and publishes to its registry.
- [S-15] **Docs.** Each SDK gets a README in the same shape as
  `clients/go/README.md` (quickstart, error contract, operations table).
  docs-site gets one "SDKs" page listing install lines. The
  top-level README gets an SDK table.

## Out of scope

- An MCP client in any language (MCP hosts use the official MCP SDKs).
- Changes to the server's HTTP behaviour. S-16 adds schemas that describe
  what the handlers already return; if a handler's output is found to be
  wrong while transcribing it, that is a separate fix.
- Automatic retries inside any SDK. The contract says the caller owns the
  retry budget.
- Environment-variable configuration inside any SDK (no `NOVAMEM_URL`
  reads). Configuration is injected, as in Go.
- A native C implementation (C goes through the Rust SDK; see S-9).
- Apple-platform CI (Swift is verified on Linux only; macOS/iOS builds are
  not exercised in CI).
- Kotlin-specific or coroutine APIs (Kotlin uses the Java SDK).
- Browser bundles and CORS handling for the TS SDK. It targets Node 20+,
  Deno and Bun through global `fetch`; browser use works where CORS allows
  it but isn't tested.
- Retiring or rewriting `clients/go`'s hand-written types. Go keeps its
  hand-written types; only the route map moves (S-2).

## Constraints

- **Runtime floors:** Python 3.10, Node 20, .NET 8, Java 17, Rust 1.80
  (MSRV), Ruby 3.2, PHP 8.2, Swift 5.9 (declared platforms macOS 13 /
  iOS 16 / Linux), C11, C++17.
- **Dependencies: standard library only**, with these named exceptions and
  no others:
  - Java: `com.fasterxml.jackson.core:jackson-databind` (no stdlib JSON).
  - Rust: `reqwest` (default-features off, `rustls-tls` + `json`),
    `serde`, `serde_json`, `tokio` (only what reqwest needs), `thiserror`.
  - C/C++: none at runtime beyond the bundled Rust static library.
    cbindgen is build-time only.
  - PHP: `ext-curl` and `ext-json` (both platform extensions, not
    Composer packages).
  - Swift on Linux: `FoundationNetworking` (part of the toolchain).
- **HTTP clients:** Python's stdlib urllib (sync), with the async client
  running the sync one in a worker thread via asyncio; TS global `fetch`; .NET
  `HttpClient`; Java `java.net.http.HttpClient`; Rust `reqwest`; Ruby
  `Net::HTTP`; PHP curl; Swift `URLSession`.
- **Sync/async per language** (idiomatic): Python both (`Client` and
  `AsyncClient`); TS async only (Promises); .NET async only (`Task`, every
  method takes a `CancellationToken`); Java sync methods plus `*Async`
  variants returning `CompletableFuture`; Rust async only; C and C++
  blocking (the FFI crate owns a private tokio runtime); Ruby sync; PHP
  sync; Swift `async throws`.
- **Naming:** each language's idiom, derived mechanically from the Go
  name: Python/Ruby `snake_case` (`session_recap`); TS/Java/Swift
  `camelCase` (`sessionRecap`); .NET `PascalCase` + `Async` suffix
  (`SessionRecapAsync`); Rust `snake_case`; C
  `novamem_<class>_<snake>` (`novamem_client_session_recap`). Classes are
  `Client`, `Management`, `Admin` in every language (C: opaque
  `novamem_client*`, `novamem_management*`, `novamem_admin*`).
- **Surface:** full Go parity. All 41 public methods of `Client` (13),
  `Management` (22) and `Admin` (6), exactly as listed in `clients/contract/routes.json`.
- **Versioning:** independent semver per SDK, starting at `0.1.0` (TS
  starts at `2.0.0` because 1.x is taken). Each README states the minimum
  server version it needs. The first release of each SDK requires the
  server release current at merge time.
- **Security:** the bearer token never appears in any error message,
  exception, `toString`/`repr`/`Debug`/`inspect` output, or log line,
  including when the server echoes it back. Replace it with `[redacted]`,
  as Go does. The token is sent only in the `Authorization` header, never
  in a URL.
- **Bounded calls:** every call has a timeout. The default is 15 s,
  configurable per client, and it applies even when the caller supplies
  no deadline or cancellation.
- **Response cap:** bodies over 8 MiB are rejected as unavailable (Go
  `maxResponseBytes`).
- **CI runners:** `arc-azrtydxb-amd64` for all SDK jobs. No GitHub-hosted
  runners; no local Docker Desktop.
- **Repo rules:** no AI co-author trailers in commits; every Copilot and
  Claude review comment must be resolved before merge (CLAUDE.md).

## Interfaces

**Constructor (every language):** `Client`, `Management` and `Admin` each
take a config with `baseUrl` (required, absolute http(s), trailing slash
tolerated), `token` (required, non-blank), `timeout` (optional, default
15 s) and an optional injected HTTP client/transport where the language
has one. Construction fails immediately on a missing or invalid base URL
or a blank token. The error names the field and never quotes the token.

**Error model (every language), transcribed from `clients/go/novamem.go`:**

| Condition                                                      | unavailable                                 | retryable | not_found | canceled |
| -------------------------------------------------------------- | ------------------------------------------- | --------- | --------- | -------- |
| Dial refused / DNS failure / connection reset / TLS            | yes                                         | yes       | no        | no       |
| Timeout (client timeout or caller deadline)                    | yes                                         | yes       | no        | no       |
| Caller cancellation                                            | no                                          | no        | no        | yes      |
| HTTP 5xx                                                       | yes                                         | yes       | no        | no       |
| HTTP 429                                                       | yes                                         | yes       | no        | no       |
| HTTP 404                                                       | no                                          | no        | yes       | no       |
| HTTP 400 / 401 / 403 / other 4xx                               | no                                          | no        | no        | no       |
| 2xx with empty body where a payload is expected                | yes                                         | no        | no        | no       |
| 2xx with a body that is not valid JSON                         | yes                                         | no        | no        | no       |
| 200 `{results: [], degraded: true}` on search/recent/neighbors | yes                                         | yes       | no        | no       |
| 200 degraded **with** results                                  | — returned as data, `degraded=true` exposed |           |           |          |
| Body over 8 MiB                                                | yes                                         | no        | no        | no       |

Every error exposes `op` (the Go op string: `search`, `capture`, …),
`statusCode` (0 when no response), `code` (the server's `code` field, or
empty) and `message` (the server's `error` field, or the raw body
truncated to 256 characters and marked with `…`, token redacted).

Per-language shape:

- **Python:** `NovamemError(Exception)` with `.op .status_code .code
.message .unavailable .retryable`. Subclasses `UnavailableError`,
  `NotFoundError`, `CanceledError`.
- **TS:** `class NovamemError extends Error` with the same fields plus
  `isUnavailable(e)`, `isRetryable(e)` and `isNotFound(e)` helpers.
- **.NET:** `NovamemException` with `Op`, `StatusCode`, `Code`,
  `IsUnavailable`, `IsRetryable` and `IsNotFound`. Cancellation surfaces
  as `OperationCanceledException`.
- **Java:** unchecked `NovamemException` with the same accessors.
  Cancellation surfaces as `CancellationException`.
- **Rust:** `novamem::Error` (thiserror) with `is_unavailable()`,
  `is_retryable()`, `is_not_found()`, `op()`, `status()` and `code()`.
- **C:** every call returns `novamem_status` (`NOVAMEM_OK`,
  `NOVAMEM_ERR`) and fills a caller-provided `novamem_error*` whose fields
  are `op`, `status_code`, `code`, `message`, `unavailable`, `retryable`,
  `not_found` and `canceled`. Result structs are freed with
  `novamem_<type>_free`. C++ throws `novamem::Error` carrying the same
  fields.
- **Ruby:** `Novamem::Error < StandardError` with `unavailable?` and
  `retryable?`, and `Novamem::NotFoundError`.
- **PHP:** `Novamem\NovamemException` with `isUnavailable()`,
  `isRetryable()` and `isNotFound()`.
- **Swift:** `NovamemError: Error` struct with the same fields. Cancellation
  surfaces as `CancellationError`.

**Method-specific behaviour (every language):**

- `forget`: a 404 returns `{deleted: false, coldDeleteOk: true}` with no
  error. A blank id fails locally (op `forget`, message `id is required`)
  without sending a request. It never reports `deleted: true` on any
  failure.
- `capture` / `remember`: blank content fails locally. `CaptureResult`
  exposes `saved` (true when the id is non-empty), and a declined
  worthiness gate is not an error.
- `today`: `recent` with `since` set to now − 24 h.
- `health`: a served `{ok: false}` returns `false`, not an error.
- `contextPrefix`: a 404 is a not-found error (observer disabled).
- GET and DELETE-without-body calls send no request body. Every call sends
  `Accept: application/json`; calls with a body send
  `Content-Type: application/json`.

**Generator CLI:** `go run ./clients/gen -spec docs/api/openapi.json -routes clients/contract/routes.json -out clients`
writes `clients/<lang>/<generated path>` for every language (paths listed
under Data). `-check` exits 1 and prints the differing files instead of
writing.

**Release tags:** `clients/<lang>/vX.Y.Z` triggers
`.github/workflows/release-sdk-<lang>.yml`. This does not collide with the
server's `v*` tags or with Go's `clients/go/vX.Y.Z` module tags.

## Data

**Scenario server:** one Go program, `clients/contract/cmd/scenario-server`,
replays scenarios for every SDK, so no SDK carries its own fake HTTP server.
Running `go run ./cmd/scenario-server -scenarios scenarios.json` from
`clients/contract` listens on `127.0.0.1:0` and prints one line,
`listening http://127.0.0.1:<port> closed=<port>`. `closed` is a port it
bound and released at startup, used for the `refused` fault. A runner
builds its client with base URL `http://127.0.0.1:<port>/s/<scenario-id>`,
makes the call, then reads `GET /_verdict/<scenario-id>`, which returns
`{"requests": <n>, "mismatches": ["..."]}` and resets that scenario. A
non-empty `mismatches` fails the scenario.

**`clients/contract/scenarios.json`** (hand-written, versioned by `version`):

```json
{
  "version": 1,
  "token": "nm_scenario_TOKEN_must_never_leak",
  "timeoutMs": 300,
  "scenarios": [
    {
      "id": "search-degraded-empty-is-unavailable",
      "call": {
        "class": "Client",
        "op": "search",
        "args": { "query": "coffee" }
      },
      "respond": { "status": 200, "json": { "results": [], "degraded": true } },
      "expectRequest": {
        "method": "POST",
        "path": "/v1/search",
        "json": { "query": "coffee" }
      },
      "expect": {
        "outcome": "unavailable",
        "retryable": true,
        "statusCode": 200
      }
    }
  ]
}
```

- `respond` is exactly one of: `{status, json}`; `{status, raw}` (raw
  string body, for HTML error pages and empty bodies); `{fault: "refused"}`
  (the runner points the client at a closed port); `{fault: "timeout"}`
  (the server sleeps `timeoutMs + 500` ms); `{fault: "reset"}` (the server
  closes the socket without responding); `{fault: "oversize"}` (a 200 with
  a 9 MiB body).
- `expect.outcome` is one of `ok`, `empty`, `unavailable`, `not_found`,
  `error` or `canceled`. `ok` and `empty` may carry `result` (a JSON
  subset the SDK's result must contain, compared on generated field
  names). `error` outcomes may carry `statusCode` and `code`.
- **Global invariant**, checked by every runner on every non-`ok`
  outcome: the error's message, string form and debug form do not
  contain `token`.
- `respond` and `expectRequest` may instead be arrays, consumed in order, for
  methods that make more than one request (`RemoveProjectMemberByUsername`
  lists members, then deletes one).
- `call.cancelAfterMs` (optional) makes the runner cancel the call after
  that many milliseconds. These scenarios carry `"requires": ["cancel"]`.
  They run only in SDKs with a cancellation primitive: Python
  `AsyncClient`, TS (`AbortSignal`), .NET (`CancellationToken`), Java
  (`*Async` future `cancel`) and Swift (`Task.cancel`). Python `Client`,
  Rust (dropping a future returns nothing to classify), C, C++, Ruby and
  PHP skip them, and their runners print each skipped id.
- `expect.messageContains` (optional) must appear in the error message, compared case-insensitively.
- `expectRequest` is optional. When present, the runner asserts method,
  path and JSON body (subset match), and always asserts
  `Authorization: Bearer <token>`.
- Minimum scenario set for version 1: one scenario per row of the error
  table above, for both a read op (`search`) and the write op
  (`capture`); the four `forget` cases (ok, 404 → not deleted, 500 →
  error, blank id → local error with no request made); `health` with
  `{ok:false}`; `today` sending a `since` within ±60 s of now − 24 h;
  token echoed in a 401 body; the GET-sends-no-body check on `stats`; one
  success scenario per remaining method (41 total). The runner fails if
  any public method has no scenario.

**`clients/contract/routes.json`**: an object mapping `"METHOD /path"` to
either `{"methods": [ ... ]}` or `{"nonGoal": "<reason>"}`. Each method
object is `{"name": "Client.Search", "request": "SearchRequest",
"response": "SearchResult"}`. A method whose Go signature takes scalars
lists them instead of `request`: `{"name": "Management.CreateProject",
"params": ["name"], "response": "Project"}`. `response` names a schema in
the components section, or is `null` for no-payload routes. One route can
carry several methods (`POST /v1/recent` has `Client.Recent` and
`Client.Today`). The union of all `name`s is the SDK surface of 41
methods, and the generator emits each language's scenario dispatch table
from it. It
starts as a verbatim transcription of `clients/go/routecoverage_test.go`'s
`routeMap`, and the Go test is rewritten to read it.

**Generated type files** (checked in, `// Code generated by clients/gen. DO
NOT EDIT.` header in each language's comment syntax):
`clients/python/src/novamem/_types.py` (dataclasses),
`clients/typescript/src/types.ts` (interfaces),
`clients/dotnet/src/Novamem/Types.g.cs` (records, System.Text.Json
attributes), `clients/java/src/main/java/com/azrtydxb/novamem/types/*.java`
(classes with Jackson annotations), `clients/rust/src/types.rs` (serde
structs), `clients/c/include/novamem_types.h` (C structs, generated from
the Rust types via cbindgen, not by `clients/gen`),
`clients/ruby/lib/novamem/types.rb` (Structs with `from_h`/`to_h`),
`clients/php/src/Types/*.php` (readonly classes with `fromArray`/`toArray`),
`clients/swift/Sources/Novamem/Types.swift` (Codable structs). Wire field
names are preserved exactly (the server's schemas are strict: a misspelled
field is a 400). Optional fields are omitted from request JSON when unset,
never sent as `null`.

Nothing is persisted at runtime; the SDKs hold no state beyond the
config and the HTTP client.

## Edge cases

- Base URL with a trailing slash, a path prefix (`https://h/novamem`), or
  surrounding whitespace: trimmed; the path prefix is preserved.
- Base URL that isn't absolute (`localhost:7778`, no scheme): rejected at
  construction.
- Token equal to a substring of a server message (for example a very
  short token): redaction still replaces every occurrence.
- Empty-string optional fields in requests, such as `project: ""`: omitted,
  same as unset.
- `since` timestamps: always sent as RFC 3339 UTC with a `Z` suffix, in
  every language. Local-time inputs are converted.
- Large integers (sequence numbers in `Changes`): parsed as 64-bit, never
  as JS float. The TS SDK uses `number` only where the spec says `int32`,
  and `string` for int64 fields.
- Unknown fields in responses: ignored in every language, so a newer
  server works with an older SDK.
- A 2xx on a no-payload endpoint (`SetUserQuota`, `SetActiveProject`):
  success, and the body is not parsed.
- Concurrent use: every client is safe to share across threads/tasks
  where the language has them; READMEs state this.
- The server returns HTML (a proxy error page) with status 200:
  unavailable, not retryable.
- A caller cancels mid-flight: reported as canceled, never as
  unavailable.

## Failure modes

- **Server unreachable, slow or returning garbage:** the whole point of
  the error table. Each case is a scenario, and each SDK must classify it
  as specified.
- **`api/openapi.yaml` changes without regeneration:** `clients/gen
-check` fails in CI, naming the stale files.
- **New route added without SDK decisions:** every SDK's route-coverage
  test fails, naming the route missing from `routes.json`.
- **routes.json maps a method one SDK lacks:** that SDK's coverage test
  fails, naming the method.
- **The generator meets a schema construct it doesn't support**
  (`oneOf` without a discriminator, for example): it exits non-zero,
  naming the schema path. It never emits a partial file.
- **ARC runner lacks service-container support:** the live smoke job
  can't start Postgres. The first plan task probes this. If it fails, the
  smoke job starts Postgres as a process on the runner instead
  (`postgres` from the runner's package manager, or the pgvector binary
  image extracted). This fallback changes only the job's setup steps,
  not the tests.
- **Registry publish fails** (bad credential, name taken, version exists):
  the release workflow fails red and leaves the tag in place. Nothing is
  retried automatically. Name availability for all eight registries is
  checked and each name reserved before the first release.
- **Rust SDK breaks:** the C/C++ SDK breaks with it. The C job depends on
  the Rust job, so the failure is reported once, at its source.
- **Jackson CVE:** Dependabot covers `clients/java` (the Maven ecosystem
  is added to `.github/dependabot.yml`), and likewise cargo, nuget, pip,
  npm, bundler, composer and swift entries for their directories.

## Acceptance criteria

- [ ] [S-1] `cd clients/go && go test -run TestScenarios ./...` runs every scenario in `clients/contract/scenarios.json` against the Go client and passes; the runner itself fails if any of the 41 public methods of Client, Management and Admin has no scenario. Fails if `degradedEmpty` is removed from `clients/go/novamem.go` (scenario `search-degraded-empty-is-unavailable` goes red).
- [ ] [S-1] Scenario `token-echoed-in-401-is-redacted` passes in every SDK's scenario run. Fails if the token-redaction line is removed from any one SDK. Asserted by `TestScenarios` in each SDK's runner.
- [ ] [S-2] `cd clients/go && go test -run TestEveryRouteIsAccounted ./...` reads `clients/contract/routes.json` and passes, and each other SDK's route-coverage test (named per SDK in the plan) passes on the same file. Fails if a route is added to `api/openapi.yaml` without a `clients/contract/routes.json` entry, or if an entry names a method an SDK lacks.
- [ ] [S-3] `go run ./clients/gen -check -spec docs/api/openapi.json -routes clients/contract/routes.json -out clients` exits 0, and CI runs it on every PR. Fails if one property name in `api/openapi.yaml` is edited without regenerating (it exits 1 and names every stale generated file, including each language's types file), or if a generated file lacks the `Code generated by clients/gen. DO NOT EDIT.` header.
- [ ] [S-4] `cd clients/python && python -m unittest discover -s tests` passes the full scenario suite for `Client` and `AsyncClient` on Python 3.10 and 3.13, and `pip install .` in a fresh venv installs no other package (checked by `pip list --format=freeze` showing only `novamem`). Fails if any scenario is misclassified or a runtime dependency is added to `clients/python/pyproject.toml`.
- [ ] [S-5] `cd clients/typescript && node --test` passes the full scenario suite on Node 20 and 24, and `npm pack --dry-run --json` shows a `package.json` with no `dependencies` key. Fails if any scenario is misclassified or a runtime dependency is added.
- [ ] [S-6] `cd clients/dotnet && dotnet test` passes the full scenario suite on .NET 8, and `dotnet list clients/dotnet/src/Novamem package` reports no package references. Fails if any scenario is misclassified or a NuGet reference is added. Asserted by `TestScenarios` (xUnit, `clients/dotnet/tests`).
- [ ] [S-7] `cd clients/java && mvn -B verify` passes the full scenario suite on Java 17 and 21, and `mvn dependency:tree -Dscope=runtime` lists only jackson-databind, jackson-core and jackson-annotations. Fails if any scenario is misclassified or another runtime dependency is added. Asserted by `TestScenarios` (JUnit 5, `clients/java/src/test`).
- [ ] [S-8] `cd clients/rust && cargo test` passes the full scenario suite on Rust 1.80 and stable, and `cargo tree --depth 1 -e normal` lists only reqwest, serde, serde_json, tokio and thiserror. Fails if any scenario is misclassified or another dependency is added. Asserted by `TestScenarios` (`clients/rust/tests/scenarios.rs`, fn `test_scenarios`).
- [ ] [S-9] `make -C clients/c test` builds the static library and header, then runs a C11 and a C++17 scenario runner that both pass the full suite, and `make -C clients/c memcheck` (valgrind with `--error-exitcode=1 --leak-check=full`) exits 0. Fails if any scenario is misclassified or any `novamem_*_free` path leaks.
- [ ] [S-10] `cd clients/ruby && ruby -Ilib -e 'require "novamem"'` succeeds with no gems installed, and `cd clients/ruby && ruby -Ilib -Itest test/scenarios_test.rb` passes the full suite on Ruby 3.2. Fails if any scenario is misclassified or a gem dependency is added to `clients/ruby/novamem.gemspec`. Asserted by `TestScenarios` (minitest).
- [ ] [S-11] `cd clients/php && composer install --no-dev && composer show --no-dev` lists no packages, and `vendor/bin/phpunit` passes the full scenario suite on PHP 8.2 and 8.4. Fails if any scenario is misclassified or a non-dev `require` beyond php/ext-curl/ext-json is added to `clients/php/composer.json`.
- [ ] [S-12] `cd clients/swift && swift test` passes the full scenario suite on Linux with Swift 5.9 and the latest release, and `swift package show-dependencies` prints no dependencies. Fails if any scenario is misclassified or a dependency is added to `clients/swift/Package.swift`. Asserted by `TestScenarios` (XCTest).
- [ ] [S-13] The `sdk-smoke` job in `.github/workflows/sdk.yml` starts Postgres and a server built from the PR source on `arc-azrtydxb-amd64`, mints a user token, and for each of the nine SDKs runs `smoke` (capture, then search finds it, then forget returns deleted=true, then search no longer finds it), reporting the SDK and step on failure. Fails if any SDK's forget or search is broken against the real server.
- [ ] [S-13] The job's final step stops the server and runs each SDK's `smoke-down` step, which asserts `search` reports unavailable. Fails if any SDK reports an empty result instead. Asserted by `TestSmokeDown` in each SDK's smoke runner.
- [ ] [S-4] [S-5] [S-6] [S-7] [S-8] [S-9] [S-10] [S-11] [S-12] Scenarios `ctor-blank-token` and `ctor-relative-url` pass in every SDK: construction fails before any request, and the error text omits the rejected value. Fails if any SDK defers validation to the first call or quotes the token. Asserted by `TestScenarios` in each SDK's runner.
- [ ] [S-14] `actionlint .github/workflows/release-sdk-*.yml` passes, and each `release-sdk-<lang>.yml` triggers only on `clients/<lang>/v*` tags, runs that SDK's suite, then publishes. Its publish step exits non-zero when the version already exists. Fails if a workflow's `on.push.tags` also matches `v*` server tags, or if `release-binaries.yml` matches `clients/*` tags (checked by `scripts/check-sdk-tag-triggers.sh`).
- [ ] [S-5] After the TS release, `npm view @azrtydxb/novamem@2.0.0 deprecated` prints nothing and `npm view @azrtydxb/novamem@1.1.3 deprecated` still prints the notice. Fails if the 2.0.0 publish is skipped or the deprecation is lifted from 1.x. Asserted by `TestNpmDeprecationState`, a post-publish step in `release-sdk-typescript.yml`.
- [ ] [S-15] Each `clients/<lang>/README.md` has a quickstart that the SDK's CI job compiles or runs (`scripts/check-sdk-readmes.sh` extracts and runs it), an error-contract section, and an operations table naming all 41 methods (the same script counts them). `packages/docs-site` gains an SDKs page with one install line per language, linked from the root `README.md`. Fails if a quickstart doesn't compile or a method is missing from a table.

- [ ] [S-16] `cd go && go run ./cmd/gen-contract && git diff --exit-code ../docs/api/openapi.json` is clean after the schemas are added, and `TestWrappedRoutesDeclareResponseSchema` in `clients/contract/contract_test.go` passes: every `clients/contract/routes.json` method entry with a non-null `response` names a schema present in `docs/api/openapi.json`. Fails if any of the 12 routes loses its schema.
- [ ] [S-16] [S-13] `TestResponsesMatchSchemas` in `clients/smoke` calls the eight routes that answer without the LLM observer (nine calls: `DELETE /v1/admin/users/{id}` is exercised in both its dry-run and real shapes) against the live server in the `sdk-smoke` job and validates the JSON against its schema; `GET /v1/context-prefix` is asserted to answer the documented 404 `Error` (observer disabled), and its 200 schema is verified by transcription review only. Fails if a schema was transcribed wrongly (for example a required field the handler never sends).

## Open questions
