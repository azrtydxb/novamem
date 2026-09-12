package config

// The config package had one test before this file, covering the cold
// provider. That was thin cover for the code that decides whether the
// server boots at all: every fail-fast check here is the difference
// between refusing to start and starting misconfigured, and a
// misconfigured start is the failure that reaches users.
//
// So these tests pin three things:
//
//   - the defaults, as one golden struct. The registry owns them now, so
//     a changed default is a one-line diff here — deliberate rather than
//     discovered on a deploy.
//   - every fail-fast message, by exact text. Operators read these.
//   - the registry's agreement with the code: every variable read is
//     declared, and every variable declared is reachable.

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// minimal is the smallest environment that boots.
var minimal = map[string]string{
	"NOVAMEM_WARM_URL":      "postgres://u:p@localhost:5432/novamem",
	"NOVAMEM_COOKIE_SECRET": "test-cookie-secret-not-a-real-credential",
}

// clearEnv removes every declared variable, then applies overrides, so a
// test observes defaults rather than whatever the developer's shell or
// CI runner happens to export. Restored by t.Cleanup.
func clearEnv(t *testing.T, overrides map[string]string) {
	t.Helper()
	saved := map[string]*string{}
	remember := func(k string) {
		if _, done := saved[k]; done {
			return
		}
		if v, ok := os.LookupEnv(k); ok {
			saved[k] = &v
		} else {
			saved[k] = nil
		}
	}
	// set/unset report errors only for a malformed name, which would
	// mean a bad row in the registry rather than a flaky environment —
	// worth failing on rather than ignoring, and errcheck agrees.
	unset := func(k string) {
		if err := os.Unsetenv(k); err != nil {
			t.Fatalf("unsetting %s: %v", k, err)
		}
	}
	set := func(k, v string) {
		if err := os.Setenv(k, v); err != nil {
			t.Fatalf("setting %s: %v", k, err)
		}
	}
	for _, v := range Vars {
		remember(v.Name)
		unset(v.Name)
	}
	for k, v := range overrides {
		remember(k)
		set(k, v)
	}
	t.Cleanup(func() {
		for k, v := range saved {
			if v == nil {
				unset(k)
			} else {
				set(k, *v)
			}
		}
	})
}

func loadWith(t *testing.T, overrides map[string]string) (Config, error) {
	t.Helper()
	env := map[string]string{}
	for k, v := range minimal {
		env[k] = v
	}
	for k, v := range overrides {
		env[k] = v
	}
	clearEnv(t, env)
	return Load()
}

// TestDefaults pins the whole default configuration as one value.
//
// Written out in full rather than spot-checked: a default that quietly
// changes is exactly the kind of regression that survives a review, and
// a struct literal makes the change a visible diff. It also proves the
// registry defaults reach the fields they are declared for — the one
// thing moving defaults into a table could plausibly have broken.
func TestDefaults(t *testing.T) {
	got, err := loadWith(t, nil)
	if err != nil {
		t.Fatalf("Load with the minimal environment: %v", err)
	}
	want := Config{
		Host:                       "0.0.0.0",
		Port:                       7778,
		WarmURL:                    minimal["NOVAMEM_WARM_URL"],
		LogLevel:                   "info",
		AuthMode:                   "user",
		CookieSecret:               minimal["NOVAMEM_COOKIE_SECRET"],
		BaseURL:                    "http://0.0.0.0:7778",
		MaxContentChars:            4000,
		CorsOrigins:                []string{"http://localhost:5173"},
		PgPoolMax:                  20,
		ColdProvider:               "qdrant",
		ColdURL:                    "http://localhost:6333",
		ColdVectorSize:             384,
		ColdTimeoutMs:              15000,
		EmbeddingsDim:              384,
		EmbeddingsTimeoutMs:        30000,
		MinVectorScore:             0.25,
		GraphLinkFanout:            3,
		DecayIntervalMs:            6 * 60 * 60 * 1000,
		DecayEffectiveDays:         7,
		ReconcileIntervalMs:        60000,
		ReconcileBatch:             400,
		RateLimitPerMinute:         600,
		AdminDashboard:             true,
		RerankPoolMult:             4,
		RerankTimeoutMs:            5000,
		ExtractionMaxFacts:         8,
		ExtractionTimeoutMs:        120000,
		ExtractionMaxConcurrent:    12,
		QueryDecompMaxSubqueries:   3,
		QueryDecompCoherenceRerank: true,
		QueryDecompTimeoutMs:       8000,
		ObserverObserveThreshold:   10,
		ObserverReflectThreshold:   50,
		ObserverTimeoutMs:          30000,
		OTELServiceName:            "novamem",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("default config differs from the pinned value:\n got %+v\nwant %+v", got, want)
	}
}

