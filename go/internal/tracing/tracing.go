// Package tracing configures the OTLP/HTTP trace exporter.
package tracing

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
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

type Config struct {
	Enabled                               bool
	Endpoint, TracesEndpoint, ServiceName string
}
type Shutdown func(context.Context) error

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
		return noop, fmt.Errorf("building OTLP/HTTP exporter: %w", err)
	}
	service := cfg.ServiceName
	if service == "" {
		service = "novamem"
	}
	res, err := resource.Merge(resource.Default(), resource.NewWithAttributes(semconv.SchemaURL, semconv.ServiceName(service)))
	if err != nil {
		res = resource.NewWithAttributes(semconv.SchemaURL, semconv.ServiceName(service))
		log.Warn("OTLP resource schema conflict; using service resource", "err", err)
	}
	tp := sdktrace.NewTracerProvider(sdktrace.WithBatcher(exporter, sdktrace.WithBatchTimeout(time.Second)), sdktrace.WithResource(res))
	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(propagation.TraceContext{}, propagation.Baggage{}))
	otel.SetErrorHandler(otel.ErrorHandlerFunc(func(err error) { log.Warn("otel export failed", "err", err) }))
	return tp.Shutdown, nil
}

// HTTP records one server span per request. It is deliberately outermost in
// the API stack so rejected requests are visible too.
func HTTP(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := otel.GetTextMapPropagator().Extract(r.Context(), propagation.HeaderCarrier(r.Header))
		ctx, span := otel.Tracer("novamem/http").Start(ctx, r.Method+" "+r.URL.Path, trace.WithSpanKind(trace.SpanKindServer), trace.WithAttributes(attribute.String("http.request.method", r.Method)))
		defer span.End()
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func resolveEndpoint(cfg Config) (string, bool, error) {
	endpoint := cfg.TracesEndpoint
	if endpoint == "" {
		endpoint = strings.TrimRight(cfg.Endpoint, "/") + "/v1/traces"
	}
	if cfg.Endpoint == "" && cfg.TracesEndpoint == "" {
		endpoint = "http://localhost:4318/v1/traces"
	}
	if !strings.HasPrefix(endpoint, "http://") && !strings.HasPrefix(endpoint, "https://") {
		return "", false, fmt.Errorf("OTLP endpoint %q must start with http:// or https://", endpoint)
	}
	return endpoint, strings.HasPrefix(endpoint, "http://"), nil
}
