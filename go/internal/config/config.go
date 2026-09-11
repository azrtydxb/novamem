// Package config loads the server configuration from the SAME environment
// variables the TypeScript server reads (frozen contract: same config
// surface — packages/server/src/config.ts). Only the variables the
// current slices consume are parsed; unknown NOVAMEM_* vars are ignored
// exactly like the TS loader ignores them.
//
// Every variable is declared once, in registry.go. The helpers below take
// only a key and read that variable's default from the declaration, so a
// default exists in exactly one place and the generated reference page
// cannot disagree with the parser. See the header of registry.go for why.
//
// What stays here is the part a table cannot express: the fail-fast
// checks. Cross-field requirements (an enabled subsystem needs an
// endpoint and a model), defaults derived from other settings, and the
// deprecated decay alias all live in Load, because each is a rule about
// a combination rather than a property of one variable.
package config

import (
	"fmt"
	"math"
	"os"
	"strconv"
	"strings"
)

// Config is the validated server configuration. Every field names the
// environment variable it comes from; that variable's kind, default and
// description live in registry.go.
type Config struct {
	Host     string // NOVAMEM_HOST
	Port     int    // NOVAMEM_PORT
	WarmURL  string // NOVAMEM_WARM_URL (Postgres DSN) — required
	LogLevel string // LOG_LEVEL

	// Auth.
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
	// search.maxContentChars; 0 disables).
	MaxContentChars int // NOVAMEM_MAX_CONTENT_CHARS

	// Deployment-specific high-relevance vocabulary for the worthiness
	// scorer (NOVAMEM_PERSONAL_TERMS, comma-separated).
	PersonalTerms []string

	// Browser origins allowed to reach /mcp (NOVAMEM_CORS_ORIGINS:
	// "" or "self" → none, "*" → any, else comma-separated).
	CorsOrigins []string

	// PgPoolMax bounds the WARM Postgres pool (NOVAMEM_PG_POOL_MAX,
	// config.ts service.pgPoolMax). The cold pgvector pool is NOT covered
	// by it — cold-store-pgvector.ts hardcodes max: 10.
	PgPoolMax int

	// Cold tier. Provider "" leaves the vector tier unconfigured — the
	// server then behaves exactly like TS with the cold store down
	// (rows store with embedded_at NULL, search degrades).
	ColdProvider   string // NOVAMEM_COLD_PROVIDER: pgvector | qdrant
	ColdURL        string // NOVAMEM_COLD_URL
	ColdAPIKey     string // NOVAMEM_COLD_API_KEY — Qdrant api-key header; unset sends none (TS has no such knob)
	ColdVectorSize int    // NOVAMEM_COLD_VECTOR_SIZE
	ColdTimeoutMs  int    // NOVAMEM_COLD_TIMEOUT_MS

	// Embedder. Only the openai-compatible provider is ported (the TS
	// default local-transformers is deliberately unsupported — see the
	// switch below).
	EmbeddingsProvider       string // NOVAMEM_EMBEDDINGS_PROVIDER
	EmbeddingsEndpoint       string // NOVAMEM_EMBEDDINGS_ENDPOINT
	EmbeddingsModel          string // NOVAMEM_EMBEDDINGS_MODEL
	EmbeddingsAPIKey         string // NOVAMEM_EMBEDDINGS_API_KEY
	EmbeddingsDim            int    // NOVAMEM_EMBEDDINGS_DIM
	EmbeddingsTimeoutMs      int    // NOVAMEM_EMBEDDINGS_TIMEOUT_MS
	EmbeddingsQueryPrefix    *string
	EmbeddingsDocumentPrefix *string

	// Search fusion + graph enrichment.
	MinVectorScore  float64 // NOVAMEM_SEARCH_MIN_VECTOR_SCORE
	GraphLinkFanout int     // NOVAMEM_GRAPH_LINK_FANOUT (0 disables)

	// Background jobs (main.ts timers).
	DecayIntervalMs     int     // NOVAMEM_DECAY_INTERVAL_MS
	DecayEffectiveDays  float64 // NOVAMEM_DECAY_DAYS
	ReconcileIntervalMs int     // NOVAMEM_EMBEDDINGS_RECONCILE_INTERVAL_MS
	ReconcileBatch      int     // NOVAMEM_EMBEDDINGS_RECONCILE_BATCH
	// RateLimitPerMinute — global per-IP request cap
	// (NOVAMEM_RATE_LIMIT_PER_MINUTE).
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
	RerankPoolMult  int    // NOVAMEM_RERANK_POOL_MULTIPLIER
	RerankTimeoutMs int    // NOVAMEM_RERANK_TIMEOUT_MS

	// Phase 2 write-time LLM fact extraction. Fire-and-forget off the
	// write path; the facts_pending_at marker is the durable debt.
	ExtractionEnabled       bool   // NOVAMEM_EXTRACTION_ENABLED
	ExtractionEndpoint      string // NOVAMEM_EXTRACTION_ENDPOINT (OpenAI-compatible base)
	ExtractionModel         string // NOVAMEM_EXTRACTION_MODEL
	ExtractionAPIKey        string // NOVAMEM_EXTRACTION_API_KEY
	ExtractionMaxFacts      int    // NOVAMEM_EXTRACTION_MAX_FACTS
	ExtractionTimeoutMs     int    // NOVAMEM_EXTRACTION_TIMEOUT_MS
	ExtractionMaxConcurrent int    // NOVAMEM_EXTRACTION_MAX_CONCURRENT

	// Phase 4 query decomposition + coherence rerank (opt-in per request
	// via SearchRequest.decompose).
	QueryDecompEnabled         bool   // NOVAMEM_QUERY_DECOMP_ENABLED
	QueryDecompEndpoint        string // NOVAMEM_QUERY_DECOMP_ENDPOINT
	QueryDecompModel           string // NOVAMEM_QUERY_DECOMP_MODEL
	QueryDecompAPIKey          string // NOVAMEM_QUERY_DECOMP_API_KEY
	QueryDecompMaxSubqueries   int    // NOVAMEM_QUERY_DECOMP_MAX_SUBQUERIES (1..5)
	QueryDecompCoherenceRerank bool   // NOVAMEM_QUERY_DECOMP_COHERENCE_RERANK
	QueryDecompTimeoutMs       int    // NOVAMEM_QUERY_DECOMP_TIMEOUT_MS

	// Phase 5 Observer/Reflector — the /v1/observe + /v1/context-prefix
	// observation log.
	ObserverEnabled          bool   // NOVAMEM_OBSERVER_ENABLED
	ObserverEndpoint         string // NOVAMEM_OBSERVER_ENDPOINT
	ObserverModel            string // NOVAMEM_OBSERVER_MODEL
	ObserverAPIKey           string // NOVAMEM_OBSERVER_API_KEY
	ObserverObserveThreshold int    // NOVAMEM_OBSERVER_OBSERVE_THRESHOLD
	ObserverReflectThreshold int    // NOVAMEM_OBSERVER_REFLECT_THRESHOLD
	ObserverTimeoutMs        int    // NOVAMEM_OBSERVER_TIMEOUT_MS

	// PprofAddr enables net/http/pprof on its own listener when set
	// (NOVAMEM_PPROF_ADDR, e.g. "127.0.0.1:6060"). Deliberately a
	// separate socket rather than a route on the API server: profiling
	// stays reachable in every auth mode (a dashboard-gated route is
	// unreachable under auth.mode=bearer) and never rides an exposed
	// port by accident. Default off.
	PprofAddr string
}

