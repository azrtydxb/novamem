package tracing

import (
	"context"
	"log/slog"
	"strings"
	"testing"
)

// TestResolveEndpoint pins the precedence docs/observability.md
// documents, and the scheme handling that decides whether the exporter
// speaks TLS.
func TestResolveEndpoint(t *testing.T) {
	for _, tc := range []struct {
		name         string
		cfg          Config
		want         string
		wantInsecure bool
		wantErr      bool
	}{
		{
			name: "a base endpoint gets the conventional path",
			cfg:  Config{Endpoint: "http://jaeger:4318"},
			want: "http://jaeger:4318/v1/traces", wantInsecure: true,
		},
		{
			name: "a trailing slash does not double up",
			cfg:  Config{Endpoint: "http://jaeger:4318/"},
			want: "http://jaeger:4318/v1/traces", wantInsecure: true,
		},
		{
			name: "an explicit traces endpoint wins",
			cfg: Config{
				Endpoint:       "http://jaeger:4318",
				TracesEndpoint: "https://collector.example/otlp/traces",
			},
			want: "https://collector.example/otlp/traces", wantInsecure: false,
		},
		{
			name: "https is not downgraded to insecure",
			cfg:  Config{Endpoint: "https://collector.example:4318"},
			want: "https://collector.example:4318/v1/traces", wantInsecure: false,
		},
		{
			name: "enabled with no endpoint uses the OTLP default",
			cfg:  Config{},
			want: "http://localhost:4318/v1/traces", wantInsecure: true,
		},
		{
			name:    "a schemeless endpoint is refused, not guessed at",
			cfg:     Config{Endpoint: "jaeger:4318"},
			wantErr: true,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, insecure, err := resolveEndpoint(tc.cfg)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("endpoint %q was accepted; a missing scheme must be "+
						"refused rather than silently turned into something", tc.cfg.Endpoint)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got != tc.want {
				t.Errorf("endpoint = %q, want %q", got, tc.want)
			}
			if insecure != tc.wantInsecure {
				t.Errorf("insecure = %v, want %v — an http:// collector must not be "+
					"dialled with TLS, and an https:// one must not be downgraded",
					insecure, tc.wantInsecure)
			}
		})
	}
}

// TestDisabledStartsNothing — off means off. A no-op shutdown is
// returned rather than nil so callers can defer it unconditionally.
func TestDisabledStartsNothing(t *testing.T) {
	shutdown, err := Start(context.Background(), Config{Enabled: false},
		slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatal(err)
	}
	if shutdown == nil {
		t.Fatal("nil shutdown — callers defer this without checking whether tracing was on")
	}
	if err := shutdown(context.Background()); err != nil {
		t.Errorf("shutting down a disabled tracer: %v", err)
	}
}

// TestBadEndpointDoesNotStopTheServer — a misconfigured collector is an
// error to report, not a boot failure, and the returned shutdown is
// still safe to call.
func TestBadEndpointDoesNotStopTheServer(t *testing.T) {
	shutdown, err := Start(context.Background(),
		Config{Enabled: true, Endpoint: "jaeger:4318"},
		slog.New(slog.DiscardHandler))
	if err == nil {
		t.Fatal("a schemeless endpoint was accepted")
	}
	if !strings.Contains(err.Error(), "no scheme") {
		t.Errorf("error %q does not say what is wrong with the endpoint", err)
	}
	if shutdown == nil {
		t.Fatal("nil shutdown on a failed start — the caller's defer would panic")
	}
	if err := shutdown(context.Background()); err != nil {
		t.Errorf("shutdown after a failed start: %v", err)
	}
}
