// Package config loads the server configuration from the SAME environment
// variables the TypeScript server reads (frozen contract: same config
// surface — packages/server/src/config.ts). Only the variables the
// current slices consume are parsed; unknown NOVAMEM_* vars are ignored
// exactly like the TS loader ignores them.
package config

import (
	"fmt"
	"math"
	"os"
	"strconv"
	"strings"
)

type Config struct {
	Host     string // NOVAMEM_HOST, default 0.0.0.0
	Port     int    // NOVAMEM_PORT, default 7778
	WarmURL  string // NOVAMEM_WARM_URL (Postgres DSN) — required
	LogLevel string // LOG_LEVEL, default info

	// Auth. TS default is "user" (config.ts).
	AuthMode  string // NOVAMEM_AUTH_MODE: none | bearer | user
	AuthToken string // NOVAMEM_AUTH_TOKEN — required when mode=bearer
	// CookieSecret signs session cookies (NOVAMEM_COOKIE_SECRET).
	// Required whenever mode != none — an ephemeral fallback would let a
	// forgotten env var silently invalidate every session on restart.
	CookieSecret string
	// InsecureCookies drops the Secure attribute (NOVAMEM_INSECURE_COOKIES)
	// for a k3s LB without TLS, or local dev.
	InsecureCookies bool
	// BaseURL (NOVAMEM_BASE_URL) — the public origin; seeds the trusted
	// origin list for the sign-in CSRF check.
	BaseURL string

	// Server-wide per-user write quotas; 0 = unlimited (quotas are
	// opt-in — config.ts quotas defaults).
	QuotaMaxEntries      int // NOVAMEM_QUOTA_MAX_ENTRIES
	QuotaWritesPerMinute int // NOVAMEM_QUOTA_WRITES_PER_MINUTE

	// Reject writes longer than this many characters (config.ts
	// search.maxContentChars, default 4000; 0 disables).
	MaxContentChars int // NOVAMEM_MAX_CONTENT_CHARS

	// Deployment-specific high-relevance vocabulary for the worthiness
	// scorer (NOVAMEM_PERSONAL_TERMS, comma-separated).
	PersonalTerms []string

	// Browser origins allowed to reach /mcp (NOVAMEM_CORS_ORIGINS:
	// "" or "self" → none, "*" → any, else comma-separated).
	CorsOrigins []string

	// PgPoolMax bounds the WARM Postgres pool (NOVAMEM_PG_POOL_MAX,
	// config.ts service.pgPoolMax, default 20). The cold pgvector pool is
	// NOT covered by it — cold-store-pgvector.ts hardcodes max: 10.
	PgPoolMax int

	// Cold tier. Provider "" leaves the vector tier unconfigured — the
	// server then behaves exactly like TS with the cold store down
	// (rows store with embedded_at NULL, search degrades).
	ColdProvider   string // NOVAMEM_COLD_PROVIDER: pgvector | qdrant
	ColdURL        string // NOVAMEM_COLD_URL; default = warm URL (pgvector) / http://localhost:6333 (qdrant)
	ColdAPIKey     string // NOVAMEM_COLD_API_KEY — Qdrant api-key header; unset sends none (TS has no such knob)
	ColdVectorSize int    // NOVAMEM_COLD_VECTOR_SIZE, default 384
	ColdTimeoutMs  int    // NOVAMEM_COLD_TIMEOUT_MS, default 15000

	// Embedder. Only the openai-compatible provider is ported (the TS
	// default local-transformers is deliberately unsupported — see the
	// switch below).
	EmbeddingsProvider       string // NOVAMEM_EMBEDDINGS_PROVIDER
	EmbeddingsEndpoint       string // NOVAMEM_EMBEDDINGS_ENDPOINT
	EmbeddingsModel          string // NOVAMEM_EMBEDDINGS_MODEL
	EmbeddingsAPIKey         string // NOVAMEM_EMBEDDINGS_API_KEY
	EmbeddingsDim            int    // NOVAMEM_EMBEDDINGS_DIM, default 384
	EmbeddingsTimeoutMs      int    // NOVAMEM_EMBEDDINGS_TIMEOUT_MS, default 30000
	EmbeddingsQueryPrefix    *string
	EmbeddingsDocumentPrefix *string

	// Search fusion + graph enrichment.
	MinVectorScore  float64 // NOVAMEM_SEARCH_MIN_VECTOR_SCORE, default 0.25
	GraphLinkFanout int     // NOVAMEM_GRAPH_LINK_FANOUT, default 3 (0 disables)

	// Background jobs (main.ts timers).
	DecayIntervalMs     int     // NOVAMEM_DECAY_INTERVAL_MS, default 6h
	DecayEffectiveDays  float64 // NOVAMEM_DECAY_DAYS, default 7
	ReconcileIntervalMs int     // NOVAMEM_EMBEDDINGS_RECONCILE_INTERVAL_MS, default 60000
	ReconcileBatch      int     // NOVAMEM_EMBEDDINGS_RECONCILE_BATCH, default 400
	// RateLimitPerMinute — global per-IP request cap
	// (NOVAMEM_RATE_LIMIT_PER_MINUTE, config.ts default 600).
	RateLimitPerMinute int
	// BootstrapAdminEmail / -Password seed the first admin when the
	// deployment has none (NOVAMEM_BOOTSTRAP_ADMIN_EMAIL / _PASSWORD).
	BootstrapAdminEmail    string
	BootstrapAdminPassword string
	// AdminDashboard — master switch for /v1/admin/metrics{,/prom}
	// (NOVAMEM_ADMIN_DASHBOARD; "0"/"false"/"no"/"off" disable it).
	AdminDashboard bool

	// Phase 5 cross-encoder rerank (opt-in per request; off unless enabled).
	RerankEnabled   bool   // NOVAMEM_RERANK_ENABLED
	RerankEndpoint  string // NOVAMEM_RERANK_ENDPOINT (full URL)
	RerankModel     string // NOVAMEM_RERANK_MODEL
	RerankAPIKey    string // NOVAMEM_RERANK_API_KEY
	RerankPoolMult  int    // NOVAMEM_RERANK_POOL_MULTIPLIER, default 4
	RerankTimeoutMs int    // NOVAMEM_RERANK_TIMEOUT_MS, default 5000

	// Phase 2 write-time LLM fact extraction. Fire-and-forget off the
	// write path; the facts_pending_at marker is the durable debt.
	ExtractionEnabled       bool   // NOVAMEM_EXTRACTION_ENABLED
	ExtractionEndpoint      string // NOVAMEM_EXTRACTION_ENDPOINT (OpenAI-compatible base)
	ExtractionModel         string // NOVAMEM_EXTRACTION_MODEL
	ExtractionAPIKey        string // NOVAMEM_EXTRACTION_API_KEY
	ExtractionMaxFacts      int    // NOVAMEM_EXTRACTION_MAX_FACTS, default 8
	ExtractionTimeoutMs     int    // NOVAMEM_EXTRACTION_TIMEOUT_MS, default 120000
	ExtractionMaxConcurrent int    // NOVAMEM_EXTRACTION_MAX_CONCURRENT, default 12

	// Phase 4 query decomposition + coherence rerank (opt-in per request
	// via SearchRequest.decompose).
	QueryDecompEnabled         bool   // NOVAMEM_QUERY_DECOMP_ENABLED
	QueryDecompEndpoint        string // NOVAMEM_QUERY_DECOMP_ENDPOINT
	QueryDecompModel           string // NOVAMEM_QUERY_DECOMP_MODEL
	QueryDecompAPIKey          string // NOVAMEM_QUERY_DECOMP_API_KEY
	QueryDecompMaxSubqueries   int    // NOVAMEM_QUERY_DECOMP_MAX_SUBQUERIES, default 3 (1..5)
	QueryDecompCoherenceRerank bool   // NOVAMEM_QUERY_DECOMP_COHERENCE_RERANK, default true
	QueryDecompTimeoutMs       int    // NOVAMEM_QUERY_DECOMP_TIMEOUT_MS, default 8000

	// Phase 5 Observer/Reflector — the /v1/observe + /v1/context-prefix
	// observation log.
	ObserverEnabled          bool   // NOVAMEM_OBSERVER_ENABLED
	ObserverEndpoint         string // NOVAMEM_OBSERVER_ENDPOINT
	ObserverModel            string // NOVAMEM_OBSERVER_MODEL
	ObserverAPIKey           string // NOVAMEM_OBSERVER_API_KEY
	ObserverObserveThreshold int    // NOVAMEM_OBSERVER_OBSERVE_THRESHOLD, default 10
	ObserverReflectThreshold int    // NOVAMEM_OBSERVER_REFLECT_THRESHOLD, default 50
	ObserverTimeoutMs        int    // NOVAMEM_OBSERVER_TIMEOUT_MS, default 30000

	// PprofAddr enables net/http/pprof on its own listener when set
	// (NOVAMEM_PPROF_ADDR, e.g. "127.0.0.1:6060"). Deliberately a
	// separate socket rather than a route on the API server: profiling
	// stays reachable in every auth mode (a dashboard-gated route is
	// unreachable under auth.mode=bearer) and never rides an exposed
	// port by accident. Default off.
	PprofAddr string
}