// TestFailFast pins every startup refusal by exact message. These
// strings are the whole of what an operator sees when a deployment will
// not come up, so they are contract.
func TestFailFast(t *testing.T) {
	for _, tc := range []struct {
		name string
		env  map[string]string
		want string
	}{
		{
			"no warm url",
			map[string]string{"NOVAMEM_WARM_URL": ""},
			"NOVAMEM_WARM_URL is required",
		},
		{
			"bad port",
			map[string]string{"NOVAMEM_PORT": "0"},
			`NOVAMEM_PORT "0" is not a valid port`,
		},
		{
			"port above the range",
			map[string]string{"NOVAMEM_PORT": "65536"},
			`NOVAMEM_PORT "65536" is not a valid port`,
		},
		{
			"non-numeric port",
			map[string]string{"NOVAMEM_PORT": "http"},
			`NOVAMEM_PORT "http" is not a valid port`,
		},
		{
			"unknown auth mode",
			map[string]string{"NOVAMEM_AUTH_MODE": "tenant"},
			`NOVAMEM_AUTH_MODE "tenant" is not one of none|bearer|user`,
		},
		{
			"bearer mode without a token",
			map[string]string{"NOVAMEM_AUTH_MODE": "bearer"},
			"auth.mode = 'bearer' requires auth.token to be set (NOVAMEM_AUTH_TOKEN)",
		},
		{
			"cookie secret too short",
			map[string]string{"NOVAMEM_COOKIE_SECRET": "short"},
			"NOVAMEM_COOKIE_SECRET is required when auth.mode != 'none'. " +
				"Generate one with `openssl rand -hex 32` and set it in your environment",
		},
		{
			"unknown cold provider",
			map[string]string{"NOVAMEM_COLD_PROVIDER": "milvus"},
			`NOVAMEM_COLD_PROVIDER "milvus" is not one of pgvector|qdrant`,
		},
		{
			"local embeddings are refused with an explanation",
			map[string]string{"NOVAMEM_EMBEDDINGS_PROVIDER": "local-transformers"},
			"NOVAMEM_EMBEDDINGS_PROVIDER=local-transformers is not supported by the Go server by design — " +
				"run your embedding model behind an OpenAI-compatible endpoint and set " +
				"NOVAMEM_EMBEDDINGS_PROVIDER=openai-compatible with NOVAMEM_EMBEDDINGS_ENDPOINT",
		},
		{
			"unknown embeddings provider",
			map[string]string{"NOVAMEM_EMBEDDINGS_PROVIDER": "cohere"},
			`NOVAMEM_EMBEDDINGS_PROVIDER "cohere" is not one of openai-compatible`,
		},
		{
			"openai-compatible without an endpoint",
			map[string]string{
				"NOVAMEM_EMBEDDINGS_PROVIDER": "openai-compatible",
				"NOVAMEM_EMBEDDINGS_MODEL":    "text-embedding-3-small",
			},
			"NOVAMEM_EMBEDDINGS_PROVIDER=openai-compatible requires NOVAMEM_EMBEDDINGS_ENDPOINT and NOVAMEM_EMBEDDINGS_MODEL",
		},
		{
			"negative integer",
			map[string]string{"NOVAMEM_GRAPH_LINK_FANOUT": "-1"},
			`NOVAMEM_GRAPH_LINK_FANOUT "-1" is not a non-negative integer`,
		},
		{
			"non-numeric integer",
			map[string]string{"NOVAMEM_MAX_CONTENT_CHARS": "lots"},
			`NOVAMEM_MAX_CONTENT_CHARS "lots" is not a non-negative integer`,
		},
		{
			"zero where positive is required",
			map[string]string{"NOVAMEM_EXTRACTION_MAX_FACTS": "0"},
			`NOVAMEM_EXTRACTION_MAX_FACTS "0" is not a positive integer`,
		},
		{
			"score above one",
			map[string]string{"NOVAMEM_SEARCH_MIN_VECTOR_SCORE": "1.5"},
			`NOVAMEM_SEARCH_MIN_VECTOR_SCORE "1.5" is not a number in [0,1]`,
		},
		{
			"negative decay days",
			map[string]string{"NOVAMEM_DECAY_DAYS": "-3"},
			`NOVAMEM_DECAY_DAYS "-3" is not a positive number`,
		},
		{
			"pool size of zero",
			map[string]string{"NOVAMEM_PG_POOL_MAX": "0"},
			`NOVAMEM_PG_POOL_MAX "0" is not a positive integer`,
		},
		{
			"pool size that would wrap an int32",
			map[string]string{"NOVAMEM_PG_POOL_MAX": "4294967296"},
			"NOVAMEM_PG_POOL_MAX must be a positive integer below 2147483647",
		},
		{
			"too many subqueries",
			map[string]string{"NOVAMEM_QUERY_DECOMP_MAX_SUBQUERIES": "6"},
			"NOVAMEM_QUERY_DECOMP_MAX_SUBQUERIES must be between 1 and 5",
		},
		{
			"rerank enabled without a model",
			map[string]string{
				"NOVAMEM_RERANK_ENABLED":  "1",
				"NOVAMEM_RERANK_ENDPOINT": "http://rerank:8080",
			},
			"rerank.enabled = true requires endpoint + model (NOVAMEM_RERANK_ENDPOINT / NOVAMEM_RERANK_MODEL)",
		},
		{
			"extraction enabled without an endpoint",
			map[string]string{"NOVAMEM_EXTRACTION_ENABLED": "1"},
			"extraction.enabled = true requires endpoint + model (NOVAMEM_EXTRACTION_ENDPOINT / NOVAMEM_EXTRACTION_MODEL)",
		},
		{
			"decomposition enabled without an endpoint",
			map[string]string{"NOVAMEM_QUERY_DECOMP_ENABLED": "1"},
			"queryDecomp.enabled = true requires endpoint + model (NOVAMEM_QUERY_DECOMP_ENDPOINT / NOVAMEM_QUERY_DECOMP_MODEL)",
		},
		{
			"observer enabled without an endpoint",
			map[string]string{"NOVAMEM_OBSERVER_ENABLED": "1"},
			"observer.enabled = true requires endpoint + model (NOVAMEM_OBSERVER_ENDPOINT / NOVAMEM_OBSERVER_MODEL)",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := loadWith(t, tc.env)
			if err == nil {
				t.Fatalf("Load succeeded; want the startup to be refused with %q", tc.want)
			}
			if err.Error() != tc.want {
				t.Errorf("error = %q\n   want %q", err, tc.want)
			}
		})
	}
}

