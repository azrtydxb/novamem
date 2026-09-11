// The in-product API reference: a rendered, browsable view of the same
// OpenAPI document /openapi.json serves, at /api-docs on every
// deployment.
//
// Why it exists twice. The published site at azrtydxb.github.io/novamem
// documents whatever shipped last; a deployment documents ITSELF — its
// routes, its auth mode, its base URL — and an agent or an operator
// pointed at a server can read the contract without knowing which
// release it runs. The previous TypeScript server served Swagger UI
// here through @fastify/swagger-ui; the Go port dropped it and the docs
// went on advertising the route for months (#264). This is that route,
// made real.
//
// The renderer is vendored, not pulled from a CDN. novamem is deployed
// air-gapped and behind strict egress policies, and a reference page
// that renders blank without internet is worse than none. The bundle is
// stored gzipped (1.0 MB rather than 3.7 MB in the repo and the binary)
// and served with Content-Encoding: gzip, which every browser that can
// run it accepts. scripts/sync-api-reference.sh refreshes it.
//
// Public, like /openapi.json: the contract is already public, and a
// reference nobody can reach is a reference nobody reads. It carries no
// data — every request the "Test Request" button makes is the browser's
// own, with credentials the reader supplies.
package httpapi

import (
	_ "embed"
	"net/http"
	"strings"
)

//go:embed apidocs/standalone.js.gz
var apiReferenceJS []byte

//go:embed apidocs/VERSION
var apiReferenceVersion string

// apiDocsCSP is the dashboard policy with one addition: Scalar injects
// its stylesheet at runtime, so style-src needs 'unsafe-inline'. Scripts
// stay 'self' — the configuration below rides on a data attribute rather
// than an inline <script>, so nothing here needs script 'unsafe-inline'.
const apiDocsCSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
	"font-src 'self' data:; script-src 'self'; connect-src 'self'; frame-ancestors 'none'"

// apiDocsPage renders the reference against this deployment's own spec.
// `data-url` is relative on purpose: behind an ingress that mounts
// novamem on a sub-path, an absolute /openapi.json would miss.
const apiDocsPage = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>novamem API reference</title>
    <link rel="icon" href="/favicon.ico" />
  </head>
  <body>
    <div id="app"></div>
    <script
      id="api-reference"
      data-url="openapi.json"
      data-configuration='{"theme":"deepSpace","darkMode":true,"hideDownloadButton":false}'
      src="api-docs/standalone.js"
    ></script>
  </body>
</html>
`

func (s *server) registerAPIDocs(mux *routeMux) {
	mux.HandleFunc("GET /api-docs", func(w http.ResponseWriter, _ *http.Request) {
		setHardeningHeaders(w)
		w.Header().Set("Content-Security-Policy", apiDocsCSP)
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(apiDocsPage))
	})

	mux.HandleFunc("GET /api-docs/standalone.js", func(w http.ResponseWriter, r *http.Request) {
		setHardeningHeaders(w)
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		// Pinned bundle, so it can be cached hard; the version is in the
		// ETag rather than the URL to keep the page's src stable.
		w.Header().Set("ETag", `"scalar-`+strings.TrimSpace(apiReferenceVersion)+`"`)
		w.Header().Set("Cache-Control", "public, max-age=604800, immutable")
		// A client that cannot take gzip cannot run a 3.7 MB ES2022
		// bundle either, but say so rather than handing it bytes it did
		// not ask for.
		if !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			http.Error(w, "the API reference bundle is served gzip-encoded", http.StatusNotAcceptable)
			return
		}
		w.Header().Set("Content-Encoding", "gzip")
		w.Header().Set("Vary", "Accept-Encoding")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(apiReferenceJS)
	})
}
