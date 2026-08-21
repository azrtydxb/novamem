package initcli

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// authServer is a stand-in for a novamem server speaking Better Auth.
// Every test here runs against httptest — this package must never touch
// the real network.
type authServer struct {
	// signInStatus / signInBody override the sign-in response when set.
	signInStatus int
	signInBody   string
	// omitCookie makes a 200 sign-in that forgets the Set-Cookie.
	omitCookie bool
	// mintStatus / mintBody override the mint response when set.
	mintStatus int
	mintBody   string

	// recorded requests, for assertions.
	signInOrigin string
	signInBodyIn string
	mintOrigin   string
	mintCookie   string
	mintBodyIn   string
}

const goodPassword = "hunter2"

func (a *authServer) start(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	mux.HandleFunc("/api/auth/sign-in/email", func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		a.signInOrigin = r.Header.Get("Origin")
		a.signInBodyIn = string(raw)

		if a.signInStatus != 0 {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(a.signInStatus)
			_, _ = io.WriteString(w, a.signInBody)
			return
		}
		var in struct{ Email, Password string }
		_ = json.Unmarshal(raw, &in)
		if in.Password != goodPassword {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			// Better Auth echoes the submitted payload on failures — the
			// port must not surface any of it beyond the `error` field.
			_, _ = io.WriteString(w, `{"error":"Invalid email or password","email":"`+in.Email+`"}`)
			return
		}
		if !a.omitCookie {
			// A realistic Better Auth pair: the CSRF cookie first, then
			// the session token, both with full directives.
			w.Header().Add("Set-Cookie", "nm.csrf_token=abc123; Path=/; HttpOnly; SameSite=Lax")
			w.Header().Add("Set-Cookie", "nm.session_token=sess-xyz; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"user":{"id":"u1"}}`)
	})
	mux.HandleFunc("/v1/me/tokens", func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		a.mintOrigin = r.Header.Get("Origin")
		a.mintCookie = r.Header.Get("Cookie")
		a.mintBodyIn = string(raw)

		w.Header().Set("Content-Type", "application/json")
		if a.mintStatus != 0 {
			w.WriteHeader(a.mintStatus)
			_, _ = io.WriteString(w, a.mintBody)
			return
		}
		_, _ = io.WriteString(w, `{"token":"nm_livetoken123","id":"t1"}`)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func TestSignInAndMint_HappyPath(t *testing.T) {
	a := &authServer{}
	srv := a.start(t)

	if err := ProbeHealth(srv.URL, srv.Client()); err != nil {
		t.Fatalf("ProbeHealth: %v", err)
	}

	cookie, err := SignIn(SignInOptions{
		BaseURL:    srv.URL + "/", // trailing slash must be trimmed
		Email:      "dev@example.com",
		Password:   goodPassword,
		HTTPClient: srv.Client(),
	})
	if err != nil {
		t.Fatalf("SignIn: %v", err)
	}
	// Only the name=value pair, never the directives.
	if cookie != "nm.session_token=sess-xyz" {
		t.Fatalf("cookie = %q", cookie)
	}
	if a.signInOrigin != srv.URL {
		t.Errorf("sign-in Origin = %q, want %q (Better Auth rejects a null Origin)", a.signInOrigin, srv.URL)
	}
	if a.signInBodyIn != `{"email":"dev@example.com","password":"hunter2"}` {
		t.Errorf("sign-in body = %q", a.signInBodyIn)
	}

	tok, err := MintToken(MintTokenOptions{
		BaseURL:       srv.URL,
		SessionCookie: cookie,
		HTTPClient:    srv.Client(),
	})
	if err != nil {
		t.Fatalf("MintToken: %v", err)
	}
	if tok != "nm_livetoken123" {
		t.Fatalf("token = %q", tok)
	}
	if a.mintCookie != cookie {
		t.Errorf("mint Cookie = %q, want %q", a.mintCookie, cookie)
	}
	if a.mintOrigin != srv.URL {
		t.Errorf("mint Origin = %q, want %q", a.mintOrigin, srv.URL)
	}
	if a.mintBodyIn != `{"label":"novamem-init"}` {
		t.Errorf("mint body = %q (default label)", a.mintBodyIn)
	}
}

func TestMintToken_PlaintextFallbackAndLabel(t *testing.T) {
	a := &authServer{mintStatus: http.StatusOK, mintBody: `{"plaintext":"nm_fallback"}`}
	srv := a.start(t)

	tok, err := MintToken(MintTokenOptions{
		BaseURL:       srv.URL,
		SessionCookie: "nm.session_token=sess-xyz",
		Label:         "my-laptop",
		HTTPClient:    srv.Client(),
	})
	if err != nil {
		t.Fatalf("MintToken: %v", err)
	}
	if tok != "nm_fallback" {
		t.Fatalf("token = %q, want the `plaintext` fallback field", tok)
	}
	if a.mintBodyIn != `{"label":"my-laptop"}` {
		t.Errorf("mint body = %q", a.mintBodyIn)
	}
}

func TestSignIn_WrongPasswordSurfacesServerError(t *testing.T) {
	a := &authServer{}
	srv := a.start(t)

	_, err := SignIn(SignInOptions{
		BaseURL:    srv.URL,
		Email:      "dev@example.com",
		Password:   "nope",
		HTTPClient: srv.Client(),
	})
	if err == nil {
		t.Fatal("expected an error for a wrong password")
	}
	ae, ok := err.(*AuthError)
	if !ok {
		t.Fatalf("err type = %T, want *AuthError", err)
	}
	if ae.Status != http.StatusUnauthorized {
		t.Errorf("Status = %d, want 401", ae.Status)
	}
	want := "sign-in failed: 401 Unauthorized — Invalid email or password"
	if ae.Error() != want {
		t.Errorf("message = %q, want %q", ae.Error(), want)
	}
	// issue #23: the echoed request payload must never reach the message.
	if strings.Contains(ae.Error(), "dev@example.com") {
		t.Errorf("message leaked the submitted email: %q", ae.Error())
	}
}

func TestSignIn_NoSetCookie(t *testing.T) {
	a := &authServer{omitCookie: true}
	srv := a.start(t)

	_, err := SignIn(SignInOptions{
		BaseURL:    srv.URL,
		Email:      "dev@example.com",
		Password:   goodPassword,
		HTTPClient: srv.Client(),
	})
	if err == nil {
		t.Fatal("expected an error when the server returns no Set-Cookie")
	}
	ae, ok := err.(*AuthError)
	if !ok {
		t.Fatalf("err type = %T, want *AuthError", err)
	}
	if ae.Status != 0 {
		t.Errorf("Status = %d, want 0 (a malformed success, not an HTTP failure)", ae.Status)
	}
	if ae.Error() != "sign-in succeeded but no session cookie was returned" {
		t.Errorf("message = %q", ae.Error())
	}
}

func TestSignIn_CookieWithoutSessionTokenIsIgnored(t *testing.T) {
	// A response that sets cookies, but none of them a session token.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Add("Set-Cookie", "nm.csrf_token=abc; Path=/")
		w.Header().Add("Set-Cookie", "malformed-no-equals; Path=/")
		_, _ = io.WriteString(w, `{}`)
	}))
	defer srv.Close()

	_, err := SignIn(SignInOptions{
		BaseURL:    srv.URL,
		Email:      "dev@example.com",
		Password:   goodPassword,
		HTTPClient: srv.Client(),
	})
	if err == nil || !strings.Contains(err.Error(), "no session cookie") {
		t.Fatalf("err = %v, want the no-session-cookie error", err)
	}
}