// Load reads and validates the environment, returning the first problem
// it finds. It is called once at startup and fails fast: a server that
// cannot reach its warm store, or cannot sign a session, refuses to
// start rather than answering every request with a 503.
func Load() (Config, error) {
	var err error
	c := Config{
		Host:      strEnv("NOVAMEM_HOST"),
		WarmURL:   strEnv("NOVAMEM_WARM_URL"),
		LogLevel:  strEnv("LOG_LEVEL"),
		AuthToken: strEnv("NOVAMEM_AUTH_TOKEN"),
	}
	if c.Port, err = portEnv("NOVAMEM_PORT"); err != nil {
		return c, err
	}
	if c.WarmURL == "" {
		// Same fail-fast stance as the TS server: a server without its
		// warm store would 503 every request; refuse to start instead.
		return c, fmt.Errorf("NOVAMEM_WARM_URL is required")
	}
	if c.AuthMode, err = enumEnv("NOVAMEM_AUTH_MODE"); err != nil {
		return c, err
	}
	if c.AuthMode == "bearer" && c.AuthToken == "" {
		// Exact fail-fast from http.ts buildHttpServer.
		return c, fmt.Errorf("auth.mode = 'bearer' requires auth.token to be set (NOVAMEM_AUTH_TOKEN)")
	}
	c.CookieSecret = strEnv("NOVAMEM_COOKIE_SECRET")
	if c.AuthMode != "none" && len(c.CookieSecret) < 16 {
		return c, fmt.Errorf("NOVAMEM_COOKIE_SECRET is required when auth.mode != 'none'. " +
			"Generate one with `openssl rand -hex 32` and set it in your environment")
	}
	c.InsecureCookies = boolEnv("NOVAMEM_INSECURE_COOKIES")
	c.BaseURL = strEnv("NOVAMEM_BASE_URL")
	if c.BaseURL == "" {
		c.BaseURL = fmt.Sprintf("http://%s:%d", c.Host, c.Port)
	}
	if c.QuotaMaxEntries, err = intEnv("NOVAMEM_QUOTA_MAX_ENTRIES"); err != nil {
		return c, err
	}
	if c.QuotaWritesPerMinute, err = intEnv("NOVAMEM_QUOTA_WRITES_PER_MINUTE"); err != nil {
		return c, err
	}
	if c.MaxContentChars, err = intEnv("NOVAMEM_MAX_CONTENT_CHARS"); err != nil {
		return c, err
	}
	c.PersonalTerms = csvEnv("NOVAMEM_PERSONAL_TERMS")

	// CORS: unset keeps the TS default single dev origin; "" / "self"
	// means same-origin only, "*" reflects any origin. The tri-state is
	// why this is not a plain csvEnv — "unset" and "set to empty" mean
	// different things, which a list default cannot express.
	switch raw, set := lookupEnv("NOVAMEM_CORS_ORIGINS", KindCSV); {
	case !set:
		c.CorsOrigins = []string{"http://localhost:5173"}
	case raw == "" || raw == "self":
		c.CorsOrigins = nil
	case raw == "*":
		c.CorsOrigins = []string{"*"}
	default:
		c.CorsOrigins = splitCSV(raw)
	}

	// config.ts defaults this to "qdrant" — an unset provider must select
	// the same backend here, not "no cold tier". A Go server that quietly
	// ran without a vector tier where TS runs Qdrant is exactly the class
	// of silent divergence this migration must not ship.
	if c.ColdProvider, err = enumEnv("NOVAMEM_COLD_PROVIDER"); err != nil {
		return c, err
	}
	// config.ts: unset cold URL means the warm database for pgvector and
	// the local Qdrant otherwise.
	c.ColdURL = strEnv("NOVAMEM_COLD_URL")
	if c.ColdURL == "" {
		c.ColdURL = c.WarmURL
		if c.ColdProvider == "qdrant" {
			c.ColdURL = "http://localhost:6333"
		}
	}
	c.ColdAPIKey = strEnv("NOVAMEM_COLD_API_KEY")
	if c.ColdVectorSize, err = intEnv("NOVAMEM_COLD_VECTOR_SIZE"); err != nil {
		return c, err
	}
	if c.ColdTimeoutMs, err = intEnv("NOVAMEM_COLD_TIMEOUT_MS"); err != nil {
		return c, err
	}

	// Checked before the enum, so the one rejected value gets the
	// explanation rather than the generic "not one of" list.
	if raw, _ := lookupEnv("NOVAMEM_EMBEDDINGS_PROVIDER", KindEnum); raw == "local-transformers" {
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
	}
	if c.EmbeddingsProvider, err = enumEnv("NOVAMEM_EMBEDDINGS_PROVIDER"); err != nil {
		return c, err
	}
	c.EmbeddingsEndpoint = strEnv("NOVAMEM_EMBEDDINGS_ENDPOINT")
	c.EmbeddingsModel = strEnv("NOVAMEM_EMBEDDINGS_MODEL")
	c.EmbeddingsAPIKey = strEnv("NOVAMEM_EMBEDDINGS_API_KEY")
	if c.EmbeddingsDim, err = intEnv("NOVAMEM_EMBEDDINGS_DIM"); err != nil {
		return c, err
	}
	if c.EmbeddingsTimeoutMs, err = intEnv("NOVAMEM_EMBEDDINGS_TIMEOUT_MS"); err != nil {
		return c, err
	}
	c.EmbeddingsQueryPrefix = optEnv("NOVAMEM_EMBEDDINGS_QUERY_PREFIX")
	c.EmbeddingsDocumentPrefix = optEnv("NOVAMEM_EMBEDDINGS_DOCUMENT_PREFIX")
	if c.EmbeddingsProvider == "openai-compatible" && (c.EmbeddingsEndpoint == "" || c.EmbeddingsModel == "") {
		return c, fmt.Errorf("NOVAMEM_EMBEDDINGS_PROVIDER=openai-compatible requires NOVAMEM_EMBEDDINGS_ENDPOINT and NOVAMEM_EMBEDDINGS_MODEL")
	}

	if c.MinVectorScore, err = unitFloatEnv("NOVAMEM_SEARCH_MIN_VECTOR_SCORE"); err != nil {
		return c, err
	}
	if c.GraphLinkFanout, err = intEnv("NOVAMEM_GRAPH_LINK_FANOUT"); err != nil {
		return c, err
	}

	if c.DecayIntervalMs, err = intEnv("NOVAMEM_DECAY_INTERVAL_MS"); err != nil {
		return c, err
	}
	// NOVAMEM_DECAY_DAYS is the canonical name (config.ts decay.
	// defaultEffectiveDays). NOVAMEM_DECAY_DEFAULT_EFFECTIVE_DAYS is kept
	// as a deprecated alias for deployments that picked up the Go-only
	// spelling; the TS name wins when both are set.
	decayKey := "NOVAMEM_DECAY_DAYS"
	if !hasValue(decayKey, KindPosFloat) && hasValue("NOVAMEM_DECAY_DEFAULT_EFFECTIVE_DAYS", KindPosFloat) {
		decayKey = "NOVAMEM_DECAY_DEFAULT_EFFECTIVE_DAYS"
	}
	if c.DecayEffectiveDays, err = posFloatEnv(decayKey); err != nil {
		return c, err
	}
	if c.ReconcileIntervalMs, err = intEnv("NOVAMEM_EMBEDDINGS_RECONCILE_INTERVAL_MS"); err != nil {
		return c, err
	}
	if c.ReconcileBatch, err = intEnv("NOVAMEM_EMBEDDINGS_RECONCILE_BATCH"); err != nil {
		return c, err
	}
	if c.RateLimitPerMinute, err = intEnv("NOVAMEM_RATE_LIMIT_PER_MINUTE"); err != nil {
		return c, err
	}
	if c.PgPoolMax, err = posIntEnv("NOVAMEM_PG_POOL_MAX"); err != nil {
		return c, err
	}
	// Upper bound as well as lower: pgxpool takes an int32, and an
	// unbounded int→int32 conversion on a 64-bit platform silently wraps
	// (CodeQL flagged exactly this). No real deployment wants more than
	// a few hundred connections, so refuse absurd values loudly instead.
	if c.PgPoolMax < 1 || c.PgPoolMax > math.MaxInt32 {
		return c, fmt.Errorf("NOVAMEM_PG_POOL_MAX must be a positive integer below %d", int64(math.MaxInt32))
	}
	c.BootstrapAdminEmail = strEnv("NOVAMEM_BOOTSTRAP_ADMIN_EMAIL")
	c.BootstrapAdminPassword = strEnv("NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD")
	// main.ts scrubs the password from the environment right after
	// reading it so a later `env` dump (or a child process) can't see it.
	scrub("NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD")

	// Unset (or anything that isn't a falsy spelling) leaves the admin
	// surface enabled — config.ts admin.dashboard.
	c.AdminDashboard = disableBool("NOVAMEM_ADMIN_DASHBOARD")

	c.RerankEnabled = boolEnv("NOVAMEM_RERANK_ENABLED")
	c.RerankEndpoint = strEnv("NOVAMEM_RERANK_ENDPOINT")
	c.RerankModel = strEnv("NOVAMEM_RERANK_MODEL")
	c.RerankAPIKey = strEnv("NOVAMEM_RERANK_API_KEY")
	if c.RerankPoolMult, err = intEnv("NOVAMEM_RERANK_POOL_MULTIPLIER"); err != nil {
		return c, err
	}
	if c.RerankTimeoutMs, err = intEnv("NOVAMEM_RERANK_TIMEOUT_MS"); err != nil {
		return c, err
	}
	if c.RerankEnabled && (c.RerankEndpoint == "" || c.RerankModel == "") {
		return c, fmt.Errorf("rerank.enabled = true requires endpoint + model (NOVAMEM_RERANK_ENDPOINT / NOVAMEM_RERANK_MODEL)")
	}

	// The three LLM subsystems. NOTE the enable flags are declared
	// KindCoercedBool, not KindBool: config.ts declares these three with
	// `z.coerce.boolean()` (JS truthiness over the raw env string) while
	// `rerank.enabled` uses the EnvBoolean helper. So
	// NOVAMEM_EXTRACTION_ENABLED=false enables extraction on the TS
	// server, and must here too — the config surface is a frozen
	// contract, quirks included. The registry documents the quirk on
	// each affected row rather than leaving it to this comment.
	c.ExtractionEnabled = coerceBool("NOVAMEM_EXTRACTION_ENABLED")
	c.ExtractionEndpoint = strEnv("NOVAMEM_EXTRACTION_ENDPOINT")
	c.ExtractionModel = strEnv("NOVAMEM_EXTRACTION_MODEL")
	c.ExtractionAPIKey = strEnv("NOVAMEM_EXTRACTION_API_KEY")
	if c.ExtractionMaxFacts, err = posIntEnv("NOVAMEM_EXTRACTION_MAX_FACTS"); err != nil {
		return c, err
	}
	// 120s, not 15-30s: a short timeout aborted generations queued behind
	// a busy vLLM and re-queued them forever. The durable facts_pending
	// marker makes patience free.
	if c.ExtractionTimeoutMs, err = posIntEnv("NOVAMEM_EXTRACTION_TIMEOUT_MS"); err != nil {
		return c, err
	}
	if c.ExtractionMaxConcurrent, err = posIntEnv("NOVAMEM_EXTRACTION_MAX_CONCURRENT"); err != nil {
		return c, err
	}
	if c.ExtractionEnabled && (c.ExtractionEndpoint == "" || c.ExtractionModel == "") {
		return c, fmt.Errorf("extraction.enabled = true requires endpoint + model (NOVAMEM_EXTRACTION_ENDPOINT / NOVAMEM_EXTRACTION_MODEL)")
	}

	c.QueryDecompEnabled = coerceBool("NOVAMEM_QUERY_DECOMP_ENABLED")
	c.QueryDecompEndpoint = strEnv("NOVAMEM_QUERY_DECOMP_ENDPOINT")
	c.QueryDecompModel = strEnv("NOVAMEM_QUERY_DECOMP_MODEL")
	c.QueryDecompAPIKey = strEnv("NOVAMEM_QUERY_DECOMP_API_KEY")
	if c.QueryDecompMaxSubqueries, err = posIntEnv("NOVAMEM_QUERY_DECOMP_MAX_SUBQUERIES"); err != nil {
		return c, err
	}
	if c.QueryDecompMaxSubqueries < 1 || c.QueryDecompMaxSubqueries > 5 {
		return c, fmt.Errorf("NOVAMEM_QUERY_DECOMP_MAX_SUBQUERIES must be between 1 and 5")
	}
	c.QueryDecompCoherenceRerank = coerceBool("NOVAMEM_QUERY_DECOMP_COHERENCE_RERANK")
	if c.QueryDecompTimeoutMs, err = posIntEnv("NOVAMEM_QUERY_DECOMP_TIMEOUT_MS"); err != nil {
		return c, err
	}
	if c.QueryDecompEnabled && (c.QueryDecompEndpoint == "" || c.QueryDecompModel == "") {
		return c, fmt.Errorf("queryDecomp.enabled = true requires endpoint + model (NOVAMEM_QUERY_DECOMP_ENDPOINT / NOVAMEM_QUERY_DECOMP_MODEL)")
	}

	c.ObserverEnabled = coerceBool("NOVAMEM_OBSERVER_ENABLED")
	c.ObserverEndpoint = strEnv("NOVAMEM_OBSERVER_ENDPOINT")
	c.ObserverModel = strEnv("NOVAMEM_OBSERVER_MODEL")
	c.ObserverAPIKey = strEnv("NOVAMEM_OBSERVER_API_KEY")
	if c.ObserverObserveThreshold, err = posIntEnv("NOVAMEM_OBSERVER_OBSERVE_THRESHOLD"); err != nil {
		return c, err
	}
	if c.ObserverReflectThreshold, err = posIntEnv("NOVAMEM_OBSERVER_REFLECT_THRESHOLD"); err != nil {
		return c, err
	}
	if c.ObserverTimeoutMs, err = posIntEnv("NOVAMEM_OBSERVER_TIMEOUT_MS"); err != nil {
		return c, err
	}
	if c.ObserverEnabled && (c.ObserverEndpoint == "" || c.ObserverModel == "") {
		return c, fmt.Errorf("observer.enabled = true requires endpoint + model (NOVAMEM_OBSERVER_ENDPOINT / NOVAMEM_OBSERVER_MODEL)")
	}
	c.PprofAddr = strEnv("NOVAMEM_PPROF_ADDR")
	return c, nil
}