func Load() (Config, error) {
	c := Config{
		Host:            getenv("NOVAMEM_HOST", "0.0.0.0"),
		Port:            7778,
		WarmURL:         os.Getenv("NOVAMEM_WARM_URL"),
		LogLevel:        getenv("LOG_LEVEL", "info"),
		AuthMode:        getenv("NOVAMEM_AUTH_MODE", "user"),
		AuthToken:       os.Getenv("NOVAMEM_AUTH_TOKEN"),
		MaxContentChars: 4000,
	}
	if p := os.Getenv("NOVAMEM_PORT"); p != "" {
		n, err := strconv.Atoi(p)
		if err != nil || n < 1 || n > 65535 {
			return c, fmt.Errorf("NOVAMEM_PORT %q is not a valid port", p)
		}
		c.Port = n
	}
	if c.WarmURL == "" {
		// Same fail-fast stance as the TS server: a server without its
		// warm store would 503 every request; refuse to start instead.
		return c, fmt.Errorf("NOVAMEM_WARM_URL is required")
	}
	switch c.AuthMode {
	case "none":
	case "bearer":
		if c.AuthToken == "" {
			// Exact fail-fast from http.ts buildHttpServer.
			return c, fmt.Errorf("auth.mode = 'bearer' requires auth.token to be set (NOVAMEM_AUTH_TOKEN)")
		}
	case "user":
	default:
		return c, fmt.Errorf("NOVAMEM_AUTH_MODE %q is not one of none|bearer|user", c.AuthMode)
	}
	c.CookieSecret = os.Getenv("NOVAMEM_COOKIE_SECRET")
	if c.AuthMode != "none" && len(c.CookieSecret) < 16 {
		return c, fmt.Errorf("NOVAMEM_COOKIE_SECRET is required when auth.mode != 'none'. " +
			"Generate one with `openssl rand -hex 32` and set it in your environment")
	}
	c.InsecureCookies = boolEnv("NOVAMEM_INSECURE_COOKIES")
	c.BaseURL = getenv("NOVAMEM_BASE_URL", fmt.Sprintf("http://%s:%d", c.Host, c.Port))
	var err error
	if c.QuotaMaxEntries, err = intEnv("NOVAMEM_QUOTA_MAX_ENTRIES", 0); err != nil {
		return c, err
	}
	if c.QuotaWritesPerMinute, err = intEnv("NOVAMEM_QUOTA_WRITES_PER_MINUTE", 0); err != nil {
		return c, err
	}
	if c.MaxContentChars, err = intEnv("NOVAMEM_MAX_CONTENT_CHARS", 4000); err != nil {
		return c, err
	}
	c.PersonalTerms = csvEnv(os.Getenv("NOVAMEM_PERSONAL_TERMS"))

	// CORS: unset keeps the TS default single dev origin; "" / "self"
	// means same-origin only, "*" reflects any origin.
	switch raw, set := os.LookupEnv("NOVAMEM_CORS_ORIGINS"); {
	case !set:
		c.CorsOrigins = []string{"http://localhost:5173"}
	case raw == "" || raw == "self":
		c.CorsOrigins = nil
	case raw == "*":
		c.CorsOrigins = []string{"*"}
	default:
		c.CorsOrigins = csvEnv(raw)
	}

	// config.ts defaults this to "qdrant" — an unset provider must select
	// the same backend here, not "no cold tier". A Go server that quietly
	// ran without a vector tier where TS runs Qdrant is exactly the class
	// of silent divergence this migration must not ship.
	c.ColdProvider = getenv("NOVAMEM_COLD_PROVIDER", "qdrant")
	switch c.ColdProvider {
	case "pgvector", "qdrant":
	default:
		return c, fmt.Errorf("NOVAMEM_COLD_PROVIDER %q is not one of pgvector|qdrant", c.ColdProvider)
	}
	// config.ts: unset cold URL means the warm database for pgvector and
	// the local Qdrant otherwise.
	coldDefault := c.WarmURL
	if c.ColdProvider == "qdrant" {
		coldDefault = "http://localhost:6333"
	}
	c.ColdURL = getenv("NOVAMEM_COLD_URL", coldDefault)
	c.ColdAPIKey = os.Getenv("NOVAMEM_COLD_API_KEY")
	if c.ColdVectorSize, err = intEnv("NOVAMEM_COLD_VECTOR_SIZE", 384); err != nil {
		return c, err
	}
	if c.ColdTimeoutMs, err = intEnv("NOVAMEM_COLD_TIMEOUT_MS", 15_000); err != nil {
		return c, err
	}

	c.EmbeddingsProvider = os.Getenv("NOVAMEM_EMBEDDINGS_PROVIDER")
	switch c.EmbeddingsProvider {
	case "", "openai-compatible":
	case "local-transformers":
		// Product decision (owner, 2026-08-14): the Go server does not
		// embed a local model — it points at an API endpoint. In-process
		// ONNX would need cgo and forfeit the single static binary, and
		// the deployments that want fully-local embeddings run a small
		// serving container and set NOVAMEM_EMBEDDINGS_ENDPOINT at it.
		// This is intentional, not an unfinished port.
		return c, fmt.Errorf(
			"NOVAMEM_EMBEDDINGS_PROVIDER=local-transformers is not supported by the Go server by design — " +
				"run your embedding model behind an OpenAI-compatible endpoint and set " +
				"NOVAMEM_EMBEDDINGS_PROVIDER=openai-compatible with NOVAMEM_EMBEDDINGS_ENDPOINT")
	default:
		return c, fmt.Errorf("NOVAMEM_EMBEDDINGS_PROVIDER %q is not one of openai-compatible", c.EmbeddingsProvider)
	}
	c.EmbeddingsEndpoint = os.Getenv("NOVAMEM_EMBEDDINGS_ENDPOINT")
	c.EmbeddingsModel = os.Getenv("NOVAMEM_EMBEDDINGS_MODEL")
	c.EmbeddingsAPIKey = os.Getenv("NOVAMEM_EMBEDDINGS_API_KEY")
	if c.EmbeddingsDim, err = intEnv("NOVAMEM_EMBEDDINGS_DIM", 384); err != nil {
		return c, err
	}
	if c.EmbeddingsTimeoutMs, err = intEnv("NOVAMEM_EMBEDDINGS_TIMEOUT_MS", 30_000); err != nil {
		return c, err
	}
	c.EmbeddingsQueryPrefix = optEnv("NOVAMEM_EMBEDDINGS_QUERY_PREFIX")
	c.EmbeddingsDocumentPrefix = optEnv("NOVAMEM_EMBEDDINGS_DOCUMENT_PREFIX")
	if c.EmbeddingsProvider == "openai-compatible" && (c.EmbeddingsEndpoint == "" || c.EmbeddingsModel == "") {
		return c, fmt.Errorf("NOVAMEM_EMBEDDINGS_PROVIDER=openai-compatible requires NOVAMEM_EMBEDDINGS_ENDPOINT and NOVAMEM_EMBEDDINGS_MODEL")
	}

	if c.MinVectorScore, err = floatEnv("NOVAMEM_SEARCH_MIN_VECTOR_SCORE", 0.25); err != nil {
		return c, err
	}
	if c.GraphLinkFanout, err = intEnv("NOVAMEM_GRAPH_LINK_FANOUT", 3); err != nil {
		return c, err
	}

	if c.DecayIntervalMs, err = intEnv("NOVAMEM_DECAY_INTERVAL_MS", 6*60*60*1000); err != nil {
		return c, err
	}
	// NOVAMEM_DECAY_DAYS is the canonical name (config.ts decay.
	// defaultEffectiveDays). NOVAMEM_DECAY_DEFAULT_EFFECTIVE_DAYS is kept
	// as a deprecated alias for deployments that picked up the Go-only
	// spelling; the TS name wins when both are set.
	decayKey := "NOVAMEM_DECAY_DAYS"
	if os.Getenv(decayKey) == "" && os.Getenv("NOVAMEM_DECAY_DEFAULT_EFFECTIVE_DAYS") != "" {
		decayKey = "NOVAMEM_DECAY_DEFAULT_EFFECTIVE_DAYS"
	}
	if c.DecayEffectiveDays, err = posFloatEnv(decayKey, 7); err != nil {
		return c, err
	}
	if c.ReconcileIntervalMs, err = intEnv("NOVAMEM_EMBEDDINGS_RECONCILE_INTERVAL_MS", 60_000); err != nil {
		return c, err
	}
	if c.ReconcileBatch, err = intEnv("NOVAMEM_EMBEDDINGS_RECONCILE_BATCH", 400); err != nil {
		return c, err
	}
	if c.RateLimitPerMinute, err = intEnv("NOVAMEM_RATE_LIMIT_PER_MINUTE", 600); err != nil {
		return c, err
	}
	if c.PgPoolMax, err = intEnv("NOVAMEM_PG_POOL_MAX", 20); err != nil {
		return c, err
	}
	// Upper bound as well as lower: pgxpool takes an int32, and an
	// unbounded int→int32 conversion on a 64-bit platform silently wraps
	// (CodeQL flagged exactly this). No real deployment wants more than
	// a few hundred connections, so refuse absurd values loudly instead.
	if c.PgPoolMax < 1 || c.PgPoolMax > math.MaxInt32 {
		return c, fmt.Errorf("NOVAMEM_PG_POOL_MAX must be a positive integer below %d", int64(math.MaxInt32))
	}
	c.BootstrapAdminEmail = os.Getenv("NOVAMEM_BOOTSTRAP_ADMIN_EMAIL")
	c.BootstrapAdminPassword = os.Getenv("NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD")
	// main.ts scrubs the password from the environment right after
	// reading it so a later `env` dump (or a child process) can't see it.
	_ = os.Unsetenv("NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD")

	// Unset (or anything that isn't a falsy spelling) leaves the admin
	// surface enabled — config.ts admin.dashboard.
	switch raw := strings.ToLower(strings.TrimSpace(os.Getenv("NOVAMEM_ADMIN_DASHBOARD"))); raw {
	case "0", "false", "no", "off":
		c.AdminDashboard = false
	default:
		c.AdminDashboard = true
	}

	c.RerankEnabled = boolEnv("NOVAMEM_RERANK_ENABLED")
	c.RerankEndpoint = os.Getenv("NOVAMEM_RERANK_ENDPOINT")
	c.RerankModel = os.Getenv("NOVAMEM_RERANK_MODEL")
	c.RerankAPIKey = os.Getenv("NOVAMEM_RERANK_API_KEY")
	if c.RerankPoolMult, err = intEnv("NOVAMEM_RERANK_POOL_MULTIPLIER", 4); err != nil {
		return c, err
	}
	if c.RerankTimeoutMs, err = intEnv("NOVAMEM_RERANK_TIMEOUT_MS", 5_000); err != nil {
		return c, err
	}
	if c.RerankEnabled && (c.RerankEndpoint == "" || c.RerankModel == "") {
		return c, fmt.Errorf("rerank.enabled = true requires endpoint + model (NOVAMEM_RERANK_ENDPOINT / NOVAMEM_RERANK_MODEL)")
	}

	// The three LLM subsystems. NOTE the enable flags use coerceBool, not
	// boolEnv: config.ts declares these three with `z.coerce.boolean()`
	// (JS truthiness over the raw env string) while `rerank.enabled` uses
	// the EnvBoolean helper. So NOVAMEM_EXTRACTION_ENABLED=false enables
	// extraction on the TS server, and must here too — the config surface
	// is a frozen contract, quirks included.
	c.ExtractionEnabled = coerceBool("NOVAMEM_EXTRACTION_ENABLED", false)
	c.ExtractionEndpoint = os.Getenv("NOVAMEM_EXTRACTION_ENDPOINT")
	c.ExtractionModel = os.Getenv("NOVAMEM_EXTRACTION_MODEL")
	c.ExtractionAPIKey = os.Getenv("NOVAMEM_EXTRACTION_API_KEY")
	if c.ExtractionMaxFacts, err = posIntEnv("NOVAMEM_EXTRACTION_MAX_FACTS", 8); err != nil {
		return c, err
	}
	// 120s, not 15-30s: a short timeout aborted generations queued behind
	// a busy vLLM and re-queued them forever. The durable facts_pending
	// marker makes patience free.
	if c.ExtractionTimeoutMs, err = posIntEnv("NOVAMEM_EXTRACTION_TIMEOUT_MS", 120_000); err != nil {
		return c, err
	}
	if c.ExtractionMaxConcurrent, err = posIntEnv("NOVAMEM_EXTRACTION_MAX_CONCURRENT", 12); err != nil {
		return c, err
	}
	if c.ExtractionEnabled && (c.ExtractionEndpoint == "" || c.ExtractionModel == "") {
		return c, fmt.Errorf("extraction.enabled = true requires endpoint + model (NOVAMEM_EXTRACTION_ENDPOINT / NOVAMEM_EXTRACTION_MODEL)")
	}

	c.QueryDecompEnabled = coerceBool("NOVAMEM_QUERY_DECOMP_ENABLED", false)
	c.QueryDecompEndpoint = os.Getenv("NOVAMEM_QUERY_DECOMP_ENDPOINT")
	c.QueryDecompModel = os.Getenv("NOVAMEM_QUERY_DECOMP_MODEL")
	c.QueryDecompAPIKey = os.Getenv("NOVAMEM_QUERY_DECOMP_API_KEY")
	if c.QueryDecompMaxSubqueries, err = posIntEnv("NOVAMEM_QUERY_DECOMP_MAX_SUBQUERIES", 3); err != nil {
		return c, err
	}
	if c.QueryDecompMaxSubqueries < 1 || c.QueryDecompMaxSubqueries > 5 {
		return c, fmt.Errorf("NOVAMEM_QUERY_DECOMP_MAX_SUBQUERIES must be between 1 and 5")
	}
	c.QueryDecompCoherenceRerank = coerceBool("NOVAMEM_QUERY_DECOMP_COHERENCE_RERANK", true)
	if c.QueryDecompTimeoutMs, err = posIntEnv("NOVAMEM_QUERY_DECOMP_TIMEOUT_MS", 8_000); err != nil {
		return c, err
	}
	if c.QueryDecompEnabled && (c.QueryDecompEndpoint == "" || c.QueryDecompModel == "") {
		return c, fmt.Errorf("queryDecomp.enabled = true requires endpoint + model (NOVAMEM_QUERY_DECOMP_ENDPOINT / NOVAMEM_QUERY_DECOMP_MODEL)")
	}

	c.ObserverEnabled = coerceBool("NOVAMEM_OBSERVER_ENABLED", false)
	c.ObserverEndpoint = os.Getenv("NOVAMEM_OBSERVER_ENDPOINT")
	c.ObserverModel = os.Getenv("NOVAMEM_OBSERVER_MODEL")
	c.ObserverAPIKey = os.Getenv("NOVAMEM_OBSERVER_API_KEY")
	if c.ObserverObserveThreshold, err = posIntEnv("NOVAMEM_OBSERVER_OBSERVE_THRESHOLD", 10); err != nil {
		return c, err
	}
	if c.ObserverReflectThreshold, err = posIntEnv("NOVAMEM_OBSERVER_REFLECT_THRESHOLD", 50); err != nil {
		return c, err
	}
	if c.ObserverTimeoutMs, err = posIntEnv("NOVAMEM_OBSERVER_TIMEOUT_MS", 30_000); err != nil {
		return c, err
	}
	if c.ObserverEnabled && (c.ObserverEndpoint == "" || c.ObserverModel == "") {
		return c, fmt.Errorf("observer.enabled = true requires endpoint + model (NOVAMEM_OBSERVER_ENDPOINT / NOVAMEM_OBSERVER_MODEL)")
	}
	c.PprofAddr = os.Getenv("NOVAMEM_PPROF_ADDR")
	return c, nil
}

