package initcli

// Sign in to a novamem server with email + password (Better Auth) and
// mint a long-lived `nm_…` bearer for the caller. Plain net/http; no SDK.
//
// The flow:
//
//	POST /api/auth/sign-in/email         → session cookie
//	POST /v1/me/tokens                    (with cookie) → plaintext nm_…
//
// The session is discarded immediately after the bearer is minted.
//
// The bearer is only ever returned to the caller: it is never logged,
// never written to a file by this module, and never embedded in an
// error message.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// defaultAuthTimeout bounds every request this module makes when the
// caller does not supply its own *http.Client. The TypeScript original
// relied on Node's fetch default (no timeout); an installer that hangs
// forever on an unreachable host is worse than one that gives up, so
// the Go port makes the bound explicit.
const defaultAuthTimeout = 30 * time.Second

// maxErrorBody caps how much of a failure body we read before parsing
// it for an `error` field. Bodies are never echoed raw (see
// FormatBodyError), so this is purely a memory bound.
const maxErrorBody = 64 * 1024

// AuthError is the error type every exported function in this file
// returns. Status is the HTTP status that produced it, or 0 for
// failures that never got a response (transport errors) or that were
// malformed successes (missing cookie, missing plaintext).
type AuthError struct {
	Message string
	Status  int
}

func (e *AuthError) Error() string { return e.Message }

func newAuthError(status int, format string, args ...any) *AuthError {
	return &AuthError{Message: fmt.Sprintf(format, args...), Status: status}
}

// SignInOptions mirrors the TypeScript SignInOptions. HTTPClient is the
// injection point for tests (the TS original injected `fetchImpl`); a
// nil client means "use a fresh client with defaultAuthTimeout".
type SignInOptions struct {
	BaseURL  string
	Email    string
	Password string

	HTTPClient *http.Client
}

// MintTokenOptions mirrors the TypeScript MintTokenOptions. An empty
// Label means "novamem-init", matching the TS `opts.label ?? …`.
type MintTokenOptions struct {
	BaseURL       string
	SessionCookie string
	Label         string

	HTTPClient *http.Client
}

// ProbeHealth probes the server's /health endpoint. Returns an
// *AuthError on transport failure or non-2xx. The client may be nil.
func ProbeHealth(baseURL string, client *http.Client) error {
	url := trimTrailingSlash(baseURL) + "/health"
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return newAuthError(0, "cannot reach %s — is the server running? (%s)", url, err)
	}
	res, err := doRequest(client, req)
	if err != nil {
		return newAuthError(0, "cannot reach %s — is the server running? (%s)", url, err)
	}
	defer drainAndClose(res)
	if !isOK(res) {
		return newAuthError(res.StatusCode, "health check failed: %s", statusText(res))
	}
	return nil
}

// SignIn returns the Better Auth session cookie string (the `name=value`
// pair we need to send back on subsequent requests). Returns an
// *AuthError on failure.
func SignIn(opts SignInOptions) (string, error) {
	base := trimTrailingSlash(opts.BaseURL)
	url := base + "/api/auth/sign-in/email"
	body, err := json.Marshal(map[string]string{
		"email":    opts.Email,
		"password": opts.Password,
	})
	if err != nil {
		return "", newAuthError(0, "sign-in failed: could not encode request (%s)", err)
	}
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return "", newAuthError(0, "sign-in failed: %s", err)
	}
	req.Header.Set("Content-Type", "application/json")
	// Better Auth rejects a request whose Origin is absent/null as a
	// CSRF attempt. Node's fetch omits Origin for same-process calls, so
	// the TS original set it by hand to the server's own base URL; Go's
	// http.Client likewise never sets one. Keep this header.
	req.Header.Set("Origin", base)

	// redirect: "manual" — the sign-in response may carry a redirect, and
	// following it drops the Set-Cookie we came for.
	res, err := doRequestNoRedirect(opts.HTTPClient, req)
	if err != nil {
		return "", newAuthError(0, "sign-in failed: %s", err)
	}
	defer drainAndClose(res)

	if !isOK(res) {
		raw := readBodyBounded(res)
		// Never echo the raw body — Better Auth sometimes echoes the request
		// payload (incl. email) on failure paths, and these messages land in
		// CI stderr (issue #23). Surface only the parsed `error` field, or
		// a length-bounded fallback.
		return "", newAuthError(res.StatusCode,
			"sign-in failed: %s%s", statusText(res), FormatBodyError(raw))
	}
	cookie := ExtractSessionCookie(res)
	if cookie == "" {
		return "", newAuthError(0, "sign-in succeeded but no session cookie was returned")
	}
	return cookie, nil
}

