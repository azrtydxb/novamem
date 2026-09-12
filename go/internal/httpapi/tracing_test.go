package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

// collect installs a recording tracer provider for one test and returns
// the spans it captured. It restores the previous provider, so tests
// that do not opt in keep the no-op and stay allocation-free.
func collect(t *testing.T) func() []sdktrace.ReadOnlySpan {
	t.Helper()
	rec := tracetest.NewSpanRecorder()
	prev := otel.GetTracerProvider()
	tp := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(rec))
	otel.SetTracerProvider(tp)
	// The middleware resolved its tracer at package init, off the old
	// provider, so it has to be re-resolved for the recorder to see it.
	prevTracer := tracer
	tracer = tp.Tracer("test")
	t.Cleanup(func() {
		tracer = prevTracer
		otel.SetTracerProvider(prev)
	})
	return rec.Ended
}

func attrOf(s sdktrace.ReadOnlySpan, key string) attribute.Value {
	for _, kv := range s.Attributes() {
		if string(kv.Key) == key {
			return kv.Value
		}
	}
	return attribute.Value{}
}

// TestRequestSpanIsNamedForTheRouteNotTheURL is the whole reason the
// span is renamed after the mux matches.
//
// A span named for the raw path makes every request its own unique
// operation — a trace backend cannot aggregate `/v1/entries/01J…`
// against `/v1/entries/01K…`, so latency per endpoint becomes
// unanswerable. It also ships memory ids to an external system, which is
// the kind of leak that is obvious in hindsight and invisible in review.
func TestRequestSpanIsNamedForTheRouteNotTheURL(t *testing.T) {
	ended := collect(t)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/entries/{id}", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	srv := httptest.NewServer(traceRequests(mux, mux))
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/v1/entries/01JABCDEF")
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()

	spans := ended()
	if len(spans) != 1 {
		t.Fatalf("got %d spans, want exactly 1 per request", len(spans))
	}
	s := spans[0]
	if s.Name() != "GET /v1/entries/{id}" {
		t.Errorf("span name = %q, want the route pattern — a span named for the "+
			"raw URL cannot be aggregated and carries the entry id off-box", s.Name())
	}
	if got := attrOf(s, "http.route").AsString(); got != "/v1/entries/{id}" {
		t.Errorf("http.route = %q, want the pattern", got)
	}
	if got := attrOf(s, "http.response.status_code").AsInt64(); got != 200 {
		t.Errorf("status attribute = %d, want 200", got)
	}
}

// TestClientErrorsAreNotSpanErrors — 4xx is a normal server outcome and
// the caller's problem. Marking it an error means every validation
// failure lights up an error dashboard, and the dashboard stops meaning
// anything.
func TestClientErrorsAreNotSpanErrors(t *testing.T) {
	ended := collect(t)
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/remember", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
	})
	srv := httptest.NewServer(traceRequests(mux, mux))
	defer srv.Close()

	resp, err := http.Post(srv.URL+"/v1/remember", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()

	spans := ended()
	if len(spans) != 1 {
		t.Fatalf("got %d spans, want 1", len(spans))
	}
	if spans[0].Status().Code.String() == "Error" {
		t.Error("a 400 marked the span as an error — 4xx is the caller's problem " +
			"and a normal outcome; only 5xx is ours")
	}
}

// TestServerErrorsAreSpanErrors — the other half. A 500 that does not
// mark the span is a trace that cannot answer "which requests failed".
func TestServerErrorsAreSpanErrors(t *testing.T) {
	ended := collect(t)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /boom", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})
	srv := httptest.NewServer(traceRequests(mux, mux))
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/boom")
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()

	spans := ended()
	if len(spans) != 1 {
		t.Fatalf("got %d spans, want 1", len(spans))
	}
	if spans[0].Status().Code.String() != "Error" {
		t.Errorf("a 500 left the span status %q — traces could not answer which "+
			"requests failed", spans[0].Status().Code)
	}
}
