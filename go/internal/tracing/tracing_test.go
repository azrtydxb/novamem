package tracing

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"go.opentelemetry.io/otel"
)

func TestResolveEndpoint(t *testing.T) {
	got, insecure, err := resolveEndpoint(Config{Endpoint: "http://collector:4318"})
	if err != nil || got != "http://collector:4318/v1/traces" || !insecure {
		t.Fatalf("got %q insecure=%v err=%v", got, insecure, err)
	}
	got, insecure, err = resolveEndpoint(Config{Endpoint: "http://collector", TracesEndpoint: "https://collector/traces"})
	if err != nil || got != "https://collector/traces" || insecure {
		t.Fatalf("trace endpoint precedence: %q %v %v", got, insecure, err)
	}
	if _, _, err = resolveEndpoint(Config{Endpoint: "collector:4318"}); err == nil {
		t.Fatal("accepted schemeless endpoint")
	}
}

func TestExportsOTLPHTTPPayload(t *testing.T) {
	var mu sync.Mutex
	var body []byte
	collector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/traces" {
			t.Errorf("path = %q", r.URL.Path)
		}
		if r.Header.Get("Content-Type") != "application/x-protobuf" {
			t.Errorf("content type = %q", r.Header.Get("Content-Type"))
		}
		var err error
		body, err = io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
		}
		mu.Lock()
		defer mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	defer collector.Close()
	shutdown, err := Start(context.Background(), Config{Enabled: true, Endpoint: collector.URL, ServiceName: "test-novamem"}, slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatal(err)
	}
	_, span := otel.Tracer("test").Start(context.Background(), "test.span")
	span.End()
	if err := shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(body) == 0 {
		t.Fatal("collector received an empty OTLP payload")
	}
}
