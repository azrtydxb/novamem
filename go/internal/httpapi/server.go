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
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/azrtydxb/novamem/go/internal/auth"
	"github.com/azrtydxb/novamem/go/internal/engine"
	"github.com/azrtydxb/novamem/go/internal/metrics"
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
	// RateLimitPerMinute is NOVAMEM_RATE_LIMIT_PER_MINUTE (default 600
	// in config.ts); 0 disables the limiter entirely.
	RateLimitPerMinute int
	// AdminDashboard is NOVAMEM_ADMIN_DASHBOARD — the master switch for
	// /v1/admin/metrics{,/prom}. Off → both 404 "admin disabled" for
	// every caller.
	AdminDashboard bool
	// Metrics is the shared collector (the engine holds the same one).
	Metrics *metrics.Collector
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
	limitPerMinute int
	metrics        *metrics.Collector
	adminDashboard bool
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
		limitPerMinute: opts.RateLimitPerMinute,
		metrics:        opts.Metrics,
		adminDashboard: opts.AdminDashboard,
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
		// Every dependency the TS readiness check covers, not just the
		// warm pool: engine.Health pings warm AND cold, so a reachable
		// Postgres with an unreachable vector store reports 503 on both
		// servers instead of Go alone claiming ready.
		healthy := true
		if opts.Engine != nil {
			h := opts.Engine.Health(ctx)
			healthy, _ = h["ok"].(bool)
		} else if err := opts.Pool.Ping(ctx); err != nil {
			healthy = false
		}
		if !healthy {
			// Debug, not Warn: readiness is polled every few seconds and a
			// down dependency would flood the log at higher levels (the TS
			// server doesn't log per-probe failures at all).
			opts.Log.Debug("readiness probe failed")
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
	s.registerAdmin(mux)
	// Unmatched routes answer Fastify's default 404 envelope rather than
	// net/http's text/plain "404 page not found" — callers (and the
	// conformance suite) parse `error` off every 4xx body.
	mux.HandleFunc("/", sendNotFound)
	if opts.AuthMode == "user" {
		s.registerMe(mux)
	}
	s.registerDashboard(mux)

	// Order matters and mirrors http.ts: CORS answers the preflight
	// before anything else can 401 it, the rate limiter sits outside the
	// routes so its headers land on every answered request, and the JSON
	// body guard sits where Fastify's content-type parser does — after
	// routing, before the handler.
	return requestLog(opts.Log, paramLengthGuard(s.cors(s.rateLimit(emptyJSONBodyGuard(mux)))))
}

// sendNotFound is Fastify's default 404 envelope — callers (and the
// conformance suite) parse `error` off every 4xx body, so net/http's
// text/plain "404 page not found" is not an option.
func sendNotFound(w http.ResponseWriter, r *http.Request) {
	writeJSONValue(w, http.StatusNotFound, obj{
		{"message", "Route " + r.Method + ":" + r.URL.Path + " not found"},
		{"error", "Not Found"},
		{"statusCode", 404},
	})
}

// emptyJSONBodyGuard is Fastify's JSON content-type parser: a request
// that declares `application/json` and carries no body is rejected
// before the handler runs — on EVERY route, including the ones whose
// schema is .optional() and the ones that never read a body at all.
// Only routes that exist are checked, because Fastify parses after
// routing (an unrouted path 404s without the parser ever running).
func emptyJSONBodyGuard(mux *http.ServeMux) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
		default:
			if isJSONContentType(r) {
				if _, pattern := mux.Handler(r); pattern != "" && pattern != "/" {
					var first [1]byte
					n, _ := io.ReadFull(r.Body, first[:])
					if n == 0 {
						writeJSONValue(w, http.StatusBadRequest, map[string]any{
							"error": "Body cannot be empty when content-type is set to 'application/json'",
						})
						return
					}
					r.Body = readCloser{io.MultiReader(bytes.NewReader(first[:n]), r.Body), r.Body}
				}
			}
		}
		mux.ServeHTTP(w, r)
	})
}

// readCloser re-attaches the original Closer to a peeked body.
type readCloser struct {
	io.Reader
	io.Closer
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

// obj is a JSON object that marshals in insertion order. Go's
// encoding/json sorts map keys; the TS server emits object literals in
// source order, and the two only agree by accident. Every response whose
// TS counterpart is not alphabetical is built with this (or with a
// struct, whose fields already marshal in declaration order).
// maxParamLength mirrors Fastify's default (100). A longer path segment
// is refused BEFORE routing, with Fastify's exact envelope — captured
// from the live oracle rather than guessed:
//
//	{"error":"Bad Request","code":"FST_ERR_MAX_PARAM_LENGTH",
//	 "message":"'<path>' is exceeding the max param length",
//	 "statusCode":414}
const maxParamLength = 100

func paramLengthGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for _, seg := range strings.Split(strings.TrimPrefix(r.URL.Path, "/"), "/") {
			if len(seg) <= maxParamLength {
				continue
			}
			writeJSONValue(w, http.StatusRequestURITooLong, obj{
				{"error", "Bad Request"},
				{"code", "FST_ERR_MAX_PARAM_LENGTH"},
				{"message", "'" + r.URL.Path + "' is exceeding the max param length"},
				{"statusCode", 414},
			})
			return
		}
		next.ServeHTTP(w, r)
	})
}

type obj []kv

type kv struct {
	K string
	V any
}

func (o obj) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, e := range o {
		if i > 0 {
			b.WriteByte(',')
		}
		key, err := marshalJS(e.K)
		if err != nil {
			return nil, err
		}
		b.Write(key)
		b.WriteByte(':')
		val, err := marshalJS(e.V)
		if err != nil {
			return nil, err
		}
		b.Write(val)
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

// ordered projects a map into an obj in the given key order, so a
// response the engine hands back as a Go map still marshals in the TS
// object literal's order. Keys not listed keep encoding/json's sorted
// order at the end, so a field added upstream can never be dropped
// here — it only lands in the wrong place, which the differential
// harness catches.
func ordered(m map[string]any, keys ...string) obj {
	out := make(obj, 0, len(m))
	seen := make(map[string]bool, len(keys))
	for _, k := range keys {
		if v, ok := m[k]; ok {
			out = append(out, kv{k, v})
			seen[k] = true
		}
	}
	rest := make([]string, 0, len(m))
	for k := range m {
		if !seen[k] {
			rest = append(rest, k)
		}
	}
	sort.Strings(rest)
	for _, k := range rest {
		out = append(out, kv{k, m[k]})
	}
	return out
}

// get looks a key up in an obj — the read side of the ordered form,
// used by tests and by handlers that post-process a built response.
func (o obj) get(key string) any {
	for _, e := range o {
		if e.K == key {
			return e.V
		}
	}
	return nil
}

// orderedIn applies `ordered` to a nested map value in place.
func orderedIn(m map[string]any, key string, keys ...string) {
	if nested, ok := m[key].(map[string]any); ok {
		m[key] = ordered(nested, keys...)
	}
}

// marshalJS is json.Marshal without Go's HTML escaping. JSON.stringify
// emits `<`, `>` and `&` literally; encoding/json turns them into
// \u003c/\u003e/\u0026, which shows up in every zod message that
// carries a comparison operator ("expected number to be >=0").
func marshalJS(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

// writeJSONValue marshals v — used by the data plane where bodies are
// built structs/maps rather than fixed byte strings.
func writeJSONValue(w http.ResponseWriter, status int, value any) {
	body, err := marshalJS(value)
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
