# Observability

NovaMem can export OpenTelemetry traces to any OTLP/HTTP collector, including Jaeger. Tracing is disabled by default and becomes active when either `OTEL_ENABLED=1` or `OTEL_EXPORTER_OTLP_ENDPOINT` is set.

## Configuration

Recommended Kubernetes environment:

```yaml
env:
  - name: OTEL_ENABLED
    value: "1"
  - name: OTEL_SERVICE_NAME
    value: novamem
  - name: OTEL_EXPORTER_OTLP_ENDPOINT
    value: http://jaeger.observability.svc.cluster.local:4318
```

`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` may be set directly when the collector uses a non-standard path. If omitted, NovaMem posts traces to `${OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces`.

## Span coverage

NovaMem emits automatic HTTP, Fastify, and PostgreSQL spans, plus product spans around the hot memory paths:

- `MemoryEngine.remember`
- `WarmStore.findByContentHash`
- `WarmStore.insertEntry`
- `Embedder.embed.remember`
- `ColdStore.upsert`
- `MemoryEngine.linkVectorNeighbors`
- `ColdStore.search.linkVectorNeighbors`
- `GraphStore.addEdgesBatch`
- `WarmStore.addRelation.batch`
- `MemoryEngine.search`
- `Embedder.embed.search`
- `WarmStore.ftsSearch`
- `ColdStore.search`

Useful attributes include namespace, query/content size, requested `k`, graph fanout, embedding dimension, result count, and degraded search status. These spans are intended for benchmark and production diagnosis of API-side CPU or latency bottlenecks without relying on pod-level CPU alone.

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
