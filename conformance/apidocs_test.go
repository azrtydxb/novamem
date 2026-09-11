package conformance

// The in-product API reference at /api-docs.
//
// This suite exists because of how the route was lost. The retired
// TypeScript server served Swagger UI here through @fastify/swagger-ui;
// the Go port did not, and nothing noticed — the docs, SECURITY.md and
// the landing page went on advertising it for months while it answered
// the 404 envelope (#264). Unit tests would not have caught it either:
// the handler was simply never registered, and a test for a handler that
// does not exist does not exist. Only a probe against a running
// deployment closes that gap, which is what this file is.
//
// Public on purpose, like /openapi.json: the contract is already public,
// and a reference behind a bearer is a reference nobody reads. So every
// assertion here runs with no Authorization header at all.

import (
	"regexp"
	"strings"
	"testing"
)

// bundleSrc is the renderer URL the page actually asks for. Reading it
// out of the page rather than hardcoding it is the point: it proves the
// page and the route agree, on a deployment whose renderer version this
// suite does not know.
var bundleSrc = regexp.MustCompile(`src="(api-docs/[^"]+/standalone\.js)"`)

func TestAPIReference(t *testing.T) {
	_ = Target(t)

	t.Run("the page is served anonymously as HTML", func(t *testing.T) {
		r := API(t, "/api-docs", Opts{Token: NoAuth})
		if r.Status != 200 {
			t.Fatalf("GET /api-docs: status = %d, want 200 (it 404'd for months — see #264)", r.Status)
		}
		if ct := r.Headers.Get("content-type"); !strings.HasPrefix(ct, "text/html") {
			t.Fatalf("content-type = %q, want text/html", ct)
		}
	})

	t.Run("the page reads THIS deployment's spec, not a published copy", func(t *testing.T) {
		body := API(t, "/api-docs", Opts{Token: NoAuth}).Str()
		// Relative, so the page still resolves its spec when novamem is
		// mounted on a sub-path behind an ingress.
		if !strings.Contains(body, `data-url="openapi.json"`) {
			t.Fatalf("the page does not point at this server's own openapi.json:\n%s", body)
		}
	})

	t.Run("the renderer is served from the binary, not a CDN", func(t *testing.T) {
		// novamem is deployed air-gapped; a reference page that renders
		// blank without egress is worse than none.
		page := API(t, "/api-docs", Opts{Token: NoAuth}).Str()
		m := bundleSrc.FindStringSubmatch(page)
		if m == nil {
			t.Fatalf("the page asks for no renderer bundle:\n%s", page)
		}
		r := API(t, "/"+m[1], Opts{Token: NoAuth})
		if r.Status != 200 {
			t.Fatalf("GET /%s (the URL the page asks for): status = %d, want 200", m[1], r.Status)
		}
		// Go's transport requests and transparently decodes gzip, so what
		// lands here is the decompressed bundle.
		if n := len(r.Str()); n < 1_000_000 {
			t.Fatalf("bundle is %d bytes — too small to be the renderer; "+
				"re-run go/scripts/sync-api-reference.sh and rebuild", n)
		}
	})

	t.Run("the spec it points at is the one this server serves", func(t *testing.T) {
		r := API(t, "/openapi.json", Opts{Token: NoAuth})
		if r.Status != 200 {
			t.Fatalf("GET /openapi.json: status = %d, want 200", r.Status)
		}
		if _, ok := r.Obj(t)["paths"]; !ok {
			t.Fatal("/openapi.json has no paths — the reference would render empty")
		}
	})
}

// The bundle URL carries its version and is served `immutable`, which is
// only safe while a version it does not have is a 404 rather than the
// current renderer wearing the old version's URL.
func TestAPIReferenceBundleVersionIsNotInterchangeable(t *testing.T) {
	_ = Target(t)
	r := API(t, "/api-docs/0.0.1-not-a-real-version/standalone.js", Opts{Token: NoAuth})
	if r.Status != 404 {
		t.Fatalf("status = %d, want 404 — an immutable URL must not serve a different bundle", r.Status)
	}
}