// coerceBool — Zod's `z.coerce.boolean()` over a raw env string: JS
// truthiness, so ANY non-empty value (including "0" and "false") is true
// and only "" is false. An unset variable falls back to `def`.
func coerceBool(key string, def bool) bool {
	raw, set := os.LookupEnv(key)
	if !set {
		return def
	}
	return raw != ""
}

// posIntEnv — `z.coerce.number().int().positive()`: a strictly positive
// integer, with an unparseable or non-positive value refused loudly
// rather than silently defaulted.
func posIntEnv(key string, def int) (int, error) {
	raw := os.Getenv(key)
	if raw == "" {
		return def, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return def, fmt.Errorf("%s %q is not a positive integer", key, raw)
	}
	return n, nil
}

// csvEnv splits a comma-separated list, trimming and dropping blanks.
func csvEnv(raw string) []string {
	var out []string
	for _, part := range strings.Split(raw, ",") {
		if v := strings.TrimSpace(part); v != "" {
			out = append(out, v)
		}
	}
	return out
}

func optEnv(key string) *string {
	if v, ok := os.LookupEnv(key); ok {
		return &v
	}
	return nil
}

// boolEnv — the EnvBoolean spellings config.ts accepts.
func boolEnv(key string) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(key))) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

func floatEnv(key string, def float64) (float64, error) {
	raw := os.Getenv(key)
	if raw == "" {
		return def, nil
	}
	n, err := strconv.ParseFloat(raw, 64)
	if err != nil || n < 0 || n > 1 {
		return def, fmt.Errorf("%s %q is not a number in [0,1]", key, raw)
	}
	return n, nil
}

// posFloatEnv — a positive float (the [0,1]-bounded floatEnv above is
// for score thresholds).
func posFloatEnv(key string, def float64) (float64, error) {
	raw := os.Getenv(key)
	if raw == "" {
		return def, nil
	}
	n, err := strconv.ParseFloat(raw, 64)
	if err != nil || n <= 0 {
		return def, fmt.Errorf("%s %q is not a positive number", key, raw)
	}
	return n, nil
}

func intEnv(key string, def int) (int, error) {
	raw := os.Getenv(key)
	if raw == "" {
		return def, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 0 {
		return def, fmt.Errorf("%s %q is not a non-negative integer", key, raw)
	}
	return n, nil
}

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
