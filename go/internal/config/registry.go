package config

import (
	"fmt"
	"strconv"
)

// The environment surface, declared once.
//
// Before this table the surface lived in three places that had no way to
// disagree out loud: the name literal and default at each `os.Getenv`
// call site in config.go, and a hand-written table in
// docs/install/env-reference.md. They had drifted badly — the doc
// advertised an `NOVAMEM_AUTH_MODE=tenant` the loader rejects, named
// `local-transformers` as the embeddings default when the loader refuses
// to start on it, and gave NOVAMEM_EMBEDDINGS_RECONCILE_BATCH a default
// of 50 against the loader's 400. An operator reading the documentation
// could not deploy from it.
//
// So the same rule the rest of the repo runs on, applied here: one
// source, everything else generated. Every variable the server reads is
// declared below with its kind, default and description. Load() reads
// defaults from this table rather than carrying its own copies, and
// cmd/gen-env-docs renders docs/install/env-reference.md from it. A
// default can no longer differ between the code and the page, because
// the page has no default of its own to be wrong about.
//
// Adding a variable means adding a row. `TestEveryVariableReadIsDeclared`
// fails on a bare os.Getenv in this package, and the helpers panic on an
// undeclared name — so a row cannot be skipped and then forgotten.

// Kind is how a raw string is parsed and validated. It also supplies the
// "Type" column of the generated reference, so the documented type is
// the one the parser actually enforces.
type Kind string

const (
	// KindString — any value; empty or unset takes the default.
	KindString Kind = "string"
	// KindOptString distinguishes unset from empty: the loader keeps a
	// *string so an explicitly empty value can mean something different
	// from an absent one (the embedding prefixes are inferred when
	// absent, and suppressed when set to "").
	KindOptString Kind = "string (unset differs from empty)"
	// KindInt — a non-negative integer.
	KindInt Kind = "integer >= 0"
	// KindPosInt — a strictly positive integer.
	KindPosInt Kind = "integer > 0"
	// KindPort — an integer in 1..65535.
	KindPort Kind = "port (1-65535)"
	// KindUnitFloat — a number in [0,1].
	KindUnitFloat Kind = "number in [0,1]"
	// KindPosFloat — a number greater than zero.
	KindPosFloat Kind = "number > 0"
	// KindBool — the EnvBoolean spellings: 1, true, yes, on.
	KindBool Kind = "boolean (1/true/yes/on)"
	// KindCoercedBool is JS truthiness over the raw string, which the TS
	// server got from `z.coerce.boolean()`: ANY non-empty value is true,
	// "false" and "0" included. Documented explicitly because it is a
	// genuine trap, and frozen because the config surface is a contract.
	KindCoercedBool Kind = "boolean (any non-empty value is true, including \"false\")"
	// KindDisableBool is the inverse default: enabled unless explicitly
	// switched off with a falsy spelling.
	KindDisableBool Kind = "boolean (0/false/no/off disable)"
	// KindCSV — a comma-separated list; blanks are trimmed and dropped.
	KindCSV Kind = "comma-separated list"
	// KindEnum — one of Var.Enum.
	KindEnum Kind = "enum"
)

// Var declares one environment variable.
type Var struct {
	Name string
	Kind Kind
	// Default is the value used when the variable is unset, as the
	// loader would produce it. Nil means "no default": the zero value,
	// or a value derived at load time and described by DefaultNote.
	Default any
	// DefaultNote describes a default that cannot be written as a
	// literal because it depends on other settings.
	DefaultNote string
	// Enum lists the accepted values for KindEnum.
	Enum []string
	// Required describes when startup fails without this variable.
	// Empty means the variable is always optional.
	Required string
	// NeededByDefault marks a Required condition that already holds for
	// an untouched deployment — NOVAMEM_COOKIE_SECRET is required
	// because the default auth mode is not "none". Those belong at the
	// top of the generated .env.example, live rather than commented out,
	// because a copied template that omits them does not start.
	NeededByDefault bool
	// TemplateLive writes the variable live (uncommented) in
	// .env.example even though the server starts without it, because a
	// documented install path demands it up front — Docker Compose
	// interpolates NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD with `:?` and aborts
	// when it is unset. Kept separate from Required, which means "the
	// SERVER refuses to start"; conflating them would make the reference
	// page claim a fail-fast that does not exist.
	TemplateLive bool
	// Example is the value the generated .env.example shows for a
	// variable the operator must fill in. It must be a value that does
	// NOT work — an example credential that happens to be valid is one
	// that reaches production — while still showing the shape.
	Example string
	// Secret marks a credential, so the generated page can warn against
	// putting it in a ConfigMap or a committed .env.
	Secret bool
	// Deprecated names the variable to use instead. A deprecated row is
	// still read; it is rendered in its own section rather than beside
	// the supported knobs.
	Deprecated string
	// Section groups the variable in the generated reference. Order is
	// set by sectionOrder below, not by declaration order.
	Section string
	// Description is the prose shown in the reference. One or two
	// sentences: what it does, and what goes wrong at the wrong value.
	Description string
}