// ---------------------------------------------------------------------
// Readers. Each takes only a key: the default, and the parse rule, come
// from that variable's row in registry.go. spec() asserts the kind, so
// reading a variable as a type it was not declared as stops the process
// rather than documenting a type the parser does not enforce.
// ---------------------------------------------------------------------

// lookupEnv is the one place the process environment is read, so the
// kind assertion cannot be bypassed by reaching for os.Getenv directly.
// It reports whether the variable is set, which the CORS tri-state and
// the optional prefixes need and a defaulted read ignores.
func lookupEnv(key string, kind Kind) (string, bool) {
	spec(key, kind)
	return os.LookupEnv(key)
}

// hasValue reports whether key is set to a non-empty value. Used for the
// deprecated-alias precedence, which is a question about presence rather
// than about a parsed value.
func hasValue(key string, kind Kind) bool {
	spec(key, kind)
	return os.Getenv(key) != ""
}

// scrub removes a variable from the process environment after it has
// been read, so a later `env` dump or a child process cannot see it.
func scrub(key string) {
	spec(key, KindString)
	// The error case is a malformed name, which spec has already ruled
	// out by finding it in the registry.
	_ = os.Unsetenv(key)
}

// strEnv — a string, with an empty value treated as unset. Variables
// with no declared default return "" and are given a derived default by
// Load (NOVAMEM_BASE_URL, NOVAMEM_COLD_URL) or used as-is.
func strEnv(key string) string {
	v := spec(key, KindString)
	if raw := os.Getenv(key); raw != "" {
		return raw
	}
	def, _ := v.Default.(string)
	return def
}

