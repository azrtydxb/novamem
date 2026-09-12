// Package tracing wires OpenTelemetry trace export.
//
// Reinstates what the retired TypeScript server had and the Go port
// never did, while docs/observability.md went on documenting it (#277).
// An operator who set OTEL_EXPORTER_OTLP_ENDPOINT got silence, which is
// the worst failure an observability setting has: indistinguishable from
// a working exporter with nothing to report.
//
// OTLP over HTTP, because that is the transport the page has always
// documented — a collector on :4318 receiving POSTs to /v1/traces.
//
// Two rules shape everything here:
//
//   - Tracing must never be able to take the server down. A collector
//     that is unreachable, slow or wrong is an operational inconvenience,
//     not an outage: export failures are logged and dropped, and startup
//     does not block on reaching the collector.
//   - Off means off. With no configuration the tracer provider is a no-op
//     and the instrumentation costs a nil check.
package tracing

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
	"go.opentelemetry.io/otel/trace"
)

// Config is the subset of server configuration tracing needs, passed
// explicitly so this package does not import the config package and
// invert the dependency.
type Config struct {
	Enabled        bool
	Endpoint       string // OTLP/HTTP base, e.g. http://jaeger:4318
	TracesEndpoint string // full traces URL, overrides Endpoint
	ServiceName    string
	Version        string
}

// Shutdown flushes and stops the exporter. Always non-nil, so a caller
// can defer it without checking whether tracing was enabled.
type Shutdown func(context.Context) error

// Start installs a global tracer provider and returns its shutdown.
//
// When cfg.Enabled is false it installs nothing and returns a no-op
// shutdown: the global provider stays the SDK's default no-op, and every
// Start call elsewhere in the tree becomes a cheap nil-ish operation.
//
// An error here is a configuration error — an endpoint that cannot be
// parsed — not a connectivity one. The exporter connects lazily, so a
// collector that is down at boot does not prevent the server starting,
// and one that goes down later does not stop it serving.
func Start(ctx context.Context, cfg Config, log *slog.Logger) (Shutdown, error) {
	noop := func(context.Context) error { return nil }
	if !cfg.Enabled {
		return noop, nil
	}

	endpoint, insecure, err := resolveEndpoint(cfg)
	if err != nil {
		return noop, err
	}
	opts := []otlptracehttp.Option{otlptracehttp.WithEndpointURL(endpoint)}
	if insecure {
		opts = append(opts, otlptracehttp.WithInsecure())
	}
	exporter, err := otlptracehttp.New(ctx, opts...)
	if err != nil {
		return noop, fmt.Errorf("building the OTLP exporter: %w", err)
	}

	service := cfg.ServiceName
	if service == "" {
		service = "novamem"
	}
	attrs := []attribute.KeyValue{semconv.ServiceName(service)}
	if cfg.Version != "" {
		attrs = append(attrs, semconv.ServiceVersion(cfg.Version))
	}
	res, err := resource.Merge(resource.Default(),
		resource.NewWithAttributes(semconv.SchemaURL, attrs...))
	if err != nil {
		// A schema-URL clash between our attributes and the defaults.
		// Not worth failing a boot over: fall back to ours alone.
		log.Warn("otel: could not merge the default resource; using service attributes only", "err", err)
		res = resource.NewWithAttributes(semconv.SchemaURL, attrs...)
	}

	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exporter, sdktrace.WithBatchTimeout(5*time.Second)),
		sdktrace.WithResource(res),
	)
	otel.SetTracerProvider(tp)
	// Accept and propagate context from callers, so a trace that starts
	// in an agent's client survives the hop into novamem.
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{}, propagation.Baggage{}))
	// Export failures must not be silent AND must not be fatal. Without
	// this the SDK writes to its own logger, which nothing here reads.
	otel.SetErrorHandler(otel.ErrorHandlerFunc(func(err error) {
		log.Warn("otel: span export failed (tracing degraded, serving unaffected)", "err", err)
	}))

	log.Info("otel: exporting traces", "endpoint", endpoint, "service", service)
	return func(ctx context.Context) error { return tp.Shutdown(ctx) }, nil
}

// resolveEndpoint applies the documented precedence: an explicit traces
// endpoint wins, otherwise the base endpoint gets the conventional
// /v1/traces path appended by the exporter.
//
// insecure is reported separately because otlptracehttp defaults to TLS
// and an `http://` collector — which is what a cluster-local Jaeger is —
// would otherwise fail to connect with a confusing transport error.
func resolveEndpoint(cfg Config) (endpoint string, insecure bool, err error) {
	switch {
	case cfg.TracesEndpoint != "":
		endpoint = cfg.TracesEndpoint
	case cfg.Endpoint != "":
		endpoint = strings.TrimRight(cfg.Endpoint, "/") + "/v1/traces"
	default:
		// Enabled with no endpoint: the OTLP default collector address.
		endpoint = "http://localhost:4318/v1/traces"
	}
	if !strings.HasPrefix(endpoint, "http://") && !strings.HasPrefix(endpoint, "https://") {
		return "", false, fmt.Errorf(
			"OTLP endpoint %q has no scheme — it must start with http:// or https://", endpoint)
	}
	return endpoint, strings.HasPrefix(endpoint, "http://"), nil
}

// Tracer returns the named tracer. A no-op when tracing is off, so call
// sites need no condition of their own.
func Tracer(name string) trace.Tracer { return otel.Tracer(name) }
