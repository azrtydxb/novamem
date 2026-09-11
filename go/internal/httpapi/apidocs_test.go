package httpapi

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The route the docs advertised for months while it 404'd (#264). Public,
// like /openapi.json — an anonymous request must get the page, not a 401.
func TestAPIReferenceIsServedAnonymously(t *testing.T) {
	h := newTestServer(t, "user", "")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/api-docs", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api-docs = %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Errorf("Content-Type = %q, want text/html", ct)
	}
	body := rec.Body.String()
	// The page is worthless if it does not point at this deployment's own
	// spec: that is the whole reason it exists next to the published site.
	if !strings.Contains(body, `data-url="openapi.json"`) {
		t.Error("the page does not point at this deployment's openapi.json")
	}
	if !strings.Contains(body, `src="api-docs/standalone.js"`) {
		t.Error("the page does not load the vendored bundle")
	}
}

// Vendored, not CDN: novamem runs air-gapped, and a reference page that
// renders blank without internet is worse than none. If this ever starts
// serving a few hundred bytes, the bundle went missing from the binary.
func TestAPIReferenceBundleIsEmbeddedAndDecompresses(t *testing.T) {
	h := newTestServer(t, "user", "")
	req := httptest.NewRequest("GET", "/api-docs/standalone.js", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api-docs/standalone.js = %d, want 200", rec.Code)
	}
	if enc := rec.Header().Get("Content-Encoding"); enc != "gzip" {
		t.Fatalf("Content-Encoding = %q, want gzip", enc)
	}
	if v := rec.Header().Get("Vary"); !strings.Contains(v, "Accept-Encoding") {
		t.Errorf("Vary = %q, want it to name Accept-Encoding", v)
	}

	zr, err := gzip.NewReader(bytes.NewReader(rec.Body.Bytes()))
	if err != nil {
		t.Fatalf("body is not gzip: %v", err)
	}
	raw, err := io.ReadAll(zr)
	if err != nil {
		t.Fatalf("decompressing: %v", err)
	}
	if len(raw) < 1_000_000 {
		t.Errorf("bundle decompresses to %d bytes — too small to be the renderer; "+
			"re-run go/scripts/sync-api-reference.sh", len(raw))
	}
}

// Scalar injects its stylesheet at runtime, so style-src carries
// 'unsafe-inline'. Scripts must NOT: the page's configuration rides on a
// data attribute precisely so script-src can stay 'self'.
func TestAPIReferenceCSPAllowsInlineStylesButNotInlineScripts(t *testing.T) {
	h := newTestServer(t, "user", "")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/api-docs", nil))

	csp := rec.Header().Get("Content-Security-Policy")
	if csp == "" {
		t.Fatal("no Content-Security-Policy on the reference page")
	}
	if !strings.Contains(csp, "style-src 'self' 'unsafe-inline'") {
		t.Errorf("CSP %q blocks the renderer's injected stylesheet", csp)
	}
	if !strings.Contains(csp, "script-src 'self'") || strings.Contains(csp, "script-src 'self' 'unsafe-inline'") {
		t.Errorf("CSP %q must keep script-src at 'self'", csp)
	}
}
