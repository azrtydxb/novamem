package conformance

// Live-target env + HTTP helpers, transcribed from
// packages/conformance/src/{env,client}.ts. Semantics preserved exactly:
// the same env vars, the same default headers, the same Better-Auth
// throttle retry, the same browser cookie-jar join.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

// Env mirrors env.ts. Loaded once; Target(t) skips the test when no
// live target is configured (conformance is a live-target suite).
type Env struct {
	URL           string // NOVAMEM_URL, trailing slash stripped
	TestToken     string // NOVAMEM_TEST_TOKEN
	AdminToken    string // NOVAMEM_ADMIN_TOKEN
	AuthMode      string // NOVAMEM_AUTH_MODE: none | bearer | user (default user)
	AdminCookie   string // NOVAMEM_ADMIN_COOKIE — pre-minted session cookie
	AdminEmail    string // NOVAMEM_ADMIN_EMAIL
	AdminPassword string // NOVAMEM_ADMIN_PASSWORD
	// Origin for Better Auth sign-in: BA's trusted-origin check rejects
	// `Origin: null` while a MISSING origin passes. Must match the
	// server's NOVAMEM_BASE_URL.
	Origin string // NOVAMEM_ORIGIN
	// An origin on the target's NOVAMEM_CORS_ORIGINS allow-list; defaults
	// to config.ts's own default.
	CorsAllowedOrigin string // NOVAMEM_CORS_ALLOWED_ORIGIN
	// Tri-state mirror of the server's NOVAMEM_ADMIN_DASHBOARD; unset ⇒
	// the dashboard suite probes /admin once and infers the mode.
	AdminDashboard string // NOVAMEM_ADMIN_DASHBOARD
	// True when the target runs the LLM subsystems; unset ⇒ 90-llm skips
	// loudly instead of waiting on facts that will never be derived.
	LLMSubsystems bool // NOVAMEM_LLM_SUBSYSTEMS
}

var (
	envOnce sync.Once
	envVal  Env
)

func loadEnv() Env {
	envOnce.Do(func() {
		yes := regexp.MustCompile(`^(?i)(1|true|yes|on)$`)
		envVal = Env{
			URL:               strings.TrimRight(os.Getenv("NOVAMEM_URL"), "/"),
			TestToken:         os.Getenv("NOVAMEM_TEST_TOKEN"),
			AdminToken:        os.Getenv("NOVAMEM_ADMIN_TOKEN"),
			AuthMode:          getenvDefault("NOVAMEM_AUTH_MODE", "user"),
			AdminCookie:       os.Getenv("NOVAMEM_ADMIN_COOKIE"),
			AdminEmail:        os.Getenv("NOVAMEM_ADMIN_EMAIL"),
			AdminPassword:     os.Getenv("NOVAMEM_ADMIN_PASSWORD"),
			Origin:            os.Getenv("NOVAMEM_ORIGIN"),
			CorsAllowedOrigin: getenvDefault("NOVAMEM_CORS_ALLOWED_ORIGIN", "http://localhost:5173"),
			AdminDashboard:    os.Getenv("NOVAMEM_ADMIN_DASHBOARD"),
			LLMSubsystems:     yes.MatchString(os.Getenv("NOVAMEM_LLM_SUBSYSTEMS")),
		}
	})
	return envVal
}

func getenvDefault(name, def string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return def
}

// Target returns the env, skipping the test when NOVAMEM_URL is unset —
// the suite builds and vets everywhere but only asserts against a live
// server, same posture as the TS package.
func Target(t *testing.T) Env {
	t.Helper()
	e := loadEnv()
	if e.URL == "" {
		t.Skip("NOVAMEM_URL not set — conformance is a live-target suite")
	}
	return e
}

// HasAdminIdentity reports whether a Better-Auth admin session is
// obtainable (pre-minted cookie, or credentials to sign in with).
func (e Env) HasAdminIdentity() bool {
	return e.AdminCookie != "" || (e.AdminEmail != "" && e.AdminPassword != "")
}

// SkipUnless skips the test when the live oracle is not running in one
// of the given auth modes (it.skipIf(skipUnless([...])) in TS).
func SkipUnless(t *testing.T, modes ...string) {
	t.Helper()
	e := loadEnv()
	for _, m := range modes {
		if e.AuthMode == m {
			return
		}
	}
	t.Skipf("auth mode %q not in %v", e.AuthMode, modes)
}