// TestAuthModeNoneNeedsNoCookieSecret — the one mode where an absent
// secret is fine, and the reason the check is conditional rather than
// unconditional.
func TestAuthModeNoneNeedsNoCookieSecret(t *testing.T) {
	c, err := loadWith(t, map[string]string{
		"NOVAMEM_AUTH_MODE":     "none",
		"NOVAMEM_COOKIE_SECRET": "",
	})
	if err != nil {
		t.Fatalf("auth.mode=none should not require a cookie secret: %v", err)
	}
	if c.AuthMode != "none" {
		t.Errorf("AuthMode = %q, want none", c.AuthMode)
	}
}

// TestCoercedBooleansKeepTheirQuirk — the TS server's
// `z.coerce.boolean()` treats any non-empty string as true, so
// `=false` ENABLES these. It is a trap, it is documented as one, and it
// is frozen: the config surface is a contract with existing
// deployments. A test rather than a comment, because the obvious
// "cleanup" is to make these parse like every other boolean.
func TestCoercedBooleansKeepTheirQuirk(t *testing.T) {
	c, err := loadWith(t, map[string]string{
		"NOVAMEM_EXTRACTION_ENABLED":  "false",
		"NOVAMEM_EXTRACTION_ENDPOINT": "http://llm:8000/v1",
		"NOVAMEM_EXTRACTION_MODEL":    "qwen",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !c.ExtractionEnabled {
		t.Error("NOVAMEM_EXTRACTION_ENABLED=false left extraction off — " +
			"the TS server enables it, and this surface is frozen")
	}

	// Empty is the only falsy value.
	c, err = loadWith(t, map[string]string{"NOVAMEM_EXTRACTION_ENABLED": ""})
	if err != nil {
		t.Fatal(err)
	}
	if c.ExtractionEnabled {
		t.Error("an empty NOVAMEM_EXTRACTION_ENABLED enabled extraction")
	}

	// And the ordinary booleans do NOT share the quirk.
	c, err = loadWith(t, map[string]string{"NOVAMEM_RERANK_ENABLED": "false"})
	if err != nil {
		t.Fatal(err)
	}
	if c.RerankEnabled {
		t.Error("NOVAMEM_RERANK_ENABLED=false enabled rerank — " +
			"that one uses the EnvBoolean spellings, not coercion")
	}
}

// TestAdminDashboardDefaultsOn — the inverse-default boolean. Only the
// falsy spellings switch it off; anything else, including a typo, leaves
// the admin surface up. That asymmetry is deliberate (an operator who
// misspells the value keeps their metrics) and worth pinning.
func TestAdminDashboardDefaultsOn(t *testing.T) {
	for raw, want := range map[string]bool{
		"":      true,
		"1":     true,
		"true":  true,
		"yes":   true,
		"maybe": true,
		"0":     false,
		"false": false,
		"no":    false,
		"off":   false,
		" OFF ": false,
	} {
		c, err := loadWith(t, map[string]string{"NOVAMEM_ADMIN_DASHBOARD": raw})
		if err != nil {
			t.Fatal(err)
		}
		if c.AdminDashboard != want {
			t.Errorf("NOVAMEM_ADMIN_DASHBOARD=%q gave %v, want %v", raw, c.AdminDashboard, want)
		}
	}
}

// TestCorsOriginsTriState — unset, empty and "self" are three different
// answers, which is why this variable cannot be a plain list with a
// default.
func TestCorsOriginsTriState(t *testing.T) {
	for _, tc := range []struct {
		name string
		env  map[string]string
		want []string
	}{
		{"unset allows the dev origin", nil, []string{"http://localhost:5173"}},
		{"empty allows none", map[string]string{"NOVAMEM_CORS_ORIGINS": ""}, nil},
		{"self allows none", map[string]string{"NOVAMEM_CORS_ORIGINS": "self"}, nil},
		{"star reflects any", map[string]string{"NOVAMEM_CORS_ORIGINS": "*"}, []string{"*"}},
		{
			"a list is split and trimmed",
			map[string]string{"NOVAMEM_CORS_ORIGINS": "https://a.example, https://b.example ,"},
			[]string{"https://a.example", "https://b.example"},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, err := loadWith(t, tc.env)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(c.CorsOrigins, tc.want) {
				t.Errorf("CorsOrigins = %#v, want %#v", c.CorsOrigins, tc.want)
			}
		})
	}
}

// TestColdURLFollowsTheProvider — the derived default. pgvector shares
// the warm database; qdrant gets its own endpoint. Getting this wrong
// would point the vector tier at a Postgres DSN, or Postgres at an HTTP
// URL, and neither fails at startup.
func TestColdURLFollowsTheProvider(t *testing.T) {
	c, err := loadWith(t, map[string]string{"NOVAMEM_COLD_PROVIDER": "pgvector"})
	if err != nil {
		t.Fatal(err)
	}
	if c.ColdURL != minimal["NOVAMEM_WARM_URL"] {
		t.Errorf("pgvector cold URL = %q, want the warm URL", c.ColdURL)
	}
	c, err = loadWith(t, map[string]string{"NOVAMEM_COLD_PROVIDER": "qdrant"})
	if err != nil {
		t.Fatal(err)
	}
	if c.ColdURL != "http://localhost:6333" {
		t.Errorf("qdrant cold URL = %q, want the local Qdrant", c.ColdURL)
	}
	// An explicit value wins over both.
	c, err = loadWith(t, map[string]string{"NOVAMEM_COLD_URL": "http://qdrant.svc:6333"})
	if err != nil {
		t.Fatal(err)
	}
	if c.ColdURL != "http://qdrant.svc:6333" {
		t.Errorf("explicit cold URL = %q, want it to win", c.ColdURL)
	}
}

// TestBaseURLFollowsHostAndPort — the other derived default, and the
// one that ends up in the OAuth protected-resource document.
func TestBaseURLFollowsHostAndPort(t *testing.T) {
	c, err := loadWith(t, map[string]string{
		"NOVAMEM_HOST": "127.0.0.1",
		"NOVAMEM_PORT": "9999",
	})
	if err != nil {
		t.Fatal(err)
	}
	if c.BaseURL != "http://127.0.0.1:9999" {
		t.Errorf("BaseURL = %q, want it derived from host and port", c.BaseURL)
	}
	c, err = loadWith(t, map[string]string{"NOVAMEM_BASE_URL": "https://novamem.example"})
	if err != nil {
		t.Fatal(err)
	}
	if c.BaseURL != "https://novamem.example" {
		t.Errorf("BaseURL = %q, want the explicit value", c.BaseURL)
	}
}

// TestDeprecatedDecayAlias — the canonical name wins when both are set,
// and the alias still works alone. Deployments picked up the Go-only
// spelling; dropping it would change their decay half-life silently.
func TestDeprecatedDecayAlias(t *testing.T) {
	c, err := loadWith(t, map[string]string{"NOVAMEM_DECAY_DEFAULT_EFFECTIVE_DAYS": "14"})
	if err != nil {
		t.Fatal(err)
	}
	if c.DecayEffectiveDays != 14 {
		t.Errorf("the deprecated alias alone gave %v, want 14", c.DecayEffectiveDays)
	}
	c, err = loadWith(t, map[string]string{
		"NOVAMEM_DECAY_DAYS":                   "3",
		"NOVAMEM_DECAY_DEFAULT_EFFECTIVE_DAYS": "14",
	})
	if err != nil {
		t.Fatal(err)
	}
	if c.DecayEffectiveDays != 3 {
		t.Errorf("with both set, got %v — the canonical name must win", c.DecayEffectiveDays)
	}
	// And the alias is still validated, not waved through.
	_, err = loadWith(t, map[string]string{"NOVAMEM_DECAY_DEFAULT_EFFECTIVE_DAYS": "0"})
	if err == nil || !strings.Contains(err.Error(), "NOVAMEM_DECAY_DEFAULT_EFFECTIVE_DAYS") {
		t.Errorf("a bad alias value was accepted: err = %v", err)
	}
}

// TestOptionalPrefixesDistinguishUnsetFromEmpty — an inferred prefix and
// a suppressed one are different requests, and a plain string default
// cannot tell them apart.
func TestOptionalPrefixesDistinguishUnsetFromEmpty(t *testing.T) {
	c, err := loadWith(t, nil)
	if err != nil {
		t.Fatal(err)
	}
	if c.EmbeddingsQueryPrefix != nil {
		t.Errorf("unset query prefix = %q, want nil so the model id can be consulted", *c.EmbeddingsQueryPrefix)
	}
	c, err = loadWith(t, map[string]string{"NOVAMEM_EMBEDDINGS_QUERY_PREFIX": ""})
	if err != nil {
		t.Fatal(err)
	}
	if c.EmbeddingsQueryPrefix == nil || *c.EmbeddingsQueryPrefix != "" {
		t.Error("an explicitly empty query prefix must suppress the inference, not fall back to it")
	}
}

// TestBootstrapPasswordIsScrubbed — it is read once and removed, so a
// later `env` dump or a child process cannot see it.
func TestBootstrapPasswordIsScrubbed(t *testing.T) {
	c, err := loadWith(t, map[string]string{"NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD": "hunter2"})
	if err != nil {
		t.Fatal(err)
	}
	if c.BootstrapAdminPassword != "hunter2" {
		t.Fatalf("password = %q, want it read before scrubbing", c.BootstrapAdminPassword)
	}
	if v, set := os.LookupEnv("NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD"); set {
		t.Errorf("the password is still in the environment as %q", v)
	}
}

// TestKeepaliveInterval — read per session rather than at startup, so it
// falls back on a bad value instead of failing fast. There is nothing to
// fail into at session-open time.
func TestKeepaliveInterval(t *testing.T) {
	for raw, want := range map[string]int{
		"":         25000,
		"1000":     1000,
		"0":        25000,
		"-5":       25000,
		"forever":  25000,
		"12.5":     25000,
		"60000000": 60000000,
	} {
		clearEnv(t, map[string]string{"NOVAMEM_SSE_KEEPALIVE_MS": raw})
		if got := KeepaliveInterval(); got != want {
			t.Errorf("NOVAMEM_SSE_KEEPALIVE_MS=%q gave %d, want %d", raw, got, want)
		}
	}
}

// ---------------------------------------------------------------------
// Registry agreement. These are the checks that keep the table honest;
// without them "one source" is a claim rather than a property.
// ---------------------------------------------------------------------

// envReaders are the functions allowed to touch the process
// environment. Every one of them calls spec() first, so a read that
// goes through any of them is checked against the registry.
var envReaders = map[string]bool{
	"lookupEnv": true, "hasValue": true, "scrub": true,
	"strEnv": true, "enumEnv": true, "optEnv": true,
	"boolEnv": true, "coerceBool": true, "disableBool": true,
	"portEnv": true, "intEnv": true, "posIntEnv": true,
	"unitFloatEnv": true, "posFloatEnv": true, "csvEnv": true,
}

// TestEveryVariableReadIsDeclared asserts that nothing in this package
// reads the environment except through a registry-checked reader.
//
// It parses the package rather than grepping it. An earlier version
// matched `os.Getenv("LITERAL")` with a regular expression, which was
// weaker than it claimed: `os.Getenv(decayKey)` — a call this very
// package made — passed straight through it, as would any future read
// with a computed key. Checking the call's ENCLOSING FUNCTION instead of
// its argument removes the loophole entirely, because a variable cannot
// be read at all without calling one of the readers, and every reader
// calls spec().
func TestEveryVariableReadIsDeclared(t *testing.T) {
	// Parsed file by file rather than with parser.ParseDir, which is
	// deprecated as of Go 1.25 for not honouring build tags. The files
	// are enumerated here anyway, so the package view buys nothing.
	fset := token.NewFileSet()
	names, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range names {
		if strings.HasSuffix(name, "_test.go") {
			continue
		}
		file, err := parser.ParseFile(fset, name, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		{
			var enclosing string
			ast.Inspect(file, func(n ast.Node) bool {
				if fn, ok := n.(*ast.FuncDecl); ok {
					enclosing = fn.Name.Name
					return true
				}
				call, ok := n.(*ast.CallExpr)
				if !ok {
					return true
				}
				sel, ok := call.Fun.(*ast.SelectorExpr)
				if !ok {
					return true
				}
				ident, ok := sel.X.(*ast.Ident)
				if !ok || ident.Name != "os" {
					return true
				}
				switch sel.Sel.Name {
				case "Getenv", "LookupEnv", "Setenv", "Unsetenv", "Environ":
				default:
					return true
				}
				if !envReaders[enclosing] {
					t.Errorf("%s:%d: %s calls os.%s directly — every environment "+
						"read must go through a registry-checked reader, or the "+
						"variable ends up undeclared and undocumented",
						name, fset.Position(call.Pos()).Line, enclosing, sel.Sel.Name)
				}
				return true
			})
		}
	}
}

// TestEveryDeclaredVariableIsReachable calls Load with every declared
// variable set, which drives each spec() assertion. A variable declared
// as one kind and read as another, or declared and never read at all,
// stops the process — so this test is where that surfaces, rather than
// on a customer's first boot.
func TestEveryDeclaredVariableIsReachable(t *testing.T) {
	env := map[string]string{}
	for _, v := range Vars {
		env[v.Name] = sampleValue(v)
	}
	// The cross-field checks would refuse this environment for reasons
	// that have nothing to do with reachability, so give them what they
	// ask for.
	env["NOVAMEM_EMBEDDINGS_PROVIDER"] = "openai-compatible"
	env["NOVAMEM_AUTH_MODE"] = "user"
	env["NOVAMEM_COLD_PROVIDER"] = "qdrant"
	// Bounded 1..5 by a check in Load that no kind expresses, so the
	// generic sample value of 7 is out of range.
	env["NOVAMEM_QUERY_DECOMP_MAX_SUBQUERIES"] = "3"

	clearEnv(t, env)
	if _, err := Load(); err != nil {
		t.Fatalf("Load with every declared variable set: %v", err)
	}

	// The other half: a variable in the table that nothing reads would
	// be documented and inert.
	//
	// registry.go is EXCLUDED from the search. Including it made this
	// check vacuous — every name is declared there, so the scan matched
	// its own source and passed even with the corresponding read
	// deleted. The name has to appear somewhere that reads it.
	src := readSites(t)
	for _, v := range Vars {
		if !strings.Contains(src, `"`+v.Name+`"`) {
			t.Errorf("%s is declared in registry.go but named nowhere that reads it — "+
				"it is documented and does nothing", v.Name)
		}
	}
}

// readSites is the package source MINUS the registry declarations, so a
// name found in it was found at a call site.
func readSites(t *testing.T) string {
	t.Helper()
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	var b strings.Builder
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") || f == "registry.go" {
			continue
		}
		src, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		b.Write(src)
	}
	return b.String()
}

