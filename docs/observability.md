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
