// Package config loads the server configuration from the SAME environment
// variables the TypeScript server reads (frozen contract: same config
// surface — packages/server/src/config.ts). Only the variables the
// current slices consume are parsed; unknown NOVAMEM_* vars are ignored
// exactly like the TS loader ignores them.
package config

import (
	"fmt"
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

	// Cold tier. Provider "" leaves the vector tier unconfigured — the
	// server then behaves exactly like TS with the cold store down
	// (rows store with embedded_at NULL, search degrades). Only
	// pgvector is ported; qdrant is refused loudly.
	ColdProvider   string // NOVAMEM_COLD_PROVIDER: pgvector
	ColdURL        string // NOVAMEM_COLD_URL, default = warm URL
	ColdVectorSize int    // NOVAMEM_COLD_VECTOR_SIZE, default 384
	ColdTimeoutMs  int    // NOVAMEM_COLD_TIMEOUT_MS, default 15000

	// Embedder. Only the openai-compatible provider is ported (the TS
	// default local-transformers has no Go equivalent).
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

	// Phase 5 cross-encoder rerank (opt-in per request; off unless enabled).
	RerankEnabled   bool   // NOVAMEM_RERANK_ENABLED
	RerankEndpoint  string // NOVAMEM_RERANK_ENDPOINT (full URL)
	RerankModel     string // NOVAMEM_RERANK_MODEL
	RerankAPIKey    string // NOVAMEM_RERANK_API_KEY
	RerankPoolMult  int    // NOVAMEM_RERANK_POOL_MULTIPLIER, default 4
	RerankTimeoutMs int    // NOVAMEM_RERANK_TIMEOUT_MS, default 5000
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
			"Generate one with `openssl rand -hex 32` and set it in your environment.")
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

	c.ColdProvider = os.Getenv("NOVAMEM_COLD_PROVIDER")
	switch c.ColdProvider {
	case "", "pgvector":
	case "qdrant":
		return c, fmt.Errorf("NOVAMEM_COLD_PROVIDER=qdrant is not ported to the Go server — use pgvector")
	default:
		return c, fmt.Errorf("NOVAMEM_COLD_PROVIDER %q is not one of pgvector", c.ColdProvider)
	}
	c.ColdURL = getenv("NOVAMEM_COLD_URL", c.WarmURL)
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
		return c, fmt.Errorf("NOVAMEM_EMBEDDINGS_PROVIDER=local-transformers is not ported to the Go server — use openai-compatible")
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
	return c, nil
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
