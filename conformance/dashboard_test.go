package conformance

// Port of suites/42-dashboard.test.ts.
//
// Admin dashboard (static SPA) surface. Transcription source:
// `packages/server/src/http.ts` — the `ADMIN_PUBLIC_URLS` auth-hook
// bypass (`/admin`, `/admin/`, `/admin/index.html`, `/admin/assets/*`)
// and the `fastifyStatic` mount with its per-route CSP. Read-only.
//
// The parity audit (§9.2) called this out as an untested surface: the Go
// server 404'd `/admin` under a fully green conformance run.
//
// MODE GATING. One server run can only be in one mode, so this suite
// asserts the enabled contract OR the disabled contract, never both.
// `NOVAMEM_ADMIN_DASHBOARD` (same spelling as the server's own env var)
// selects it. When unset the suite probes `/admin` once and infers the
// mode, so a run that forgets the flag still asserts something real
// rather than going red on configuration.
//
// The one assertion that holds in BOTH modes is the important one: a
// non-allowlisted path under `/admin` is 401, never 404. The auth hook
// runs before routing, so probing for `/admin/<anything>` must not leak
// which paths exist — that 401-not-404 ordering is the contract, and it
// survives the dashboard being switched off entirely.

import (
	"regexp"
	"strings"
	"testing"
)

var dashboardCSP = strings.Join([]string{
	"default-src 'self'",
	"img-src 'self' data:",
	"style-src 'self' 'unsafe-inline'",
	"font-src 'self' data:",
	"script-src 'self'",
	"connect-src 'self'",
	"frame-ancestors 'none'",
}, "; ")

var dashboardEntryPoints = []string{"/admin", "/admin/", "/admin/index.html"}

func TestAdminDashboard(t *testing.T) {
	e := Target(t)

	// beforeAll: resolve the mode from NOVAMEM_ADMIN_DASHBOARD, or probe
	// /admin once and infer it.
	enabled := false
	if e.AdminDashboard != "" {
		enabled = regexp.MustCompile(`^(?i)(1|true|yes|on)$`).MatchString(e.AdminDashboard)
	} else {
		probe := API(t, "/admin", Opts{Token: NoAuth})
		enabled = probe.Status == 200
	}

	// Mode-independent: holds whether or not the SPA is mounted.
	t.Run("a non-allowlisted path under /admin is 401, not 404", func(t *testing.T) {
		r := API(t, "/admin/not-an-allowlisted-path", Opts{Token: NoAuth})
		if r.Status != 401 {
			t.Fatalf("status = %d, want 401", r.Status)
		}
		if got := r.MustValidate(t, ErrorBody)["error"]; got != "unauthorized" {
			t.Fatalf("error = %v, want %q", got, "unauthorized")
		}
	})

	t.Run("serves the SPA entry points when enabled, 404s them when disabled", func(t *testing.T) {
		for _, path := range dashboardEntryPoints {
			r := API(t, path, Opts{Token: NoAuth})
			if !enabled {
				if r.Status != 404 {
					t.Fatalf("%s with the dashboard disabled: status = %d, want 404", path, r.Status)
				}
				continue
			}
			if r.Status != 200 {
				t.Fatalf("%s with the dashboard enabled: status = %d, want 200", path, r.Status)
			}
			if ct := r.Headers.Get("content-type"); !regexp.MustCompile(`^text/html`).MatchString(ct) {
				t.Fatalf("%s content-type = %q, want text/html", path, ct)
			}
			if csp := r.Headers.Get("content-security-policy"); csp != dashboardCSP {
				t.Fatalf("%s content-security-policy = %q, want %q", path, csp, dashboardCSP)
			}
			if v := r.Headers.Get("x-frame-options"); v != "DENY" {
				t.Fatalf("%s x-frame-options = %q, want DENY", path, v)
			}
			if v := r.Headers.Get("x-content-type-options"); v != "nosniff" {
				t.Fatalf("%s x-content-type-options = %q, want nosniff", path, v)
			}
			body, ok := r.Body.(string)
			if !ok {
				t.Fatalf("%s body is %T, want string", path, r.Body)
			}
			if !regexp.MustCompile(`(?i)<html|<!doctype`).MatchString(body) {
				t.Fatalf("%s body does not look like an HTML document", path)
			}
		}
	})

	t.Run("serves hashed bundles under /admin/assets/ when enabled, 404s them when disabled", func(t *testing.T) {
		// Discover a real asset from the SPA shell rather than pinning a
		// hashed filename that changes on every UI build.
		shell := API(t, "/admin/index.html", Opts{Token: NoAuth})
		if !enabled {
			if shell.Status != 404 {
				t.Fatalf("shell status = %d, want 404", shell.Status)
			}
			missing := API(t, "/admin/assets/index.js", Opts{Token: NoAuth})
			if missing.Status != 404 {
				t.Fatalf("missing asset status = %d, want 404", missing.Status)
			}
			return
		}
		asset := regexp.MustCompile(`/admin/assets/[A-Za-z0-9._-]+`).FindString(shell.Str())
		if asset == "" {
			t.Fatal("index.html should reference at least one /admin/assets/ bundle")
		}
		r := API(t, asset, Opts{Token: NoAuth})
		if r.Status != 200 {
			t.Fatalf("status = %d, want 200", r.Status)
		}
		if csp := r.Headers.Get("content-security-policy"); csp != dashboardCSP {
			t.Fatalf("content-security-policy = %q, want %q", csp, dashboardCSP)
		}
		if v := r.Headers.Get("x-content-type-options"); v != "nosniff" {
			t.Fatalf("x-content-type-options = %q, want nosniff", v)
		}
		// Assets load before login — no credentials were sent above.
		if v := r.Headers.Get("referrer-policy"); v != "no-referrer" {
			t.Fatalf("referrer-policy = %q, want no-referrer", v)
		}
	})

	t.Run("a missing file under /admin/assets/ is 404 (allowlisted prefix, absent file)", func(t *testing.T) {
		r := API(t, "/admin/assets/definitely-not-a-real-bundle-xyz.js", Opts{Token: NoAuth})
		if r.Status != 404 {
			t.Fatalf("status = %d, want 404", r.Status)
		}
	})
}