// NS returns a fresh run-scoped namespace (conf-<run>-<seq>).
var (
	nsRun  = fmt.Sprintf("conf-%d", time.Now().UnixNano()%1e9)
	nsSeq  int
	nsLock sync.Mutex
)

func NS() string {
	nsLock.Lock()
	defer nsLock.Unlock()
	nsSeq++
	return fmt.Sprintf("%s-%d", nsRun, nsSeq)
}

// Result is one API response: status, decoded JSON body (or raw string
// when non-JSON), and headers.
type Result struct {
	Status  int
	Body    any
	Headers http.Header
}

// Str returns the body as its raw string form when it was non-JSON, or
// "" otherwise.
func (r Result) Str() string {
	s, _ := r.Body.(string)
	return s
}

// Obj returns the body as an object; fails the test otherwise.
func (r Result) Obj(t *testing.T) map[string]any {
	t.Helper()
	m, ok := r.Body.(map[string]any)
	if !ok {
		t.Fatalf("body is %T, want object: %v", r.Body, r.Body)
	}
	return m
}

// Field returns body[name]; fails the test when the body is not an object.
func (r Result) Field(t *testing.T, name string) any {
	t.Helper()
	return r.Obj(t)[name]
}

// MustValidate asserts the body matches a schema.
func (r Result) MustValidate(t *testing.T, s Type) map[string]any {
	t.Helper()
	if err := Validate(r.Body, s); err != nil {
		raw, _ := json.Marshal(r.Body)
		t.Fatalf("response shape: %v\nbody: %s", err, raw)
	}
	return r.Obj(t)
}

// Opts configures one request. Method defaults to POST when Body is set,
// GET otherwise. Token: nil ⇒ the run's NOVAMEM_TEST_TOKEN; a pointer to
// "" ⇒ no Authorization header at all (TS `token: ""`).
type Opts struct {
	Method  string
	Body    any
	Token   *string
	Headers map[string]string
}

// NoAuth is the Opts.Token value that suppresses the bearer header.
var NoAuth = ptr("")

func ptr(s string) *string { return &s }

// httpClient mirrors client.ts's generous dispatcher: a live dream-cycle
// run has been observed at ~5m47s, so the ceiling is 11 minutes.
var httpClient = &http.Client{Timeout: 660 * time.Second}

// API performs one request against the live target.
func API(t *testing.T, path string, o Opts) Result {
	t.Helper()
	r, err := apiE(path, o)
	if err != nil {
		t.Fatalf("%s %s: %v", o.Method, path, err)
	}
	return r
}

func apiE(path string, o Opts) (Result, error) {
	e := loadEnv()
	token := e.TestToken
	if o.Token != nil {
		token = *o.Token
	}
	method := o.Method
	if method == "" {
		if o.Body != nil {
			method = http.MethodPost
		} else {
			method = http.MethodGet
		}
	}
	var body io.Reader
	if o.Body != nil {
		raw, err := json.Marshal(o.Body)
		if err != nil {
			return Result{}, err
		}
		body = bytes.NewReader(raw)
	}
	req, err := http.NewRequest(method, e.URL+path, body)
	if err != nil {
		return Result{}, err
	}
	// Only set content-type when there is a JSON body to describe — a
	// bare content-type on a bodyless POST turns the auth probe's 401
	// into a spurious 400 (empty-body parse error).
	if o.Body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	for k, v := range o.Headers {
		req.Header.Set(k, v)
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return Result{}, err
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return Result{}, err
	}
	var decoded any = nil
	if len(raw) > 0 {
		if json.Unmarshal(raw, &decoded) != nil {
			decoded = string(raw) // non-JSON stays string
		}
	}
	return Result{Status: resp.StatusCode, Body: decoded, Headers: resp.Header}, nil
}

// AdminAPI is API authenticated with NOVAMEM_ADMIN_TOKEN.
func AdminAPI(t *testing.T, path string, o Opts) Result {
	t.Helper()
	e := loadEnv()
	o.Token = ptr(e.AdminToken)
	return API(t, path, o)
}

// CookieAPI is API authenticated by an explicit session cookie (bearer
// suppressed), with the run's Origin header when configured.
func CookieAPI(t *testing.T, cookie, path string, o Opts) Result {
	t.Helper()
	e := loadEnv()
	o.Token = NoAuth
	h := map[string]string{"Cookie": cookie}
	if e.Origin != "" {
		h["Origin"] = e.Origin
	}
	for k, v := range o.Headers {
		h[k] = v
	}
	o.Headers = h
	return API(t, path, o)
}