// Section names. Constants rather than loose strings so a typo produces
// a missing section at build time instead of a silently orphaned row.
const (
	secTransport  = "Server transport"
	secAuth       = "Authentication"
	secStores     = "Datastores"
	secEmbeddings = "Embeddings"
	secEngine     = "Memory engine"
	secQuotas     = "Quotas and limits"
	secLLM        = "LLM subsystems"
	secOps        = "Logging and diagnostics"
)

// sectionOrder is the order sections appear in the generated page.
var sectionOrder = []string{
	secTransport, secAuth, secStores, secEmbeddings,
	secEngine, secQuotas, secLLM, secOps,
}

// Vars is the declared surface. Order within a section is declaration
// order, which groups related knobs the way an operator reads them.
var Vars = []Var{
	// ---- Server transport ----
	{
		Name: "NOVAMEM_HOST", Kind: KindString, Default: "0.0.0.0", Section: secTransport,
		Description: "Bind address. Use `127.0.0.1` to confine the listener to localhost.",
	},
	{
		Name: "NOVAMEM_PORT", Kind: KindPort, Default: 7778, Section: secTransport,
		Description: "HTTP port. REST, `/mcp`, the dashboard and `/api-docs` are all served here.",
	},
	{
		Name: "NOVAMEM_BASE_URL", Kind: KindString, Section: secTransport,
		DefaultNote: "`http://$NOVAMEM_HOST:$NOVAMEM_PORT`",
		Description: "The public origin. Seeds the trusted-origin list for the sign-in CSRF check and the `resource` identifier in the OAuth protected-resource metadata, so it must be the URL clients actually reach — set it when novamem sits behind a proxy.",
	},
	{
		Name: "NOVAMEM_CORS_ORIGINS", Kind: KindCSV, Section: secTransport,
		DefaultNote: "`http://localhost:5173`",
		Description: "Browser origins allowed to reach `/mcp`. Empty or `self` allows same-origin only; `*` reflects any origin **and disables credentialed CORS**, because reflect-any plus credentials would let any site read authenticated responses.",
	},
	{
		Name: "NOVAMEM_INSECURE_COOKIES", Kind: KindBool, Default: false, Section: secTransport,
		Description: "Drops the `Secure` attribute from session cookies, for a load balancer without TLS or local development. **Dev only**: behind a TLS-terminating proxy it also lets the browser send the session cookie over plain HTTP to the same host.",
	},
	{
		Name: "NOVAMEM_SSE_KEEPALIVE_MS", Kind: KindPosInt, Default: 25000, Section: secTransport,
		Description: "Comment-frame cadence on the streamable `GET /mcp` stream. Must stay below the client's HTTP body-read timeout (undici defaults to five minutes) or the connection is torn down as idle.",
	},

	// ---- Authentication ----
	{
		Name: "NOVAMEM_AUTH_MODE", Kind: KindEnum, Default: "user", Section: secAuth,
		Enum:        []string{"none", "bearer", "user"},
		Description: "`user` is the default: dashboard sessions plus per-user `nm_…` bearers for MCP. `bearer` is a single shared token. `none` disables authentication entirely and makes every request the public tenant — development only.",
	},
	{
		Name: "NOVAMEM_AUTH_TOKEN", Kind: KindString, Section: secAuth, Secret: true,
		Required:    "`NOVAMEM_AUTH_MODE=bearer`",
		Description: "The shared bearer token for `bearer` mode. Useful for a single-process deployment that wants one static credential.",
	},
	{
		Name: "NOVAMEM_COOKIE_SECRET", Kind: KindString, Section: secAuth, Secret: true,
		Required: "`NOVAMEM_AUTH_MODE` is not `none`",
		// The default auth mode is "user", so this is required out of
		// the box — there is deliberately no ephemeral fallback.
		NeededByDefault: true,
		// Left blank on purpose: there is no example secret to show, and
		// a placeholder here is a placeholder that reaches production.
		// The description says how to generate one.
		Description: "Signs session cookies; at least 16 characters. Generate with `openssl rand -hex 32`. Must be stable across restarts — there is deliberately no ephemeral fallback, because one would let a forgotten variable silently invalidate every session on every restart.",
	},
	{
		Name: "NOVAMEM_BOOTSTRAP_ADMIN_EMAIL", Kind: KindString, Section: secAuth,
		Description: "Email for the admin user seeded on first boot, when the deployment has no users yet. Ignored once any user exists.",
	},
	{
		Name: "NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD", Kind: KindString, Section: secAuth, Secret: true,
		// The server starts happily without it — it simply seeds no
		// admin — but docker-compose.yaml interpolates it with `:?`, so
		// the quickstart aborts before anything runs. Live in the
		// template for that reason, not because startup depends on it.
		TemplateLive: true,
		Description:  "Password for the bootstrap admin, used only on first boot when the deployment has no users yet. Read once and then removed from the process environment, so a later `env` dump or a child process cannot see it. Docker Compose requires it to be set even when it will not be used.",
	},
	{
		Name: "NOVAMEM_ADMIN_DASHBOARD", Kind: KindDisableBool, Default: true, Section: secAuth,
		Description: "Master switch for the admin surface. Set `0` to 404 `/v1/admin/metrics` and `/v1/admin/metrics/prom`.",
	},

	// ---- Datastores ----
	{
		Name: "NOVAMEM_WARM_URL", Kind: KindString, Section: secStores, Secret: true,
		Required:        "always",
		NeededByDefault: true,
		Example:         "postgres://novamem:CHANGE_ME@localhost:5432/novamem",
		Description:     "Postgres connection string for the warm tier, the auth tables and the audit log. Startup fails without it rather than serving 503s from a server that cannot store anything.",
	},
	{
		Name: "NOVAMEM_PG_POOL_MAX", Kind: KindPosInt, Default: 20, Section: secStores,
		Description: "Upper bound on the warm Postgres pool. Keep it below the server's `max_connections` divided by the replica count. Values above 2147483647 are refused rather than silently wrapped.",
	},
	{
		Name: "NOVAMEM_COLD_PROVIDER", Kind: KindEnum, Default: "qdrant", Section: secStores,
		Enum:        []string{"pgvector", "qdrant"},
		Description: "Which vector tier backs cold storage. `pgvector` keeps everything in the warm Postgres; `qdrant` uses a separate Qdrant instance.",
	},
	{
		Name: "NOVAMEM_COLD_URL", Kind: KindString, Section: secStores,
		DefaultNote: "`$NOVAMEM_WARM_URL` for `pgvector`, `http://localhost:6333` for `qdrant`",
		Description: "Endpoint for the cold tier.",
	},
	{
		Name: "NOVAMEM_COLD_API_KEY", Kind: KindString, Section: secStores, Secret: true,
		Description: "Sent as the `api-key` header to Qdrant. Unset sends no header.",
	},
	{
		Name: "NOVAMEM_COLD_VECTOR_SIZE", Kind: KindInt, Default: 384, Section: secStores,
		Description: "Dimension of the cold collection. Must match `NOVAMEM_EMBEDDINGS_DIM`.",
	},
	{
		Name: "NOVAMEM_COLD_TIMEOUT_MS", Kind: KindInt, Default: 15000, Section: secStores,
		Description: "Per-request timeout for the vector tier. Bounds a stalled backend so search degrades instead of hanging.",
	},

	// ---- Embeddings ----
	{
		Name: "NOVAMEM_EMBEDDINGS_PROVIDER", Kind: KindEnum, Default: "", Section: secEmbeddings,
		Enum:        []string{"", "openai-compatible"},
		Description: "Unset leaves the embedder unconfigured: writes still store and search degrades to the keyword tier. `openai-compatible` calls an external endpoint. `local-transformers` is **rejected at startup** — the Go server points at an endpoint rather than embedding a model in-process, so run your model behind an OpenAI-compatible server instead.",
	},
	{
		Name: "NOVAMEM_EMBEDDINGS_ENDPOINT", Kind: KindString, Section: secEmbeddings,
		Required:    "`NOVAMEM_EMBEDDINGS_PROVIDER=openai-compatible`",
		Description: "Base URL of the embeddings API, for example `https://api.openai.com/v1`.",
	},
	{
		Name: "NOVAMEM_EMBEDDINGS_MODEL", Kind: KindString, Section: secEmbeddings,
		Required:    "`NOVAMEM_EMBEDDINGS_PROVIDER=openai-compatible`",
		Description: "Model id, for example `text-embedding-3-small` or `nomic-embed-text`. Changing it on an existing deployment invalidates every stored vector; if the dimension is unchanged this fails _silently_, so re-embed after a swap.",
	},
	{
		Name: "NOVAMEM_EMBEDDINGS_API_KEY", Kind: KindString, Section: secEmbeddings, Secret: true,
		Description: "Bearer credential for the embeddings endpoint.",
	},
	{
		Name: "NOVAMEM_EMBEDDINGS_DIM", Kind: KindInt, Default: 384, Section: secEmbeddings,
		Description: "Vector dimension the model produces. Must match `NOVAMEM_COLD_VECTOR_SIZE`.",
	},
	{
		Name: "NOVAMEM_EMBEDDINGS_TIMEOUT_MS", Kind: KindInt, Default: 30000, Section: secEmbeddings,
		Description: "Per-request timeout. The query is embedded _before_ the per-tier degradation fan-out, so an unbounded hang here stalls every search.",
	},
	{
		Name: "NOVAMEM_EMBEDDINGS_QUERY_PREFIX", Kind: KindOptString, Section: secEmbeddings,
		DefaultNote: "inferred from the model id",
		Description: "Prefix applied when embedding a **search query**. Left unset it is inferred (`e5-*` gets `query: `, `bge-*-en` gets `Represent this sentence for searching relevant passages: `); set it to the empty string to suppress the inference. The e5 and bge families lose much of their accuracy when both sides are embedded identically.",
	},
	{
		Name: "NOVAMEM_EMBEDDINGS_DOCUMENT_PREFIX", Kind: KindOptString, Section: secEmbeddings,
		DefaultNote: "inferred from the model id",
		Description: "Prefix applied when embedding **stored content** (`e5-*` gets `passage: `). Set to the empty string to suppress the inference.",
	},
	{
		Name: "NOVAMEM_EMBEDDINGS_RECONCILE_INTERVAL_MS", Kind: KindInt, Default: 60000, Section: secEmbeddings,
		Description: "How often the reconciler drains entries whose vector is missing. `memory_entries.embedded_at IS NULL` **is** the queue, so nothing is lost while the embedder is down and the backlog drains itself when it returns.",
	},
	{
		Name: "NOVAMEM_EMBEDDINGS_RECONCILE_BATCH", Kind: KindInt, Default: 400, Section: secEmbeddings,
		Description: "Entries embedded per reconciler tick. A failed batch is simply retried next tick; there is no attempt ceiling, which is what lets it survive a multi-day outage.",
	},

	// ---- Memory engine ----
	{
		Name: "NOVAMEM_SEARCH_MIN_VECTOR_SCORE", Kind: KindUnitFloat, Default: 0.25, Section: secEngine,
		Description: "Absolute cosine floor for candidates proposed _only_ by the vector tier. Cosine search always returns a nearest neighbour, so without a floor an unrelated store still yields confident-looking hits. Candidates corroborated by a keyword or graph signal are exempt. `0` disables it.",
	},
	{
		Name: "NOVAMEM_GRAPH_LINK_FANOUT", Kind: KindInt, Default: 3, Section: secEngine,
		Description: "How many `co_occurs` graph edges each write links to its nearest vector neighbours. Enrichment runs off the write path and is reconciled in the background, so a slow vector tier delays edges rather than writes. `0` disables graph enrichment entirely.",
	},
	{
		Name: "NOVAMEM_DECAY_INTERVAL_MS", Kind: KindInt, Default: 6 * 60 * 60 * 1000, Section: secEngine,
		Description: "How often the synaptic-decay sweep runs. `0` disables the sweep.",
	},
	{
		Name: "NOVAMEM_DECAY_DAYS", Kind: KindPosFloat, Default: 7.0, Section: secEngine,
		Description: "Base half-life in days. Effective lifespan grows with use: `effectiveDays = NOVAMEM_DECAY_DAYS x log2(hits + 1)`.",
	},
	{
		Name: "NOVAMEM_PERSONAL_TERMS", Kind: KindCSV, Section: secEngine,
		Description: "Deployment-specific vocabulary — operator name, product names, project slugs — that the worthiness scorer treats as high-relevance.",
	},

	// ---- Quotas and limits ----
	{
		Name: "NOVAMEM_MAX_CONTENT_CHARS", Kind: KindInt, Default: 4000, Section: secQuotas,
		Description: "Reject writes longer than this. Past the embedding model's context window the tail is silently dropped by the tokenizer, leaving a memory keyword search finds and vector search cannot. `0` disables the limit.",
	},
	{
		Name: "NOVAMEM_QUOTA_MAX_ENTRIES", Kind: KindInt, Default: 0, Section: secQuotas,
		Description: "Per-user cap on stored entries. `0` means unlimited; quotas are opt-in.",
	},
	{
		Name: "NOVAMEM_QUOTA_WRITES_PER_MINUTE", Kind: KindInt, Default: 0, Section: secQuotas,
		Description: "Per-user write rate cap. `0` means unlimited.",
	},
	{
		Name: "NOVAMEM_RATE_LIMIT_PER_MINUTE", Kind: KindInt, Default: 600, Section: secQuotas,
		Description: "Per-IP request cap. The counter lives in Postgres and is shared across replicas, so the budget is the deployment's rather than each pod's; it falls back to a per-process counter only when the warm store is unreachable. `0` disables the limiter. `/health`, `/live` and `/ready` are never limited.",
	},

	// ---- LLM subsystems ----
	{
		Name: "NOVAMEM_RERANK_ENABLED", Kind: KindBool, Default: false, Section: secLLM,
		Description: "Enables the cross-encoder rerank stage, which callers then opt into per request.",
	},
	{
		Name: "NOVAMEM_RERANK_ENDPOINT", Kind: KindString, Section: secLLM,
		Required:    "`NOVAMEM_RERANK_ENABLED` is on",
		Description: "Full URL of the rerank endpoint.",
	},
	{
		Name: "NOVAMEM_RERANK_MODEL", Kind: KindString, Section: secLLM,
		Required:    "`NOVAMEM_RERANK_ENABLED` is on",
		Description: "Rerank model id.",
	},
	{
		Name: "NOVAMEM_RERANK_API_KEY", Kind: KindString, Section: secLLM, Secret: true,
		Description: "Bearer credential for the rerank endpoint.",
	},
	{
		Name: "NOVAMEM_RERANK_POOL_MULTIPLIER", Kind: KindInt, Default: 4, Section: secLLM,
		Description: "How many times the requested result count is fetched before reranking. A larger pool gives the reranker more to work with and costs more latency.",
	},
	{
		Name: "NOVAMEM_RERANK_TIMEOUT_MS", Kind: KindInt, Default: 5000, Section: secLLM,
		Description: "Per-request rerank timeout. On timeout the fusion ranking stands.",
	},
	{
		Name: "NOVAMEM_EXTRACTION_ENABLED", Kind: KindCoercedBool, Default: false, Section: secLLM,
		Description: "Enables write-time LLM fact extraction, which runs off the write path. The `facts_pending_at` marker is the durable debt, so a failed extraction is retried rather than lost.",
	},
	{
		Name: "NOVAMEM_EXTRACTION_ENDPOINT", Kind: KindString, Section: secLLM,
		Required:    "`NOVAMEM_EXTRACTION_ENABLED` is on",
		Description: "OpenAI-compatible base URL for extraction.",
	},
	{
		Name: "NOVAMEM_EXTRACTION_MODEL", Kind: KindString, Section: secLLM,
		Required:    "`NOVAMEM_EXTRACTION_ENABLED` is on",
		Description: "Extraction model id.",
	},
	{
		Name: "NOVAMEM_EXTRACTION_API_KEY", Kind: KindString, Section: secLLM, Secret: true,
		Description: "Bearer credential for the extraction endpoint.",
	},
	{
		Name: "NOVAMEM_EXTRACTION_MAX_FACTS", Kind: KindPosInt, Default: 8, Section: secLLM,
		Description: "Upper bound on facts extracted from one memory.",
	},
	{
		Name: "NOVAMEM_EXTRACTION_TIMEOUT_MS", Kind: KindPosInt, Default: 120000, Section: secLLM,
		Description: "Per-request extraction timeout. Deliberately generous: a short timeout aborted generations queued behind a busy vLLM and re-queued them forever, and the durable pending marker makes patience free.",
	},
	{
		Name: "NOVAMEM_EXTRACTION_MAX_CONCURRENT", Kind: KindPosInt, Default: 12, Section: secLLM,
		Description: "How many extractions may be in flight at once. Bounds the load a burst of writes puts on the model server.",
	},
	{
		Name: "NOVAMEM_QUERY_DECOMP_ENABLED", Kind: KindCoercedBool, Default: false, Section: secLLM,
		Description: "Enables query decomposition, which callers opt into per request with `decompose`.",
	},
	{
		Name: "NOVAMEM_QUERY_DECOMP_ENDPOINT", Kind: KindString, Section: secLLM,
		Required:    "`NOVAMEM_QUERY_DECOMP_ENABLED` is on",
		Description: "OpenAI-compatible base URL for decomposition.",
	},
	{
		Name: "NOVAMEM_QUERY_DECOMP_MODEL", Kind: KindString, Section: secLLM,
		Required:    "`NOVAMEM_QUERY_DECOMP_ENABLED` is on",
		Description: "Decomposition model id.",
	},
	{
		Name: "NOVAMEM_QUERY_DECOMP_API_KEY", Kind: KindString, Section: secLLM, Secret: true,
		Description: "Bearer credential for the decomposition endpoint.",
	},
	{
		Name: "NOVAMEM_QUERY_DECOMP_MAX_SUBQUERIES", Kind: KindPosInt, Default: 3, Section: secLLM,
		Description: "How many sub-queries one query may be split into. Must be between 1 and 5.",
	},
	{
		Name: "NOVAMEM_QUERY_DECOMP_COHERENCE_RERANK", Kind: KindCoercedBool, Default: true, Section: secLLM,
		Description: "Reranks the merged sub-query results for coherence with the original query. Note the coerced-boolean parsing: setting this to `false` leaves it **on**, because any non-empty value is true — unset it to turn it off.",
	},
	{
		Name: "NOVAMEM_QUERY_DECOMP_TIMEOUT_MS", Kind: KindPosInt, Default: 8000, Section: secLLM,
		Description: "Per-request decomposition timeout. On timeout the original query is searched undecomposed.",
	},
	{
		Name: "NOVAMEM_OBSERVER_ENABLED", Kind: KindCoercedBool, Default: false, Section: secLLM,
		Description: "Enables the Observer/Reflector loop behind `/v1/observe` and `/v1/context-prefix`.",
	},
	{
		Name: "NOVAMEM_OBSERVER_ENDPOINT", Kind: KindString, Section: secLLM,
		Required:    "`NOVAMEM_OBSERVER_ENABLED` is on",
		Description: "OpenAI-compatible base URL for the observer.",
	},
	{
		Name: "NOVAMEM_OBSERVER_MODEL", Kind: KindString, Section: secLLM,
		Required:    "`NOVAMEM_OBSERVER_ENABLED` is on",
		Description: "Observer model id.",
	},
	{
		Name: "NOVAMEM_OBSERVER_API_KEY", Kind: KindString, Section: secLLM, Secret: true,
		Description: "Bearer credential for the observer endpoint.",
	},
	{
		Name: "NOVAMEM_OBSERVER_OBSERVE_THRESHOLD", Kind: KindPosInt, Default: 10, Section: secLLM,
		Description: "How many logged observations trigger an observation pass.",
	},
	{
		Name: "NOVAMEM_OBSERVER_REFLECT_THRESHOLD", Kind: KindPosInt, Default: 50, Section: secLLM,
		Description: "How many logged observations trigger the heavier reflection pass.",
	},
	{
		Name: "NOVAMEM_OBSERVER_TIMEOUT_MS", Kind: KindPosInt, Default: 30000, Section: secLLM,
		Description: "Per-request observer timeout.",
	},

	// ---- Logging and diagnostics ----
	{
		Name: "LOG_LEVEL", Kind: KindString, Default: "info", Section: secOps,
		Description: "Log level: `debug`, `info`, `warn` or `error`.",
	},
	{
		Name: "NOVAMEM_PPROF_ADDR", Kind: KindString, Section: secOps,
		Description: "When set — `127.0.0.1:6060`, say — serves Go `net/http/pprof` on its own listener. A separate socket rather than an API route, so profiling stays reachable in every auth mode and never rides an exposed port by accident.",
	},

	// ---- Deprecated ----
	{
		Name: "NOVAMEM_DECAY_DEFAULT_EFFECTIVE_DAYS", Kind: KindPosFloat, Default: 7.0, Section: secEngine,
		Deprecated:  "NOVAMEM_DECAY_DAYS",
		Description: "A Go-only spelling of the decay half-life that some deployments picked up. Still read, but `NOVAMEM_DECAY_DAYS` wins when both are set.",
	},
}