// sampleValue produces a value each kind accepts, so the reachability
// test can set every variable at once.
func sampleValue(v Var) string {
	switch v.Kind {
	case KindInt, KindPosInt:
		return "7"
	case KindPort:
		return "7778"
	case KindUnitFloat:
		return "0.5"
	case KindPosFloat:
		return "1.5"
	case KindBool, KindCoercedBool, KindDisableBool:
		return "1"
	case KindEnum:
		for _, e := range v.Enum {
			if e != "" {
				return e
			}
		}
		return ""
	case KindCSV:
		return "alpha,beta"
	default:
		if v.Name == "NOVAMEM_COOKIE_SECRET" {
			return minimal[v.Name]
		}
		if v.Name == "NOVAMEM_WARM_URL" || strings.HasSuffix(v.Name, "_URL") {
			return "http://example.invalid"
		}
		return "x"
	}
}

// TestRegistryIsWellFormed — the rules a row must satisfy for the
// generated page to make sense.
func TestRegistryIsWellFormed(t *testing.T) {
	for _, v := range Vars {
		t.Run(v.Name, func(t *testing.T) {
			if v.Description == "" {
				t.Error("no description — it would render an empty cell")
			}
			if !strings.HasSuffix(strings.TrimSpace(v.Description), ".") {
				t.Error("description does not end in a full stop; the generator " +
					"appends sentences after it")
			}
			if v.Section == "" {
				t.Error("no section — it would be left off the page")
			}
			if v.Kind == KindEnum && len(v.Enum) == 0 {
				t.Error("declared as an enum with no accepted values")
			}
			if v.Kind != KindEnum && len(v.Enum) > 0 {
				t.Error("lists accepted values but is not an enum, so they are not enforced")
			}
			if v.Default != nil && v.DefaultNote != "" {
				t.Error("has both a literal default and a note describing one; " +
					"the note wins and the literal is a lie")
			}
			if err := defaultMatchesKind(v); err != nil {
				t.Error(err)
			}
		})
	}
}