// AdminCookieAPI is CookieAPI with the shared admin session.
func AdminCookieAPI(t *testing.T, path string, o Opts) Result {
	t.Helper()
	return CookieAPI(t, AdminCookie(t), path, o)
}

var (
	adminCookieOnce sync.Once
	adminCookieVal  string
	adminCookieErr  error
)

// AdminCookie resolves the admin session cookie: NOVAMEM_ADMIN_COOKIE
// wins; otherwise sign in once with the admin credentials and cache the
// cookie for the whole run.
func AdminCookie(t *testing.T) string {
	t.Helper()
	e := loadEnv()
	if e.AdminCookie != "" {
		return e.AdminCookie
	}
	if e.AdminEmail == "" || e.AdminPassword == "" {
		t.Fatal("cookie-gated route needs NOVAMEM_ADMIN_COOKIE or NOVAMEM_ADMIN_EMAIL+NOVAMEM_ADMIN_PASSWORD")
	}
	adminCookieOnce.Do(func() {
		r, err := SignInRaw(e.AdminEmail, e.AdminPassword)
		if err != nil {
			adminCookieErr = err
			return
		}
		if r.Status != 200 {
			adminCookieErr = fmt.Errorf("admin sign-in failed (%d)", r.Status)
			return
		}
		adminCookieVal = CookieHeaderFrom(r)
		if adminCookieVal == "" {
			adminCookieErr = fmt.Errorf("sign-in returned no set-cookie")
		}
	})
	if adminCookieErr != nil {
		t.Fatalf("admin cookie: %v", adminCookieErr)
	}
	return adminCookieVal
}

// CookieHeaderFrom joins a response's Set-Cookie list into a Cookie
// request header with browser semantics: last value wins per name, and
// an empty value (deletion) removes the cookie. Both matter for
// impersonate-user, which clears and re-sets the session in one reply.
func CookieHeaderFrom(r Result) string {
	type kv struct{ k, v string }
	var order []kv
	jar := map[string]int{}
	for _, raw := range r.Headers.Values("Set-Cookie") {
		pair := strings.SplitN(raw, ";", 2)[0]
		eq := strings.Index(pair, "=")
		if eq < 1 {
			continue
		}
		name := strings.TrimSpace(pair[:eq])
		value := strings.TrimSpace(pair[eq+1:])
		if i, seen := jar[name]; seen {
			order[i].v = value
		} else {
			jar[name] = len(order)
			order = append(order, kv{name, value})
		}
	}
	var parts []string
	for _, c := range order {
		if c.v == "" {
			continue // deletion, not a cookie worth sending
		}
		parts = append(parts, c.k+"="+c.v)
	}
	return strings.Join(parts, "; ")
}

// baThrottle is Better Auth's own per-IP sign-in limiter message (3 per
// 10s). A genuine 429 worth waiting out — unlike novamem's own limiter
// (`{error, retryAfter}`), which must NOT be retried away.
const baThrottle = "Too many requests. Please try again later."

// SignInRaw signs in via /api/auth/sign-in/email, waiting out Better
// Auth's throttle (up to 5 attempts, 4s apart).
func SignInRaw(email, password string) (Result, error) {
	e := loadEnv()
	h := map[string]string{}
	if e.Origin != "" {
		h["Origin"] = e.Origin
	}
	var r Result
	var err error
	for attempt := 0; attempt < 5; attempt++ {
		r, err = apiE("/api/auth/sign-in/email", Opts{
			Body:    map[string]string{"email": email, "password": password},
			Token:   NoAuth,
			Headers: h,
		})
		if err != nil {
			return r, err
		}
		if m, ok := r.Body.(map[string]any); !ok || r.Status != 429 || m["message"] != baThrottle {
			return r, nil
		}
		time.Sleep(4 * time.Second)
	}
	return r, nil
}

// SignIn signs in as an arbitrary account and returns its session
// cookie. Used to drive destructive Better Auth surface against
// throwaway users.
func SignIn(t *testing.T, email, password string) string {
	t.Helper()
	r, err := SignInRaw(email, password)
	if err != nil {
		t.Fatalf("sign-in as %s: %v", email, err)
	}
	if r.Status != 200 {
		raw, _ := json.Marshal(r.Body)
		t.Fatalf("sign-in as %s failed (%d) %s", email, r.Status, raw)
	}
	cookie := CookieHeaderFrom(r)
	if cookie == "" {
		t.Fatalf("sign-in as %s returned no set-cookie", email)
	}
	return cookie
}