// byName indexes Vars. Built in init so a lookup is a map hit rather
// than a scan over a 60-row slice on every read.
var byName = func() map[string]Var {
	m := make(map[string]Var, len(Vars))
	for _, v := range Vars {
		if _, dup := m[v.Name]; dup {
			// Two rows for one name means one of them is dead and the
			// other silently wins. Loud at package init, which is any
			// test in this package.
			panic("config: " + v.Name + " is declared twice in Vars")
		}
		m[v.Name] = v
	}
	return m
}()

// spec returns the declaration for key, asserting the kind the caller
// parses it as. A mismatch is a programmer error — a variable declared
// as an integer and read as a boolean would document a type the parser
// does not enforce — so it stops the process rather than reaching an
// operator as a wrong page. Every path here is exercised by Load(), and
// TestEveryDeclaredVariableIsReachable calls Load() with defaults.
func spec(key string, kind Kind) Var {
	v, ok := byName[key]
	if !ok {
		panic("config: " + key + " is read but not declared in Vars — add a row to registry.go")
	}
	if v.Kind != kind {
		panic("config: " + key + " is declared as " + string(v.Kind) + " but read as " + string(kind))
	}
	return v
}

// Lookup returns a declaration by name, for callers outside this
// package that need one variable's metadata.
func Lookup(name string) (Var, bool) {
	v, ok := byName[name]
	return v, ok
}