// defaultMatchesKind — a default of the wrong Go type would be dropped
// by the type assertion in the reader and silently become the zero
// value, which is how a documented default of 400 becomes an actual 0.
func defaultMatchesKind(v Var) error {
	if v.Default == nil {
		return nil
	}
	var want string
	switch v.Kind {
	case KindString, KindEnum:
		want = "string"
	case KindInt, KindPosInt, KindPort:
		want = "int"
	case KindUnitFloat, KindPosFloat:
		want = "float64"
	case KindBool, KindCoercedBool, KindDisableBool:
		want = "bool"
	default:
		return fmt.Errorf("kind %q takes no default, but one is declared", v.Kind)
	}
	if got := reflect.TypeOf(v.Default).String(); got != want {
		return fmt.Errorf("default is a %s but kind %q is read as %s — "+
			"the type assertion drops it and the zero value is used instead", got, v.Kind, want)
	}
	return nil
}

// TestShellDefaultsRoundTrip — every value the generated .env.example
// writes must parse back, through the reader the server actually uses,
// to the default it claims to be showing.
//
// The bug this exists for: a false default rendered as "0" reads as
// FALSE under KindBool and TRUE under KindCoercedBool, so the first
// generated template told operators to write
// `NOVAMEM_EXTRACTION_ENABLED=0` to keep extraction off — which turns it
// on. A template that silently inverts a setting is worse than no
// template. This is the check that a rendering and its parser agree.
func TestShellDefaultsRoundTrip(t *testing.T) {
	for _, v := range Vars {
		if v.Default == nil || v.DefaultNote != "" {
			continue
		}
		t.Run(v.Name, func(t *testing.T) {
			clearEnv(t, map[string]string{v.Name: v.ShellDefault()})
			var got any
			var err error
			switch v.Kind {
			case KindString, KindEnum:
				if v.Kind == KindEnum {
					got, err = enumEnv(v.Name)
				} else {
					got = strEnv(v.Name)
				}
			case KindInt:
				got, err = intEnv(v.Name)
			case KindPosInt:
				got, err = posIntEnv(v.Name)
			case KindPort:
				got, err = portEnv(v.Name)
			case KindUnitFloat:
				got, err = unitFloatEnv(v.Name)
			case KindPosFloat:
				got, err = posFloatEnv(v.Name)
			case KindBool:
				got = boolEnv(v.Name)
			case KindCoercedBool:
				got = coerceBool(v.Name)
			case KindDisableBool:
				got = disableBool(v.Name)
			default:
				t.Skipf("kind %q carries no default", v.Kind)
			}
			if err != nil {
				t.Fatalf("the rendered default %q was rejected by its own parser: %v",
					v.ShellDefault(), err)
			}
			if got != v.Default {
				t.Errorf("%s=%q parses back as %v, but the declared default is %v — "+
					"the generated .env.example would silently change this setting",
					v.Name, v.ShellDefault(), got, v.Default)
			}
		})
	}
}

