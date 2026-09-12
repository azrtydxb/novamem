// HTTP server spans.
//
// Outermost in the chain on purpose: a span that starts inside the rate
// limiter cannot show a request REJECTED by the rate limiter, and those
// are exactly the requests an operator is trying to account for when
// latency or 429s are the complaint.
package httpapi

import (
	"net/http"
	"strings"

	"go.opentelemetry.io/otel/attribute"
	codes "go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"

	"github.com/azrtydxb/novamem/go/internal/tracing"
)

// tracer is resolved once. When tracing is off this is the SDK's no-op,
// so the middleware costs an allocation-free call and nothing else.
var tracer = tracing.Tracer("github.com/azrtydxb/novamem/go/internal/httpapi")

// traceRequests wraps each request in a server span.
//
// The span is named for the ROUTE PATTERN, not the URL: `/v1/entries/{id}`
// rather than `/v1/entries/01J…`, so a trace backend can aggregate them.
// Naming spans after the raw path makes every request its own unique
// operation, which is how a trace view becomes unreadable and, with
// entry ids in it, how memory ids end up in an external system.
// The mux is passed in so the pattern can be resolved BEFORE serving.
// Reading r.Pattern afterwards does not work: ServeMux sets it on the
// clone it hands the handler, which this middleware never sees, so the
// span kept the raw URL — entry ids and all — and http.route was empty.
func traceRequests(mux *http.ServeMux, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Continue a trace the caller started, so an agent's request and
		// the work novamem does for it are one trace rather than two.
		ctx := propagation.TraceContext{}.Extract(r.Context(),
			propagation.HeaderCarrier(r.Header))

		// Named for the ROUTE, resolved up front. A request that matches
		// nothing keeps its method and path, which is what an operator
		// wants to see for a flood of 404s.
		name := r.Method + " " + r.URL.Path
		attrs := []attribute.KeyValue{
			attribute.String("http.request.method", r.Method),
		}
		if _, pattern := mux.Handler(r); pattern != "" {
			// ServeMux patterns are registered as "GET /v1/entries/{id}",
			// so the method is already in them — prefixing it again gives
			// "GET GET /v1/…". The span keeps the pattern as written; the
			// http.route attribute is the path template alone, which is
			// what semconv specifies and what a backend groups by.
			name = pattern
			attrs = append(attrs, attribute.String("http.route", routeTemplate(pattern)))
		} else {
			attrs = append(attrs, attribute.String("url.path", r.URL.Path))
		}

		ctx, span := tracer.Start(ctx, name,
			trace.WithSpanKind(trace.SpanKindServer),
			trace.WithAttributes(attrs...))
		defer span.End()

		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r.WithContext(ctx))

		span.SetAttributes(attribute.Int("http.response.status_code", rec.status))
		if rec.status >= 500 {
			// 4xx is the caller's problem and a normal outcome for a
			// server; only 5xx marks the span as an error, or every
			// validation failure would light up an error dashboard.
			span.SetStatus(codes.Error, http.StatusText(rec.status))
		}
	})
}

// statusRecorder captures the status code for the span attribute.
type statusRecorder struct {
	http.ResponseWriter
	status  int
	written bool
}

func (s *statusRecorder) WriteHeader(code int) {
	if !s.written {
		s.status, s.written = code, true
	}
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusRecorder) Write(b []byte) (int, error) {
	s.written = true
	return s.ResponseWriter.Write(b)
}

// Unwrap lets the http package reach the underlying writer for
// Flush and Hijack, which the streamable MCP transport needs.
func (s *statusRecorder) Unwrap() http.ResponseWriter { return s.ResponseWriter }

// routeTemplate strips a leading method from a ServeMux pattern.
//
// Patterns may be registered either way — "GET /v1/entries/{id}" or a
// bare "/healthz" — so this splits only when there is a method to split.
func routeTemplate(pattern string) string {
	if i := strings.IndexByte(pattern, ' '); i >= 0 {
		return strings.TrimSpace(pattern[i+1:])
	}
	return pattern
}
