// Package httpapi carries the HTTP surface: the three health probes with
// the TS server's exact bodies, /openapi.json serving the frozen
// contract document, and the slice-2 data plane (dataplane.go) behind
// the none|bearer auth middleware (auth.go).
//
// Contract notes transcribed from packages/server/src/http.ts:
//   - /live is liveness only: 200 {"ok":true} with NO dependency checks.
//   - /ready and /health are readiness: 200 {"ok":true} when the warm
//     store answers, 503 {"ok":false} otherwise. Boolean-only bodies by
//     design — no dependency names leak to unauthenticated callers.
//   - Hardening headers (X-Frame-Options / X-Content-Type-Options /
//     Referrer-Policy) go on every response.
package httpapi

import (
	"context"
	_ "embed"
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/azrtydxb/novamem/go/internal/auth"
	"github.com/azrtydxb/novamem/go/internal/engine"
	"github.com/azrtydxb/novamem/go/internal/warmstore"
)

// The frozen OpenAPI contract (docs/api/openapi.json). The copy here is
// written by packages/server's `docs:api` generator alongside the
// canonical file, and the existing CI drift gate keeps both honest.
//
//go:embed openapi.json
var openapiDoc []byte

type Options struct {
	Pool   *pgxpool.Pool
	Log    *slog.Logger
	Engine *engine.Engine
	Warm   *warmstore.Store
	// AuthMode "none", "bearer" or "user". AuthToken required for
	// "bearer"; CookieSecret required for "user".
	AuthMode  string
	AuthToken string
	// CookieSecret signs the Better Auth session cookie — the same
	// NOVAMEM_COOKIE_SECRET the TS server used, so existing sessions
	// keep verifying.
	CookieSecret string
	// SecureCookies mirrors !NOVAMEM_INSECURE_COOKIES: it decides both
	// the Secure attribute and the `__Secure-` cookie-name prefix.
	SecureCookies bool
	// TrustedOrigins is the CSRF allow-list for the sign-in / sign-out
	// endpoints (base URL + configured CORS origins).
	TrustedOrigins []string
	// CorsOrigins is the MCP browser-origin allow-list (http.ts
	// corsOrigins / NOVAMEM_CORS_ORIGINS).
	CorsOrigins []string
}

type server struct {
	log            *slog.Logger
	engine         *engine.Engine
	warm           *warmstore.Store
	authMode       string
	authToken      string
	cookieSecret   string
	secureCookies  bool
	trustedOrigins []string
	corsOrigins    []string
	limiter        *auth.Limiter
	metrics        *collector
}

func New(opts Options) http.Handler {
	s := &server{
		log:            opts.Log,
		engine:         opts.Engine,
		warm:           opts.Warm,
		authMode:       opts.AuthMode,
		authToken:      opts.AuthToken,
		cookieSecret:   opts.CookieSecret,
		secureCookies:  opts.SecureCookies,
		trustedOrigins: opts.TrustedOrigins,
		corsOrigins:    opts.CorsOrigins,
		limiter:        auth.NewLimiter(),
		metrics:        newCollector(),
	}
	mux := http.NewServeMux()

	ok := []byte(`{"ok":true}`)
	notOK := []byte(`{"ok":false}`)

	mux.HandleFunc("GET /live", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, ok)
	})

	ready := func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		if err := opts.Pool.Ping(ctx); err != nil {
			// Debug, not Warn: readiness is polled every few seconds and a
			// down dependency would flood the log at higher levels (the TS
			// server doesn't log per-probe failures at all).
			opts.Log.Debug("readiness probe failed", "err", err)
			writeJSON(w, http.StatusServiceUnavailable, notOK)
			return
		}
		writeJSON(w, http.StatusOK, ok)
	}
	mux.HandleFunc("GET /ready", ready)
	mux.HandleFunc("GET /health", ready)

	mux.HandleFunc("GET /openapi.json", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, openapiDoc)
	})

	// Browsers request /favicon.ico from the page origin (http.ts: 204).
	mux.HandleFunc("GET /favicon.ico", func(w http.ResponseWriter, _ *http.Request) {
		setHardeningHeaders(w)
		w.WriteHeader(http.StatusNoContent)
	})

	s.registerDataPlane(mux)
	s.registerSearchPlane(mux)
	s.registerMCP(mux)
	s.registerAuthRoutes(mux)
	// Unmatched routes answer Fastify's default 404 envelope rather than
	// net/http's text/plain "404 page not found" — callers (and the
	// conformance suite) parse `error` off every 4xx body.
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		writeJSONValue(w, http.StatusNotFound, map[string]any{
			"message":    "Route " + r.Method + ":" + r.URL.Path + " not found",
			"error":      "Not Found",
			"statusCode": 404,
		})
	})
	if opts.AuthMode == "user" {
		s.registerMe(mux)
	}

	return requestLog(opts.Log, mux)
}

func setHardeningHeaders(w http.ResponseWriter) {
	// Baseline hardening headers, matching the TS server's global hook
	// (http.ts / issue #47) — asserted by the conformance and unit tests
	// so the two servers can't drift.
	h := w.Header()
	h.Set("X-Frame-Options", "DENY")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "no-referrer")
}

func writeJSON(w http.ResponseWriter, status int, body []byte) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	setHardeningHeaders(w)
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

// writeJSONValue marshals v — used by the data plane where bodies are
// built structs/maps rather than fixed byte strings.
func writeJSONValue(w http.ResponseWriter, status int, value any) {
	body, err := json.Marshal(value)
	if err != nil {
		body = []byte(`{"error":"internal server error"}`)
		status = http.StatusInternalServerError
	}
	writeJSON(w, status, body)
}

// requestLog mirrors the TS server's per-request structured log line.
func requestLog(log *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(sw, r)
		log.Info("request completed",
			"method", r.Method, "url", r.URL.Path,
			"statusCode", sw.status,
			"responseTimeMs", time.Since(start).Milliseconds())
	})
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (s *statusWriter) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

// Flush must pass through: the MCP SSE streams write their frames and
// flush, and a wrapper that swallows Flush leaves the handshake frame
// sitting in net/http's buffer until the stream ends — the client waits
// forever for an endpoint event that was already written.
func (s *statusWriter) Flush() {
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Unwrap lets http.ResponseController reach the underlying writer
// (deadline control on the long-lived SSE responses).
func (s *statusWriter) Unwrap() http.ResponseWriter { return s.ResponseWriter }