// TestTracingEnablement — an endpoint on its own turns tracing on.
//
// The alternative, requiring OTEL_ENABLED as well, means an operator
// configures where to send traces, sees none, and has nothing to tell
// them why. docs/observability.md has always documented either switch,
// and this is the contract that page describes.
func TestTracingEnablement(t *testing.T) {
	for _, tc := range []struct {
		name string
		env  map[string]string
		want bool
	}{
		{"off by default", nil, false},
		{"the flag alone", map[string]string{"OTEL_ENABLED": "1"}, true},
		{
			"an endpoint alone",
			map[string]string{"OTEL_EXPORTER_OTLP_ENDPOINT": "http://jaeger:4318"},
			true,
		},
		{
			"a traces endpoint alone",
			map[string]string{"OTEL_EXPORTER_OTLP_TRACES_ENDPOINT": "http://jaeger:4318/v1/traces"},
			true,
		},
		{
			"the flag switched off but an endpoint set",
			// The endpoint is the clearer statement of intent: someone
			// went to the trouble of naming a collector.
			map[string]string{"OTEL_ENABLED": "0", "OTEL_EXPORTER_OTLP_ENDPOINT": "http://jaeger:4318"},
			true,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, err := loadWith(t, tc.env)
			if err != nil {
				t.Fatal(err)
			}
			if got := c.TracingEnabled(); got != tc.want {
				t.Errorf("TracingEnabled() = %v, want %v", got, tc.want)
			}
		})
	}
}
