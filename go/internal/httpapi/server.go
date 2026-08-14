// Package httpapi carries the HTTP surface. Skeleton slice: the three
// health probes with the TS server's exact bodies, and /openapi.json
// serving the frozen contract document.
//
// Contract notes transcribed from packages/server/src/http.ts:
//   - /live is liveness only: 200 {"ok":true} with NO dependency checks.
//   - /ready and /health are readiness: 200 {"ok":true} when the warm
//     store answers, 503 {"ok":false} otherwise. Boolean-only bodies by
//     design — no dependency names leak to unauthenticated callers.
package httpapi

import (
	"context"
	_ "embed"
	"log/slog"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// The frozen OpenAPI contract (docs/api/openapi.json). The copy here is
// written by packages/server's `docs:api` generator alongside the
// canonical file, and the existing CI drift gate keeps both honest.
//
//go:embed openapi.json
var openapiDoc []byte

func New(pool *pgxpool.Pool, log *slog.Logger) http.Handler {
	mux := http.NewServeMux()

	ok := []byte(`{"ok":true}`)
	notOK := []byte(`{"ok":false}`)
	writeJSON := func(w http.ResponseWriter, status int, body []byte) {
		h := w.Header()
		h.Set("Content-Type", "application/json; charset=utf-8")
		// Baseline hardening headers, matching the TS server's global
		// hook (http.ts / issue #47) — asserted by the conformance and
		// unit tests so the two servers can't drift.
		h.Set("X-Frame-Options", "DENY")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		w.WriteHeader(status)
		_, _ = w.Write(body)
	}

	mux.HandleFunc("GET /live", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, ok)
	})

	ready := func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		if err := pool.Ping(ctx); err != nil {
			// Debug, not Warn: readiness is polled every few seconds and a
			// down dependency would flood the log at higher levels (the TS
			// server doesn't log per-probe failures at all).
			log.Debug("readiness probe failed", "err", err)
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

	return requestLog(log, mux)
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
