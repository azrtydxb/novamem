# Go server parity audit (Go migration slice 8)

**Date:** 2026-08-14
**Scope:** `go/` vs `packages/server`, per
[the Go migration design spec](../superpowers/specs/2026-08-13-go-migration-design.md)
§3 (differential tests), §6 slice 8, §"Error handling".
**Status:** audit complete. Ten divergences classified as defects — three
fixed here, seven recorded unfixed with reasoning; six further divergences
classified as accepted. Full ledger in §7.

This audit deliberately looks for what the conformance suite does **not**
cover (57 cases declared; 44 run and 13 mode-skipped in the `user`-mode
configuration used here). Conformance was green against the Go server
before this audit started and is green after the fixes; every finding
below is something conformance never asserted.

---

## 1. Methodology

### 1.1 Environment

Both servers were run locally against the **same** Postgres database —
`novamem_go` on the `novamem-bench` deployment (kw cluster), reached
through `kubectl -n novamem-bench port-forward postgres-0 15432:5432`.

| | Go | TypeScript |
|---|---|---|
| binary / entrypoint | `go build ./cmd/novamem-server` | `pnpm --filter @novamem/server build` → `node dist/main.js` |
| port | 18081 (18082 soak, 18091 conformance) | 18090 |
| `NOVAMEM_AUTH_MODE` | `user` | `user` |
| `NOVAMEM_HOST` | 127.0.0.1 | 127.0.0.1 |
| cold tier | pgvector, dim 1024 | pgvector, dim 1024 |
| embeddings | `bge-m3` @ `http://192.168.10.125/v1` | same |
| rerank | `bge-reranker-v2-m3` | same |
| cookie secret | identical on both | identical on both |
| node / go | — | node v26.7.0 |
| | go 1.26.3 | |

