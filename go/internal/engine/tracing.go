// Product spans on the memory hot paths.
//
// Deliberately few. The value of a trace is in showing where the time in
// a request went, and for novamem that is: embedding, the warm store,
// the cold store, and the fusion on top. A span per helper would bury
// that under call-stack noise, and every span costs allocation on the
// write path whether or not anyone is collecting.
//
// Attributes carry SHAPE, never CONTENT. Sizes, counts and namespaces
// are safe to ship to a collector; the text of a memory or a query is
// the whole point of the product being private, and a trace backend is
// an external system with its own retention and access rules.
package engine

import (
	"context"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"

	"github.com/azrtydxb/novamem/go/internal/tracing"
)

var tracer = tracing.Tracer("github.com/azrtydxb/novamem/go/internal/engine")

// startSpan opens a span with the given attributes. A no-op when tracing
// is off, so call sites need no condition.
func startSpan(ctx context.Context, name string, attrs ...attribute.KeyValue) (context.Context, trace.Span) {
	return tracer.Start(ctx, name, trace.WithAttributes(attrs...))
}

// endSpan closes a span, marking it failed only on a real error.
func endSpan(span trace.Span, err error) {
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
	}
	span.End()
}