// enumEnv — one of the declared values, refused loudly otherwise. The
// message lists the non-empty values, so a variable whose empty value
// means "unconfigured" advertises only the values worth setting.
func enumEnv(key string) (string, error) {
	v := spec(key, KindEnum)
	raw := os.Getenv(key)
	if raw == "" {
		def, _ := v.Default.(string)
		raw = def
	}
	for _, allowed := range v.Enum {
		if raw == allowed {
			return raw, nil
		}
	}
	var named []string
	for _, allowed := range v.Enum {
		if allowed != "" {
			named = append(named, allowed)
		}
	}
	return raw, fmt.Errorf("%s %q is not one of %s", key, raw, strings.Join(named, "|"))
}

// optEnv keeps unset distinguishable from empty.
func optEnv(key string) *string {
	if v, ok := lookupEnv(key, KindOptString); ok {
		return &v
	}
	return nil
}

// boolEnv — the EnvBoolean spellings config.ts accepts.
func boolEnv(key string) bool {
	v := spec(key, KindBool)
	switch strings.ToLower(strings.TrimSpace(os.Getenv(key))) {
	case "1", "true", "yes", "on":
		return true
	case "":
		def, _ := v.Default.(bool)
		return def
	}
	return false
}

// coerceBool — Zod's `z.coerce.boolean()` over a raw env string: JS
// truthiness, so ANY non-empty value (including "0" and "false") is true
// and only "" is false. An unset variable falls back to the declared
// default.
func coerceBool(key string) bool {
	v := spec(key, KindCoercedBool)
	raw, set := os.LookupEnv(key)
	if !set {
		def, _ := v.Default.(bool)
		return def
	}
	return raw != ""
}

