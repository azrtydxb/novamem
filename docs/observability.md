# Observability

novamem exports OpenTelemetry traces to any OTLP/**HTTP** collector, including Jaeger. Tracing is off by default.

## Configuration

Set either switch — the flag, or an endpoint on its own. Configuring where to send traces and getting none because a second flag was missed is a failure mode worth designing out, so an endpoint is taken as intent.

```yaml
env:
  - name: OTEL_EXPORTER_OTLP_ENDPOINT
    value: http://jaeger.observability.svc.cluster.local:4318
  - name: OTEL_SERVICE_NAME
    value: novamem
```

| Variable                             | Effect                                                                                          |
| ------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT`        | OTLP/HTTP base URL. Traces go to `${endpoint}/v1/traces`. Enables tracing on its own.           |
| `OTEL_ENABLED`                       | Enables tracing without naming a collector — exports to `http://localhost:4318/v1/traces`.      |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Full traces URL, for a collector that does not serve the conventional path. Wins over the base. |
| `OTEL_SERVICE_NAME`                  | The `service.name` on every span. Defaults to `novamem`.                                        |

An `http://` endpoint is dialled without TLS and an `https://` one with it; an endpoint with no scheme is refused at startup rather than guessed at. These rows are generated into the [environment reference](./install/env-reference.md) from the same source the loader reads, so they cannot drift from the server.

::: tip Tracing cannot take the server down
A collector that is unreachable, slow or misconfigured is an observability problem, not an outage. Export failures are logged and dropped, startup does not block on reaching the collector, and a bad endpoint is reported while the server carries on serving. Traces are the first thing to lose under pressure, never the last.
:::

## Span coverage

Deliberately few. The value of a trace is showing where the time in a request went, and a span per helper buries that under call-stack noise while costing an allocation on the write path whether or not anyone is collecting.

| Span              | Where                                                             |
| ----------------- | ----------------------------------------------------------------- |
| `GET /v1/…` etc.  | One server span per HTTP request, named for the **route pattern** |
| `engine.Remember` | The write path                                                    |
| `engine.Search`   | The read path                                                     |

The HTTP span is outermost in the middleware chain, so a request rejected by the rate limiter still appears — those are exactly the ones an operator is accounting for when 429s or latency are the complaint. Incoming `traceparent` headers are honoured, so an agent's request and the work novamem does for it form one trace rather than two.

::: warning Attributes carry shape, never content
Spans record sizes, counts, namespaces and status — `novamem.content.chars`, `novamem.query.chars`, `novamem.k`, `novamem.results`, `novamem.degraded` — and never the text of a memory or a query. A trace backend is an external system with its own retention and access rules.

Span names use the route pattern (`DELETE /v1/me/projects/{id}`) rather than the resolved URL, for the same reason as much as for aggregation: the raw path carries ids off-box.
:::

## Jaeger

Jaeger all-in-one can receive OTLP/HTTP on port `4318` and serve the UI on `16686`. In Kubernetes, expose the UI with a private/internal LoadBalancer only.

## Runtime metrics and profiling

`GET /v1/admin/metrics/prom` appends a Go runtime section after the
`novamem_*` series: `go_goroutines`, `go_memstats_heap_alloc_bytes`,
`go_memstats_heap_sys_bytes`, and `go_gc_cycles_total`. Alert on a
monotonically climbing `go_goroutines` — a flat count under load is the
healthy signal.

For deeper investigation set `NOVAMEM_PPROF_ADDR` (for example
`127.0.0.1:6060`) and the server starts `net/http/pprof` on that
dedicated listener — bind it to localhost or a cluster-internal address;
it is deliberately not part of the API surface. Then:

```bash
go tool pprof http://127.0.0.1:6060/debug/pprof/heap
go tool pprof http://127.0.0.1:6060/debug/pprof/profile?seconds=30
curl -s http://127.0.0.1:6060/debug/pprof/goroutine?debug=1 | head
```