// SectionOrder is the order sections appear in the generated
// environment reference. Exported for cmd/gen-env-docs; a copy is
// returned so a caller cannot reorder the page by mutating it.
func SectionOrder() []string {
	return append([]string(nil), sectionOrder...)
}

// ShellDefault renders this variable's default as a value to write in an
// env file, which is not the same as rendering it for a page.
//
// The difference is the coerced booleans. A false default printed as "0"
// is correct in a table and actively wrong in a shell file, because
// `NOVAMEM_EXTRACTION_ENABLED=0` ENABLES extraction — any non-empty
// value is true. The generated .env.example suggested exactly that
// before this existed. The only falsy value for those is the empty
// string, so that is what is written.
//
// TestShellDefaultsRoundTrip proves each rendering parses back to the
// declared default through the reader the server actually uses, so this
// cannot drift from the parsers again.
func (v Var) ShellDefault() string {
	if v.DefaultNote != "" {
		return ""
	}
	switch d := v.Default.(type) {
	case nil:
		return ""
	case string:
		return d
	case bool:
		if !d {
			// KindBool reads "0" as false, but KindCoercedBool reads it
			// as TRUE. Empty is false under both, so it is the only
			// rendering that is right for either.
			return ""
		}
		return "1"
	case int:
		return strconv.Itoa(d)
	case float64:
		return strconv.FormatFloat(d, 'g', -1, 64)
	default:
		return fmt.Sprint(d)
	}
}