// MintToken mints an `nm_…` bearer with the given label. Returns the
// plaintext token, which is shown once by the server and irrecoverable
// afterwards — the caller owns it from here; this function keeps no copy.
func MintToken(opts MintTokenOptions) (string, error) {
	base := trimTrailingSlash(opts.BaseURL)
	url := base + "/v1/me/tokens"
	label := opts.Label
	if label == "" {
		label = "novamem-init"
	}
	body, err := json.Marshal(map[string]string{"label": label})
	if err != nil {
		return "", newAuthError(0, "token mint failed: could not encode request (%s)", err)
	}
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return "", newAuthError(0, "token mint failed: %s", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Cookie", opts.SessionCookie)
	// Same reason as SignIn: no Origin, no session — Better Auth's CSRF
	// guard rejects it.
	req.Header.Set("Origin", base)

	res, err := doRequest(opts.HTTPClient, req)
	if err != nil {
		return "", newAuthError(0, "token mint failed: %s", err)
	}
	defer drainAndClose(res)

	if !isOK(res) {
		raw := readBodyBounded(res)
		// Same redaction policy as SignIn — never echo the raw body.
		return "", newAuthError(res.StatusCode,
			"token mint failed: %s%s", statusText(res), FormatBodyError(raw))
	}

	var parsed struct {
		Token     string `json:"token"`
		Plaintext string `json:"plaintext"`
	}
	raw := readBodyBounded(res)
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		return "", newAuthError(0, "token mint succeeded but response did not include plaintext")
	}
	plaintext := parsed.Token
	if plaintext == "" {
		plaintext = parsed.Plaintext
	}
	if plaintext == "" {
		return "", newAuthError(0, "token mint succeeded but response did not include plaintext")
	}
	return plaintext, nil
}

// ExtractSessionCookie pulls the Better Auth session cookie out of a
// response's Set-Cookie headers. We forward the raw `name=value` pair
// (not the full directive) so the next request's Cookie header is
// well-formed. Returns "" when no session cookie is present.
//
// Node's fetch needed a naive comma-split fallback here (older 20.x
// lacked headers.getSetCookie(), so multiple Set-Cookie arrived
// concatenated with ", "). Go's net/http keeps each Set-Cookie as its
// own header value, so Header.Values does that job exactly and the
// splitting heuristic is gone.
//
// Exported for testing.
func ExtractSessionCookie(res *http.Response) string {
	if res == nil {
		return ""
	}
	for _, directive := range res.Header.Values("Set-Cookie") {
		pair := strings.TrimSpace(strings.SplitN(directive, ";", 2)[0])
		if pair == "" {
			continue
		}
		eq := strings.Index(pair, "=")
		if eq < 0 {
			continue
		}
		name := strings.TrimSpace(pair[:eq])
		if name == "nm.session_token" ||
			strings.HasSuffix(name, ".session_token") ||
			name == "session_token" {
			return pair
		}
	}
	return ""
}

// FormatBodyError renders the safe error suffix for an HTTP failure body.
//
// Tries to parse JSON and pull the `error` field (Better Auth + our own
// envelope both use this shape); falls back to "" if the body isn't
// JSON or has no error string. Truncated to 80 chars so a verbose
// error message can't dominate CI logs (issue #23).
//
// Exported for testing.
func FormatBodyError(body string) string {
	if body == "" {
		return ""
	}
	var parsed struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal([]byte(body), &parsed); err != nil {
		// Not JSON (or `error` is not a string) — fall through to empty;
		// we never echo raw bodies.
		return ""
	}
	if parsed.Error == "" {
		return ""
	}
	msg := parsed.Error
	if len(msg) > 80 {
		msg = msg[:80]
	}
	return " — " + msg
}

// --- internals -------------------------------------------------------

func isOK(res *http.Response) bool {
	return res.StatusCode >= 200 && res.StatusCode < 300
}

// statusText reproduces the TS `${res.status} ${res.statusText}` — which
// is exactly what Go puts in Response.Status ("401 Unauthorized"). Some
// servers omit the reason phrase; fall back to the bare code so the
// message never ends in a dangling space.
func statusText(res *http.Response) string {
	s := strings.TrimSpace(res.Status)
	if s == "" {
		return fmt.Sprintf("%d", res.StatusCode)
	}
	return s
}

func clientOrDefault(c *http.Client) *http.Client {
	if c != nil {
		return c
	}
	return &http.Client{Timeout: defaultAuthTimeout}
}

func doRequest(c *http.Client, req *http.Request) (*http.Response, error) {
	return clientOrDefault(c).Do(req)
}

// doRequestNoRedirect is `redirect: "manual"`. It copies the caller's
// client rather than mutating it — an injected test client (or a shared
// one) must not come back with its CheckRedirect rewritten.
func doRequestNoRedirect(c *http.Client, req *http.Request) (*http.Response, error) {
	base := clientOrDefault(c)
	manual := *base
	manual.CheckRedirect = func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}
	return manual.Do(req)
}

func readBodyBounded(res *http.Response) string {
	b, err := io.ReadAll(io.LimitReader(res.Body, maxErrorBody))
	if err != nil {
		// Mirrors the TS `.catch(() => "")`: a body we cannot read is
		// simply no extra detail, not a second failure to report.
		return ""
	}
	return string(b)
}

func drainAndClose(res *http.Response) {
	// Errors here are deliberately swallowed: draining is a keep-alive
	// optimisation, and a failure to close a response body must not mask
	// the sign-in result we are actually returning.
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, maxErrorBody))
	_ = res.Body.Close()
}