// disableBool — on unless explicitly switched off. Anything that is not
// a falsy spelling leaves it enabled, which is how config.ts reads
// admin.dashboard.
func disableBool(key string) bool {
	spec(key, KindDisableBool)
	switch strings.ToLower(strings.TrimSpace(os.Getenv(key))) {
	case "0", "false", "no", "off":
		return false
	}
	return true
}

// portEnv — an integer in 1..65535.
func portEnv(key string) (int, error) {
	v := spec(key, KindPort)
	def, _ := v.Default.(int)
	raw := os.Getenv(key)
	if raw == "" {
		return def, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 || n > 65535 {
		return def, fmt.Errorf("%s %q is not a valid port", key, raw)
	}
	return n, nil
}

// intEnv — a non-negative integer.
func intEnv(key string) (int, error) {
	v := spec(key, KindInt)
	def, _ := v.Default.(int)
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

// posIntEnv — `z.coerce.number().int().positive()`: a strictly positive
// integer, with an unparseable or non-positive value refused loudly
// rather than silently defaulted.
func posIntEnv(key string) (int, error) {
	v := spec(key, KindPosInt)
	def, _ := v.Default.(int)
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

// unitFloatEnv — a number in [0,1], for score thresholds.
func unitFloatEnv(key string) (float64, error) {
	v := spec(key, KindUnitFloat)
	def, _ := v.Default.(float64)
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

// posFloatEnv — a number greater than zero.
func posFloatEnv(key string) (float64, error) {
	v := spec(key, KindPosFloat)
	def, _ := v.Default.(float64)
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

// csvEnv reads a declared comma-separated list.
func csvEnv(key string) []string {
	spec(key, KindCSV)
	return splitCSV(os.Getenv(key))
}

// splitCSV splits a comma-separated list, trimming and dropping blanks.
func splitCSV(raw string) []string {
	var out []string
	for _, part := range strings.Split(raw, ",") {
		if v := strings.TrimSpace(part); v != "" {
			out = append(out, v)
		}
	}
	return out
}

// KeepaliveInterval is the comment-frame cadence for the streamable
// GET /mcp stream, read at session-open time like the TS
// resolveKeepaliveMs. Exported because the transport needs it and every
// environment read belongs behind the registry — a bare os.Getenv there
// would be a variable with no declared default and no documentation.
func KeepaliveInterval() (ms int) {
	ms, err := posIntEnv("NOVAMEM_SSE_KEEPALIVE_MS")
	if err != nil {
		// Unparseable keepalives have always fallen back rather than
		// failing: this is read per session, long after startup, where
		// there is nothing to fail fast into.
		v, _ := Lookup("NOVAMEM_SSE_KEEPALIVE_MS")
		def, _ := v.Default.(int)
		return def
	}
	return ms
}