func TestMintToken_NonSuccess(t *testing.T) {
	a := &authServer{
		mintStatus: http.StatusForbidden,
		mintBody:   `{"error":"session expired"}`,
	}
	srv := a.start(t)

	_, err := MintToken(MintTokenOptions{
		BaseURL:       srv.URL,
		SessionCookie: "nm.session_token=stale",
		HTTPClient:    srv.Client(),
	})
	if err == nil {
		t.Fatal("expected an error for a non-2xx mint")
	}
	ae, ok := err.(*AuthError)
	if !ok {
		t.Fatalf("err type = %T, want *AuthError", err)
	}
	if ae.Status != http.StatusForbidden {
		t.Errorf("Status = %d, want 403", ae.Status)
	}
	want := "token mint failed: 403 Forbidden — session expired"
	if ae.Error() != want {
		t.Errorf("message = %q, want %q", ae.Error(), want)
	}
}

func TestMintToken_SuccessWithoutPlaintext(t *testing.T) {
	a := &authServer{mintStatus: http.StatusOK, mintBody: `{"id":"t1"}`}
	srv := a.start(t)

	_, err := MintToken(MintTokenOptions{
		BaseURL:       srv.URL,
		SessionCookie: "nm.session_token=sess",
		HTTPClient:    srv.Client(),
	})
	if err == nil {
		t.Fatal("expected an error when the mint response carries no token")
	}
	if err.Error() != "token mint succeeded but response did not include plaintext" {
		t.Errorf("message = %q", err.Error())
	}
	if ae := err.(*AuthError); ae.Status != 0 {
		t.Errorf("Status = %d, want 0", ae.Status)
	}
}

