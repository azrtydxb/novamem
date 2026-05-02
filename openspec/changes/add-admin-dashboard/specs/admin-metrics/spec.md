## ADDED Requirements

### Requirement: Metrics endpoint exists and is admin-gated
The server SHALL expose `GET /v1/admin/metrics` returning a JSON document of operational counters and gauges. The endpoint SHALL require the admin token in `Authorization: Bearer <token>` and SHALL respond `401` when missing or wrong.

#### Scenario: Authenticated metrics fetch
- **WHEN** a client calls `GET /v1/admin/metrics` with the correct admin token
- **THEN** the server responds `200 OK` with `Content-Type: application/json` and a body containing `counters`, `gauges`, and `rates` top-level keys

#### Scenario: Unauthenticated metrics fetch
- **WHEN** a client calls `GET /v1/admin/metrics` with no `Authorization` header
- **THEN** the server responds `401 Unauthorized`

### Requirement: Counters track lifecycle events
The metrics document SHALL include monotonic counters for: `queries_total`, `queries_zero_hit`, `remembers_total`, `forgets_total`, `promotions_total` (cold→warm), `demotions_total` (warm→cold), `decay_runs_total`, `orphans_reaped_total`, `hits_warm_total`, `hits_cold_total`, `hits_graph_total`. Counters SHALL be 64-bit safe (numbers within `Number.MAX_SAFE_INTEGER`) and SHALL never decrease during the process lifetime.

#### Scenario: A successful search increments query and hit counters
- **WHEN** a client performs a search that returns at least one warm-tier hit and at least one cold-tier hit
- **THEN** `counters.queries_total` increases by 1, `counters.hits_warm_total` increases by 1 or more, and `counters.hits_cold_total` increases by 1 or more in the next `/v1/admin/metrics` snapshot

#### Scenario: A zero-result search increments the zero-hit counter
- **WHEN** a client performs a search that returns no results
- **THEN** `counters.queries_total` and `counters.queries_zero_hit` both increase by 1

#### Scenario: A decay run increments lifecycle counters
- **WHEN** the decay loop runs and demotes 3 entries from warm to cold
- **THEN** `counters.decay_runs_total` increases by 1 and `counters.demotions_total` increases by 3

#### Scenario: A cold→warm promotion is counted
- **WHEN** a search retrieves an entry from the cold tier and the engine promotes it back to warm
- **THEN** `counters.promotions_total` increases by 1

### Requirement: Gauges report current store sizes
The metrics document SHALL include gauges for: `warm_entries`, `cold_entries`, `graph_edges`, `orphans_pending`, sampled at request time. When the graph store is unreachable, `graph_edges` SHALL be reported as `null`.

#### Scenario: Gauges reflect store state
- **WHEN** the warm store contains 42 entries and the metrics endpoint is called
- **THEN** `gauges.warm_entries` equals 42

#### Scenario: Graph store unreachable
- **WHEN** FalkorDB is unreachable and the metrics endpoint is called
- **THEN** `gauges.graph_edges` is `null` and the call still returns `200 OK`

### Requirement: Rolling rates over a 60-second window
The metrics document SHALL include `rates.queries_per_sec_60s` and `rates.remembers_per_sec_60s` computed over the last 60 seconds of activity. Rates SHALL be `0` when no events have occurred in the window.

#### Scenario: Rate computation
- **WHEN** 120 queries have been recorded in the last 60 seconds
- **THEN** `rates.queries_per_sec_60s` is approximately `2`

#### Scenario: Idle service
- **WHEN** no queries have been recorded for 60 seconds
- **THEN** `rates.queries_per_sec_60s` is `0`

### Requirement: Last decay run timestamp
The metrics document SHALL include `gauges.last_decay_run_iso` containing the ISO-8601 timestamp of the most recent decay-loop completion, or `null` if the decay loop has not yet run since process start.

#### Scenario: After a decay run
- **WHEN** the decay loop completes at `2026-05-02T12:00:00.000Z`
- **THEN** `gauges.last_decay_run_iso` equals `"2026-05-02T12:00:00.000Z"` in subsequent metrics snapshots

#### Scenario: Before any decay run
- **WHEN** the metrics endpoint is called before the decay loop has run
- **THEN** `gauges.last_decay_run_iso` is `null`

### Requirement: Metrics reset on process restart
Counters, gauges, and rate windows SHALL be in-process only and SHALL reset to zero / empty on server restart. The metrics endpoint SHALL NOT persist data to any store.

#### Scenario: Restart resets counters
- **WHEN** the server has accumulated `queries_total = 1000` and is restarted
- **THEN** the next `GET /v1/admin/metrics` call returns `counters.queries_total = 0`

### Requirement: Metrics endpoint is opt-out via the dashboard flag
When `NOVAMEM_ADMIN_DASHBOARD=0`, the server SHALL respond `404` to `GET /v1/admin/metrics`. When unset or `1`, the endpoint is available.

#### Scenario: Dashboard disabled also disables metrics
- **WHEN** the server is started with `NOVAMEM_ADMIN_DASHBOARD=0` and a client calls `GET /v1/admin/metrics` with the correct admin token
- **THEN** the server responds `404 Not Found`