The TS server was run **without** `NOVAMEM_EXTRACTION_*`,
`NOVAMEM_OBSERVER_*` and `NOVAMEM_QUERY_DECOMP_*`, which the bench
deployment normally sets. Those three subsystems do not exist in Go
(accepted divergence #14, §7), and leaving them on would have made every
search comparison a comparison of *feature sets* rather than of the
shared retrieval path. This is stated up front because it is the single
biggest caveat on the ranking numbers in §3.

### 1.2 Corpora

* **`parity_*` corpus** — 30 hand-written entries spanning infra, ML,
  engine, preferences, process, testing, MCP, product and general-world
  facts, written through the **Go** server, then re-seeded a second time
  into a single namespace `parity_all` (see §3.1 for why).
* **`nb-pb1-*` corpus** — 42 synthetic LongMemEval-shaped questions ×
  3 sessions × 6 turns = **378 chunks**, ingested with
  `bench/bench_retrieval.py ingest` through the Go server. All 378
  reached `embedded_at IS NOT NULL` before any measurement.
* **`parity_xw` / `parity_sup`** — cross-write fixtures (§4).

### 1.3 Authentication

`/api/auth/get-session` on the local TS server **500s** for every
request: the `jwks` row in `novamem_go` is encrypted with a Better Auth
secret that no longer exists anywhere I could reach, and BA's JWT plugin
throws `Failed to decrypt private key` before returning a session. Rather
than mutate shared-infrastructure state to work around it, every
differential probe was run with an `nm_…` **bearer token** minted through
Go's `POST /v1/me/tokens` and accepted unchanged by both servers. See §10
for what this cost the audit.

---

## 2. Audit 1 — OpenAPI surface diff

Go routes were enumerated from the `mux.HandleFunc` registrations in
`go/internal/httpapi/{server,dataplane,search,mcp,authroutes,admin,me}.go`
and diffed both ways against `docs/api/openapi.json` (56 path+method
pairs).

**Result: Go serves a strict superset — 56/56 spec routes present, zero
method mismatches, 5 extra.**

```
IN SPEC, NOT SERVED BY GO:   (none)
SERVED BY GO, NOT IN SPEC:
  GET  /api/auth/get-session
  GET  /favicon.ico
  GET  /openapi.json
  POST /api/auth/sign-in/email
  POST /api/auth/sign-out
```

All five are also served by the TS server and are marked
`schema: { hide: true }` there, which is exactly why they are absent from
the generated document. **Not** a divergence.

The interesting finding is what the OpenAPI document does not describe at
all. Diffing the Go routes against the *TS server's actual* route table
(not the spec) surfaces two hidden surfaces the Go server does not serve:

| Surface | TS | Go | Verdict |
|---|---|---|---|
| `GET /admin`, `GET /admin/` (Preact SPA) | 200 `text/html` | **404 JSON** | **DEFECT-1** |
| 22 further `/api/auth/*` Better Auth passthroughs | route exists | **404** | **DEFECT-2** |

Measured:

```
GET /admin            go=404 (application/json)   ts=200 (text/html)
POST /api/auth/change-password       go=404  ts=400   (route exists on TS)
POST /api/auth/admin/create-user     go=404  ts=400
POST /api/auth/admin/set-role        go=404  ts=400
POST /api/auth/admin/remove-user     go=404  ts=400
GET  /api/auth/admin/list-users?...  go=404  ts=200
GET  /api/auth/jwks                  go=404  ts=200
GET  /api/auth/list-sessions         go=404  ts=200
```

`packages/admin-ui/src` calls five of these directly
(`UsersPage.tsx` → `admin/list-users`, `admin/create-user`,
`admin/set-role`, `admin/remove-user`; `ChangePasswordPage.tsx` →
`change-password`). The dashboard's Users tab and Change Password page
are therefore **non-functional** against the Go server — and the Go
server does not serve the dashboard at all, so the spec's slice-5
deliverable ("dashboard static serving via `go:embed`", §1 of the design
spec) is **not implemented**. There is no `go:embed` of the admin-ui
build anywhere in `go/` (only `openapi.json` and `tooldefs.json` are
embedded).

Both are recorded as **defects, not fixed here** — implementing them is
feature work (embedding a build artifact, porting five Better Auth admin
endpoints), and this slice's brief is "fix parity defects, do not add
features". They are the gating items for the verdict in §8.

### 2.1 Config-surface diff

The spec's drop-in claim covers env vars. `NOVAMEM_*` names read by each
server:

**Read by TS, ignored by Go (26):** `NOVAMEM_BOOTSTRAP_ADMIN_EMAIL`,
`NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD`, `NOVAMEM_DECAY_DAYS`,
`NOVAMEM_EXTRACTION_*` (7), `NOVAMEM_OBSERVER_*` (7),
`NOVAMEM_QUERY_DECOMP_*` (7), `NOVAMEM_PG_POOL_MAX`,
`NOVAMEM_RATE_LIMIT_PER_MINUTE`.

**Read by Go, unknown to TS (1):** `NOVAMEM_DECAY_DEFAULT_EFFECTIVE_DAYS`.

Three of these are not covered by the spec's accepted non-goals:

* **DEFECT-3 (env rename).** TS reads `NOVAMEM_DECAY_DAYS` for
  `decay.defaultEffectiveDays`; Go reads
  `NOVAMEM_DECAY_DEFAULT_EFFECTIVE_DAYS`. An operator who sets the
  documented variable gets Go's default (7) silently.
* **DEFECT-4 (no rate limiting).** TS registers `@fastify/rate-limit`
  (`http.ts:418`, default 600/min, `/health|/live|/ready` allow-listed)
  and emits `x-ratelimit-limit|remaining|reset` on every response. Go has
  **no rate limiter at all** — `grep -ri ratelimit go/internal` returns
  nothing, and a Go response carries 0 `x-ratelimit-*` headers vs 3 on
  TS. `NOVAMEM_RATE_LIMIT_PER_MINUTE` is accepted-and-ignored.
* **DEFECT-5 (no bootstrap admin).** `NOVAMEM_BOOTSTRAP_ADMIN_EMAIL` /
  `_PASSWORD` seed the first admin in `main.ts`. Go ignores both, so a
  fresh Go-only deployment has no way to create its first user. (Go's
  `POST /v1/admin/users` requires an existing admin session.)

`NOVAMEM_PG_POOL_MAX` is a tuning knob with a different underlying pool
(pgx vs node-postgres) — recorded as accepted.

---

## 3. Audit 2 — differential behaviour on a shared database

### 3.1 Search ranking

**First attempt — and a bug in the oracle.** Ten diverse queries against
the multi-namespace `parity_*` corpus gave:

```
exact-order 6/10   top-1 10/10   mean Jaccard(top-10) 0.964   max |Δscore| 0.101
```

That looked like real ranking drift. It is not. The per-signal breakdown
showed **identical `vector` values to 16 digits** and a `keyword` signal
that was non-zero on Go and **zero on every TS result**, even for exact
token matches (`Longhorn`, `photosynthesis`). The TS log explains it:

```
"msg":"keyword tier failed"
  WHERE f.namespace = ANY(($3, $4, $5, $6, $7, $8, $9, $10, $11, $12)) …
```

`packages/server/src/warm-store/index.ts:1636` builds the multi-namespace
filter as ``sql`f.namespace = ANY(${args.namespaces!})` ``. Drizzle
expands a JS array into a comma-separated **parameter list**, producing a
row constructor, and Postgres rejects it:

```
ERROR: op ANY/ALL (array) requires array on right side (SQLSTATE 42809)
```

The `namespaces` array path is taken whenever the search spans **more
than one namespace** — i.e. the default unscoped search for any user with
≥2 namespaces. The failure is caught and logged at `warn`, the keyword
tier silently returns zero candidates, and `fuse()` redistributes the
keyword weight to the remaining tiers. **The TS server has a dead keyword
tier on the default search path.** The Go server, which binds the same
predicate as a real array (`warmstore/search.go:76`), is correct.

Recorded as **ACCEPTED (Go superior); TS-side bug**. Not fixed here —
`packages/server` is out of this slice's scope and the spec deletes it at
cleanup. It is called out because it means the conformance **oracle is
compromised for multi-namespace keyword retrieval**, and any earlier
differential result over a multi-namespace corpus is not trustworthy.

**Second attempt — single namespace, TS keyword tier alive.** The same 30
entries were re-seeded into one namespace (`parity_all`) and the same ten
queries issued with `namespace` set, interleaving the call order per
query (odd queries TS-first, even queries Go-first) to control for the
access-count writes each search performs:

| metric | value |
|---|---|
| exact top-10 order match | **10 / 10** |
| top-1 agreement | **10 / 10** |
| mean Jaccard(top-10) | **1.000** |
| max abs. score delta | **8.89 × 10⁻¹⁰** |
| mean abs. score delta | **5.03 × 10⁻¹⁰** |

That is float64 rounding, not a scoring difference. Determinism was
verified separately: five interleaved runs of one query
(`go, go, ts, ts, go`) produced byte-identical orderings and scores
within each server, so the numbers above are not noise-averaged.

Independent corroboration from the bench harness on the 378-chunk
`nb-pb1` corpus: **nDCG@10 = 0.8521 and any-hit@10 = 100.0% on both
servers, in all 8 replications each** — identical to four decimal places.

**Verdict: hybrid ranking is at parity**, well inside the spec's stated
tolerance, on the shared retrieval path.

### 3.2 Structural comparison of the other read endpoints

Twenty endpoints were called identically on both servers and their bodies
compared by recursive **shape** (key sets and value types at every level)
plus id-order:

`POST /v1/recent` (scoped and unscoped), `POST /v1/neighbors`,
`POST /v1/context`, `GET /v1/stats`, `POST /v1/hygiene`,
`GET /v1/context-prefix`, `POST /v1/evaluate`, `GET /v1/me/usage`,
`GET /v1/me/today`, `GET /v1/me/onboarding`, `GET /v1/me/projects`,
`GET /v1/me/tokens`, `GET /v1/me/metrics`, `GET /v1/me/changes`,
`GET /v1/me/active-project`, `GET /v1/admin/metrics`,
`GET /v1/admin/users`, `GET /v1/admin/audit-log`,
`GET /v1/admin/health/deep`.

**19/20 matched on the first run. One did not:**

**DEFECT-6 — `GET /v1/me/metrics` returns the wrong document for admins.**
`packages/server/src/routes/me.ts:58-79`: when the caller `isAdmin`, TS
returns the **global** metrics snapshot plus `tokens` and a
`_hasMyTokens` flag. Go always returned the per-user snapshot. Measured
delta for the bench admin:

```
missing from Go (top level):  _hasMyTokens
missing from Go (counters):   decay_runs_total, demotions_total,
                              orphans_reaped_total, promotions_total,
                              remember_errors_total, search_errors_total
missing from Go (gauges):     last_decay_run_iso, orphans_pending,
                              pending_embeddings, pending_facts
wrong value  in Go (gauges):  graph_edges = null   (TS: 122)
extra        in Go:           userId
```

`packages/admin-ui/src/pages/MetricsPage.tsx` renders
`graph_edges`, `orphans_pending`, `pending_embeddings` and
`pending_facts` from this payload, so the dashboard Metrics page reads
empty against Go. **Fixed** — see §8. After the fix, 20/20 endpoints
match structurally.

### 3.3 Error shapes

Twenty error paths were issued identically to both servers and the
**status + raw body bytes** compared.

| Path | Before | After fix |
|---|---|---|
| identical status **and** body bytes | 10 / 20 | 11 / 20 |

The remaining nine break down as:

**DEFECT-7 — malformed / non-object JSON bodies (FIXED).** Every JSON
endpoint collapsed all three of Fastify's distinct body-parse outcomes
into one bogus schema issue. Measured on `/v1/remember`, `/v1/search`,
`/v1/forget`, `/v1/recent`, `/v1/hygiene`, `/v1/context` — all identical
behaviour:

```
body `{not json`   go: {"error":"invalid request body","issues":[{"path":"content","message":"Required",...}]}
                   ts: {"error":"Body is not valid JSON but content-type is set to 'application/json'"}
body `[1,2]`       go: (same bogus "content Required")
                   ts: {"error":"invalid request body","issues":[{"path":"","message":"Invalid input: expected object, received array","code":"invalid_type"}]}
body `"s"` / `5`   go: (same bogus "content Required")
                   ts: …"received string" / "received number"
```

Status was always 400 on both, which is why conformance (which asserts
status and the presence of a `content` issue) never caught it. **Fixed**
— see §8.

**ACCEPTED — JSON object key order** (3 cases: 404 envelope,
`/v1/neighbors`, `/v1/search`). Go emits `error` before `message`,
Fastify the reverse; Go emits `degraded` before `results`. Same keys,
same values, different serialisation order. JSON object order is not
semantically meaningful and no client can depend on it.

**DEFECT-8 (not fixed) — Zod v3 vs v4 message wording.** Paths and codes
match exactly; the human-readable `message` strings do not, because Go
transcribed Zod v3's wording and `packages/server` now ships Zod v4:

| case | Go | TS |
|---|---|---|
| missing string | `Required` | `Invalid input: expected string, received undefined` |
| wrong type | `Expected string, received number` | `Invalid input: expected string, received number` |
| too short | `String must contain at least 1 character(s)` | `Too small: expected string to have >=1 characters` |

Deliberately **not** fixed. The conformance suite's own error-shape file
states messages are contract only "where integrations match on them", and
asserts message equality for exactly one case — the read-only-token 403
`"read-only token"`, which **does** match byte-for-byte on both servers,
as do the 401 `"unauthorized"` and the confined-token 403. Rewriting ~20
message strings to chase a dependency's wording, in a codebase whose
whole point is to delete that dependency, is churn. Recorded so the
decision is visible rather than accidental.

**ACCEPTED (harness artifact) — 2 cases.** `DELETE /v1/me/tokens/zzz`
and `DELETE /v1/me/projects/!!!` sent with `content-type: application/json`
and no body: TS rejects at the body parser
("Body cannot be empty…") before routing, Go reaches the handler. Re-run
without the header, both servers return 204/404 identically.

**ACCEPTED — empty-body strictness.** TS rejects an empty POST body on
*every* JSON route, including ones whose schema is `.optional()`
(`/v1/recent`, `/v1/hygiene`, `/v1/adoption`): Fastify's parser rejects
before the schema runs. Go treats an empty body on those routes as `{}`
and serves the request. Go is more permissive; no client breaks on a
request that starts working. Left alone deliberately — matching it would
mean rejecting requests Go currently serves, for no user benefit.

Error paths that matched byte-for-byte throughout: missing auth (401),
bad bearer (401), read-only token write (403), read-only token forget
(403), unknown id on forget (200), unknown id on update (404), malformed
id, non-admin hitting `/v1/admin/users` (403), oversized content (201 on
both — 200 kB is under the 256 kB ceiling), unknown-field tolerance.

### 3.4 MCP surface

Both servers were driven through a full streamable-HTTP handshake
(`initialize` → `notifications/initialized` → `tools/list`):

* 21 tools on both, same names (14 `memory_*` + 7 `project_*`).
* **21/21 tool schemas byte-identical** after key-sorted JSON
  serialisation — descriptions, input schemas, annotations, everything.

### 3.5 Prometheus surface

`GET /v1/admin/metrics/prom` — the full set of `# HELP` / `# TYPE` lines
is **identical** between the two servers (`diff` is empty).

---

## 4. Audit 3 — write-path cross-compatibility

Fixtures written through **each** server into a shared namespace, then
read back through **both**.

| fixture | Go write | TS write |
|---|---|---|
| plain entry | 201 | 201 |
| TTL entry (`expiresAt`) | 201 | 201 |
| project-scoped entry | 201 | 201 |
| capture pair triggering supersession | 201, `superseded:[…]` | 201, `superseded:[…]` |

Row-level inspection of every fixture in `memory_entries`:

| column / property | Go-written | TS-written |
|---|---|---|
| `content_hash` length | 64 | 64 |
| `memory_fts` rows per entry | 1 | 1 |
| `memory_vectors` rows per entry | 1 | 1 |
| `embedded_at` | set | set |
| `source` / `source_type` | `manual`/`null`, `memory_capture`/`chat` | identical |
| TTL representation | `metadata.expiresAt` ISO string | identical |
| `project_id` | set | set |
| capture metadata keys | `retention{policy,baseEffectiveDays,supersedeAggressively}`, `memoryType`, `worthiness{durable,overall,confidence,userRelevance,reuseLikelihood}`, `sensitivity`, `captureAction`, `lifecycleStatus`, `supersedes`/`supersededBy`/`supersededAt`/`supersededReason` | **identical key set and value shapes** |

Cross-reads:

* `POST /v1/recent` on `parity_xw` — both servers return the **same 7
  ids in the same order**, with the same `metadata.expiresAt` presence
  and the same `project` values.
* Three `POST /v1/search` queries targeting Go-written and TS-written
  content — **identical id order and identical scores to 4 decimals** on
  both servers, with Go-written and TS-written entries interleaved in the
  ranking exactly the same way.
* Project-scoped `POST /v1/recent` with `project: "Parity Audit"` —
  both servers return both project entries, one written by each server.

Content-hash dedup is cross-compatible too: re-running the whole
cross-write script returned the **same entry ids** rather than creating
duplicates, on both servers.

A first supersession run appeared asymmetric (Go superseded, TS did not).
It was a timing artifact — the first capture's embedding had not settled
when the second arrived. With a 15 s settle, **both servers supersede
identically**, writing the same `supersedes` / `supersededBy` /
`supersededReason: "contradiction"` metadata.

**Verdict: no write-path divergence. Neither server misreads the
other's rows.**

---

## 5. Audit 4 — load and latency

Harness: `bench/bench_retrieval.py search`, 42 questions per run,
`--max-workers 4`, default cutoffs, **8 replications per server,
interleaved** (go rep_n, ts rep_n, go rep_n+1, …) against the shared
378-chunk `nb-pb1` corpus.

> **Caveat, stated up front:** the LongMemEval dataset the brief pointed
> at (`longmemeval_s_cleaned.json`) is **not present** in this session's
> scratchpad. The corpus above is a synthetic LongMemEval-*shaped*
> dataset generated for this audit (42 questions × 3 sessions × 6 turns,
> one planted evidence turn per question). It exercises the same harness
> code path and the same `/v1/search` body, but it is an easier corpus
> than the real one — hence nDCG@10 of 0.85 rather than the numbers in
> `docs/benchmarks/`. It is valid as a **latency probe and a ranking
> equivalence check**; it is not a retrieval-quality benchmark.

### Latency (ms, per-query wall time)

| | Go | TS |
|---|---|---|
| replications | 8 | 8 |
| pooled samples | 336 | 336 |
| pooled p50 | **70.7** | **66.7** |
| pooled p95 | **212.8** | **95.0** |
| pooled mean | 91.2 | 73.8 |
| per-rep p50, median (range) | 71.0 (67.8 – 199.1) | 67.0 (64.4 – 68.5) |
| per-rep p95, median (range) | 101.1 (86.7 – 460.6) | 89.1 (74.4 – 336.1) |

**No winner is claimed.** Both distributions are dominated by two remote
round trips per query — the `bge-m3` embedding call over the LAN and a
Postgres reached through a `kubectl port-forward` — which put a ~60 ms
floor under every sample and account for most of the variance. Each
server produced one outlier replication (Go rep 2 at p50 199 ms; TS rep 1
at p95 336 ms) that I could not attribute to either implementation. The
4 ms median gap is inside that noise. A defensible latency comparison
needs both servers in-cluster with a local Postgres, which this audit did
not do.

### Footprint

| | Go | TS |
|---|---|---|
| RSS under load | **23.4 MB** | **172.4 MB** |
| startup to first `/live` 200, 3 runs | **55 / 86 / 58 ms** | **703 / 718 / 722 ms** |
| shipped artifact | 16.7 MB static binary | 4.0 MB `dist/` + `node_modules` + node runtime |

RSS was sampled with `ps -o rss=` on both processes immediately after the
8-replication run. Go is **7.4× smaller resident** and starts **~12×
faster**. Both numbers are stable and reproducible, unlike the latency
figures.

> A first startup measurement gave TS ~28 ms — a stale Go process was
> squatting the probe port. Both sets above were re-taken after
> confirming the port was free. Recorded because the wrong number was
> plausible.

---

## 6. Audit 5 — resource / soak

Go server on port 18082 with background jobs at aggressive intervals
(`NOVAMEM_DECAY_INTERVAL_MS=60000`,
`NOVAMEM_EMBEDDINGS_RECONCILE_INTERVAL_MS=30000`, `LOG_LEVEL=debug`),
under a continuous load loop (5 searches + 1 remember every ~5 s).

**Duration: 23.0 minutes**, 248 RSS samples, 2 239 requests served.

### Memory

| | value |
|---|---|
| RSS at start | 23 088 kB |
| RSS at end | 23 120 kB |
| growth over 23 min | **+32 kB (+0.1 %)** |
| min / max / mean | 22 800 / 24 560 / 23 264 kB |

Flat. The 24 560 kB peak is a single transient sample; the series has no
trend. 512 new entries were written into `parity_soak` during the run
(warm total 1 019 by the end), so the flatness is under real write load,
not idling.

### Errors

| level | count |
|---|---|
| INFO | 2 267 |
| WARN | **5** |
| ERROR / panic | **0** |

All five WARNs are the same line, and they are a real finding:

```
"msg":"async bumpHitsMany failed (hit counts lag)",
"err":"ERROR: deadlock detected (SQLSTATE 40P01)"
```

Two concurrent searches whose top-k overlap in opposite orders deadlock
in the `memory_access` upsert. It is caught and downgraded to a WARN, so
the visible symptom is silently-lost access statistics rather than a
failed request — which is exactly why no test found it. Root cause and
one-line fix in §8 (**DEFECT-10**); note the soak itself ran the
*pre-fix* binary, so this count is the unfixed baseline.

### Background jobs

| job | runs | inter-run gap (min / median / max) |
|---|---|---|
| `decay` (60 s timer) | 24 | 59.9 s / 60.0 s / 60.1 s |
| graph-enrichment reconcile (30 s timer) | 3 logged | 390 s / 450 s / 510 s |

**No job overlapped.** The decay timer's inter-run gap never deviates
from its 60 s interval by more than 100 ms across 24 runs — a run that
had overlapped or been serialised behind a previous one would show a gap
materially longer than the interval. The reconcile loop logs only when it
finds work, so 3 lines over 23 min is 3 batches of pending enrichment,
not 3 ticks; its ticks are otherwise silent.

**Goroutine count could not be measured.** The Go server exposes no
`net/http/pprof` handler and no `go_goroutines` metric — `grep -rn
"pprof\|NumGoroutine\|go_goroutines" go/` returns nothing. This is a real
observability gap relative to what a Go service is normally expected to
expose, and it is the one thing in the soak brief I could not verify. It
is not a TS-parity defect (the TS server exposes no equivalent either).

---

## 7. Divergence ledger

| # | Divergence | Class | Fixed | Reasoning |
|---|---|---|---|---|
| 1 | `GET /admin[/]` — dashboard not served; no `go:embed` of admin-ui | **DEFECT** | no | Feature work, not a parity patch. Spec §1 lists it as a slice-5 deliverable; it is missing. Gates the verdict. |
| 2 | 22 of 25 `/api/auth/*` Better Auth passthroughs missing (incl. `change-password`, `admin/create-user`, `admin/set-role`, `admin/remove-user`, `admin/list-users`) | **DEFECT** | no | Feature work. Dashboard Users tab + Change Password are dead against Go. Gates the verdict. |
| 3 | `NOVAMEM_DECAY_DAYS` renamed to `NOVAMEM_DECAY_DEFAULT_EFFECTIVE_DAYS` | **DEFECT** | no | One-line config fix, but it changes an operator-visible name; belongs in a change with a docs sweep, not silently inside an audit. |
| 4 | No rate limiting; `NOVAMEM_RATE_LIMIT_PER_MINUTE` ignored; no `x-ratelimit-*` headers | **DEFECT** | no | Security-relevant and non-trivial (needs a limiter + allow-list + 429 shape). Sized as its own change. |
| 5 | `NOVAMEM_BOOTSTRAP_ADMIN_EMAIL` / `_PASSWORD` ignored — no first-admin seed | **DEFECT** | no | Blocks a fresh Go-only deployment from ever getting a first user. Needed before Go can stand alone. |
| 6 | `GET /v1/me/metrics` returned the per-user snapshot for admins instead of the global one; `_hasMyTokens` absent; `graph_edges` always null | **DEFECT** | **yes** | Dashboard Metrics page reads empty. Small, contained fix. |
| 7 | Malformed / non-object JSON bodies produced a fabricated `"<field> Required"` issue on every JSON endpoint | **DEFECT** | **yes** | Systematic error-contract break, one root cause in `decodeBody`. |
| 8 | Zod v3 vs v4 message wording (paths and codes match) | **DEFECT (won't fix)** | no | Messages are contract only where clients match on them; every such message already matches. Chasing a dependency's wording in code that exists to delete that dependency is churn. |
| 9 | No CORS: `OPTIONS` preflight 404s, no `access-control-allow-origin` / `-credentials`, no `vary: Origin` | **DEFECT** | no | Any browser client on a different origin cannot call the Go server. Becomes critical the moment #1 is fixed (a same-origin dashboard hides it). Sized as its own change. |
| 10 | `BumpHitsMany` deadlocks under concurrent search (`SQLSTATE 40P01`) — `ON CONFLICT DO UPDATE` took row locks in unsorted top-k order | **DEFECT (shared with TS)** | **yes** | Found by the soak (§6), not by conformance. Caught and downgraded to a WARN, so hit counts silently lag rather than the request failing. One-line root-cause fix. `packages/server`'s `bumpHitsMany` has the identical unsorted pattern and the same latent bug. |
| 11 | TS keyword tier dies on multi-namespace search (`ANY((…))`, SQLSTATE 42809) | **ACCEPTED — Go superior** | n/a | A bug in `packages/server`, which this slice does not touch and the cleanup phase deletes. Compromises the oracle; see §3.1. |
| 12 | JSON object key ordering differs (`error`/`message`, `degraded`/`results`) | **ACCEPTED** | n/a | Not semantically meaningful. |
| 13 | Empty POST body: TS 400s on every route, Go serves `.optional()` routes | **ACCEPTED** | n/a | Go is strictly more permissive; matching would reject requests that currently work, for no benefit. |
| 14 | No fact extraction, no observer, no query decomposition (`NOVAMEM_EXTRACTION_*`, `NOVAMEM_OBSERVER_*`, `NOVAMEM_QUERY_DECOMP_*`) | **ACCEPTED** | n/a | Spec §Non-goals: external-endpoints-only, no in-process LLM subsystems. **Note:** bench's TS deployment currently runs all three; turning Go into the default *changes bench's retrieval behaviour*, which is a product decision, not a parity gap. |
| 15 | `NOVAMEM_PG_POOL_MAX` ignored | **ACCEPTED** | n/a | Different pool implementation (pgx vs node-postgres); no equivalent knob. |
| 16 | No `pprof` / goroutine metric | **ACCEPTED (observability gap)** | n/a | Neither server exposes it; not a parity defect. Worth adding when Go becomes primary. |

---

## 8. Code changed

Three defects fixed. Nothing outside `go/` was touched.

**DEFECT-7 — body-parse error envelopes.**
`validate.go`: `decodeBody` now returns an `error` rather than an
`*issue`, and distinguishes Fastify's three outcomes — `errMalformedJSON`
(no `issues` array, matching the body-parser message byte-for-byte), a
path-`""` `"Invalid input: expected object, received <type>"` issue for
valid-but-non-object JSON, and `"Required"` for an absent body on a
required schema. A new `sendBodyErr` picks the right envelope. All 12
call sites in `dataplane.go`, `search.go`, `me.go`, `sessionrecap.go`
route through it; five of them (`handleWrite`, `handleSearch`,
`handleForget`, `handleContext`, `handleNeighbors`) were **discarding**
the decode error and substituting a fabricated `"<field> Required"`
issue — that is the root cause, and it is gone.

Test: `TestMalformedBodyEnvelopes` in `validate_test.go` pins all four
body shapes across four endpoints.

**DEFECT-6 — `/v1/me/metrics` for admins.**
`me.go`: `handleMeMetrics` now returns the global snapshot merged with
the per-token rows and `_hasMyTokens` when the caller's role is `admin`,
matching `routes/me.ts:58-79`.

**DEFECT-10 — `BumpHitsMany` deadlock.**
`warmstore/search.go`: the deduped id slice is now `slices.Sort`ed before
the `INSERT … ON CONFLICT DO UPDATE`, so every concurrent bump acquires
`memory_access` row locks in the same order. Previously the array
inherited the top-k ranking order, and two searches whose result sets
overlapped in opposite orders deadlocked. The error is caught and logged
at `warn` ("hit counts lag"), so the symptom is silently-lost access
statistics, not a failed request — which is why nothing else surfaced it.

No test: a deadlock reproduction is inherently racy, needs a live
Postgres, and the fix is a one-line ordering invariant stated in the
comment. The three-line change is smaller than any harness that would
exercise it.

**The fix is not exercised by §6's soak.** The soak process was started
before the fix and ran the pre-fix binary throughout — its deadlock count
is the *unfixed* baseline. A post-fix soak to confirm the WARNs go to
zero is outstanding.

**Verification after all three fixes:**

* `go build ./... && go vet ./internal/httpapi/` clean.
* `go test ./...` — all packages pass.
* Structural comparison re-run: **20/20 endpoints match**
  (was 19/20).
* Error-shape comparison re-run: malformed-JSON cases now byte-identical.
* **Conformance suite against the patched Go server: 44 passed,
  13 skipped, 0 failed** (`NOVAMEM_URL=http://127.0.0.1:18091`,
  `auth.mode=user`, non-admin data-plane token, dashboard disabled).

Nothing outside `go/` and `docs/` was touched. Nothing was committed.

> An earlier conformance run with a mis-set env (admin token used as the
> data-plane token, dashboard enabled) showed 2 failures. The **same env
> against the TS oracle showed 5 failures, a superset of Go's 2** — the
> failures were configuration, not regressions. The clean run above is
> the one that counts.

---

## 9. Verdict

**The Go server is at parity on everything an API client touches, and is
not yet ready to become bench's default.**

What is proven at parity, with numbers:

* Every route in the OpenAPI contract, with no method mismatches.
* Hybrid search ranking: 10/10 exact top-10 order, max score delta
  8.89 × 10⁻¹⁰, identical nDCG@10 (0.8521) and any-hit (100%) across
  8 replications on a 378-chunk corpus.
* All 20 compared read endpoints structurally identical (after the fix).
* All 21 MCP tool schemas byte-identical; Prometheus metric set
  identical.
* Write-path fully cross-compatible: metadata, `content_hash`, FTS rows,
  vectors, TTL, project scoping, supersession — neither server misreads
  the other's rows.
* Materially better footprint: 23 MB RSS vs 172 MB, 58 ms startup vs
  720 ms.

What blocks the default switch — all five are **surfaces conformance
never tested**:

1. **The dashboard does not exist on Go** (`/admin` 404s, no `go:embed`).
2. **22 `/api/auth/*` endpoints are missing**, five of which the
   dashboard calls; user management and password change are dead.
3. **No CORS**, so a dashboard served from anywhere else cannot reach it.
4. **No rate limiting** — a regression in exposure, not just in parity.
5. **No bootstrap-admin seed**, so a Go-only deployment cannot create its
   first user.

Items 1–3 are one coherent piece of work (serve the dashboard, port the
five Better Auth endpoints it calls, add the CORS middleware). Items 4
and 5 are independent and small. None require touching the engine, the
store, or the search path — the hard parts are done.

There is also a **product** decision hiding in accepted divergence #14:
bench's TS deployment runs fact extraction, the observer and query
decomposition; Go implements none of them by design. Switching the
default changes bench's retrieval behaviour in ways this audit did not
measure, because it disabled those subsystems on the TS side precisely to
get a like-for-like comparison. Someone has to decide that trade
explicitly rather than inherit it.

### What must be true before `packages/server` is deleted

The spec's cleanup phase requires the Go server to be bench's default
first. Concretely:

1. Divergences 1, 2, 3, 4, 5 and 9 closed (10 already fixed here), each with a conformance test
   so they cannot regress.
2. **Conformance extended to cover what this audit found by hand:** the
   dashboard route, the `/api/auth/*` allow-list, CORS preflight, rate
   limiting, and a structural (not just status-code) comparison of
   `/v1/me/metrics`. Every defect in this report existed under a fully green
   conformance run.
3. The oracle bug (#11) fixed or explicitly retired, so the last
   differential run before deletion compares against a keyword tier that
   actually executes.
4. A latency comparison **in-cluster**, with a local Postgres, replacing
   §5's network-dominated numbers.
5. The extraction / observer / decomposition trade in #13 accepted in
   writing, since deleting `packages/server` deletes the only
   implementation.
6. Drizzle migration ownership moved into Go (spec §2 defers this to
   post-parity; it is a hard prerequisite for deleting the TS tree).

---

## 10. What I could not verify

Stated plainly, because a parity audit that only reports what it managed
to test is not one.

* **Session-cookie interoperability, TS direction.** A TS-issued cookie
  is accepted by the Go server (verified: same user resolved). The
  reverse could not be tested — `/api/auth/get-session` on the local TS
  server 500s for *every* request, including its own cookies, because
  `novamem_go`'s `jwks` row is encrypted with an unrecoverable Better
  Auth secret. Fixing it means deleting a row in a shared bench database;
  I did not do that without asking. All differential work therefore ran
  on bearer tokens. Cookie interop in the TS direction is **unverified**.
* **Anything reached through a browser.** The dashboard was tested by
  HTTP status only. Given divergences 1, 2 and 9, the Go server cannot
  currently serve it at all, so there was nothing to open — but that also
  means no rendering, auth-flow or console-error evidence exists.
* **Goroutine count under soak** — not exposed (§6).
* **That the `BumpHitsMany` fix works.** The soak ran the pre-fix binary
  (§8). The deadlock's root cause and the ordering invariant are both
  clear, but the WARN count going to zero is unconfirmed.
* **Real LongMemEval retrieval quality.** The dataset was not available;
  §5 used a synthetic stand-in. Ranking *equivalence* between the two
  servers is well evidenced; absolute retrieval quality on the real
  corpus is not re-measured here.
* **A trustworthy latency verdict.** §5's numbers are dominated by a
  port-forwarded Postgres and a LAN embedding call. Both servers showed
  an unexplained outlier replication.
* **Behaviour at scale.** The differential corpora were 30 and 378
  entries. Bench's real corpus is larger; index-plan divergences that
  only appear at scale would not have shown up.
* **Qdrant cold store.** Only pgvector was exercised, per the bench
  deployment's configuration.
* **`bearer` and `none` auth modes.** Everything here ran in
  `auth.mode=user`. Conformance covers the other two; this audit added no
  independent evidence.
* **Live novamem-bench deployment.** All measurements are from local
  processes against the bench *database*. The Go server running in-cluster
  (`novamem-go` deployment) was not redeployed with these fixes — the
  spec's "deployed and exercised live" gate is **not** satisfied by this
  audit.