func TestProbeHealth_NonSuccessAndUnreachable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	err := ProbeHealth(srv.URL, srv.Client())
	if err == nil {
		t.Fatal("expected an error for a 503 /health")
	}
	if err.Error() != "health check failed: 503 Service Unavailable" {
		t.Errorf("message = %q", err.Error())
	}
	if ae := err.(*AuthError); ae.Status != http.StatusServiceUnavailable {
		t.Errorf("Status = %d, want 503", ae.Status)
	}

	// Closing the server gives us a guaranteed-dead local address —
	// still no real network involved.
	url := srv.URL
	client := srv.Client()
	srv.Close()
	err = ProbeHealth(url, client)
	if err == nil {
		t.Fatal("expected an error for an unreachable server")
	}
	if !strings.HasPrefix(err.Error(), "cannot reach "+url+"/health — is the server running? (") {
		t.Errorf("message = %q", err.Error())
	}
	if ae := err.(*AuthError); ae.Status != 0 {
		t.Errorf("Status = %d, want 0 for a transport failure", ae.Status)
	}
}

func TestSignIn_DoesNotFollowRedirects(t *testing.T) {
	// redirect: "manual" — the TS original set it because following a
	// redirect drops the Set-Cookie the 302 itself carried, and because a
	// redirect off the sign-in endpoint is never a success we want to
	// swallow. A 302 therefore surfaces as an error (res.ok is false for
	// 3xx), and the redirect target is never fetched.
	mux := http.NewServeMux()
	mux.HandleFunc("/api/auth/sign-in/email", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Location", "/dashboard")
		w.WriteHeader(http.StatusFound)
	})
	mux.HandleFunc("/dashboard", func(w http.ResponseWriter, r *http.Request) {
		t.Error("redirect was followed; sign-in must use manual redirect handling")
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := srv.Client()
	_, err := SignIn(SignInOptions{
		BaseURL:    srv.URL,
		Email:      "dev@example.com",
		Password:   goodPassword,
		HTTPClient: client,
	})
	if err == nil {
		t.Fatal("expected an error for a 302 sign-in response")
	}
	if err.Error() != "sign-in failed: 302 Found" {
		t.Errorf("message = %q", err.Error())
	}
	if ae := err.(*AuthError); ae.Status != http.StatusFound {
		t.Errorf("Status = %d, want 302", ae.Status)
	}
	// The injected client must come back unmodified.
	if client.CheckRedirect != nil {
		t.Error("SignIn mutated the caller's http.Client.CheckRedirect")
	}
}

func TestFormatBodyError(t *testing.T) {
	long := strings.Repeat("x", 200)
	cases := []struct {
		name, body, want string
	}{
		{"empty", "", ""},
		{"not json", "<html>boom</html>", ""},
		{"json without error", `{"ok":true}`, ""},
		{"error not a string", `{"error":{"code":1}}`, ""},
		{"error empty string", `{"error":""}`, ""},
		{"error string", `{"error":"nope"}`, " — nope"},
		{"truncated at 80", `{"error":"` + long + `"}`, " — " + strings.Repeat("x", 80)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := FormatBodyError(tc.body); got != tc.want {
				t.Errorf("FormatBodyError(%q) = %q, want %q", tc.body, got, tc.want)
			}
		})
	}
}

func TestExtractSessionCookie_NameVariants(t *testing.T) {
	cases := []struct {
		name    string
		cookies []string
		want    string
	}{
		{"prefixed", []string{"nm.session_token=a; Path=/"}, "nm.session_token=a"},
		{"any suffix", []string{"__Secure-better-auth.session_token=b; Secure"}, "__Secure-better-auth.session_token=b"},
		{"bare", []string{"session_token=c"}, "session_token=c"},
		{"first match wins", []string{"other=1", "session_token=c", "nm.session_token=d"}, "session_token=c"},
		{"none", []string{"other=1; Path=/"}, ""},
		{"empty header", nil, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res := &http.Response{Header: http.Header{}}
			for _, c := range tc.cookies {
				res.Header.Add("Set-Cookie", c)
			}
			if got := ExtractSessionCookie(res); got != tc.want {
				t.Errorf("ExtractSessionCookie = %q, want %q", got, tc.want)
			}
		})
	}
	if got := ExtractSessionCookie(nil); got != "" {
		t.Errorf("ExtractSessionCookie(nil) = %q", got)
	}
}
