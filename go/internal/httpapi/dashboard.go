// The admin dashboard (the React/Vite SPA in packages/admin-ui), served
// from the binary. http.ts mounts the same build under /admin/* through
// @fastify/static; here the build is a `go:embed` of the checked-in
// mirror under internal/httpapi/admin-ui (written by
// go/scripts/sync-admin-ui.sh — go:embed cannot reach across packages).
//
// Contract transcribed from http.ts (admin dashboard block + auth hook):
//   - GET /admin and /admin/ serve index.html; /admin/<file> serves the
//     file and 404s when it doesn't exist.
//   - Every /admin/* response carries the strict per-route CSP.
//   - Only /admin, /admin/, /admin/index.html and /admin/assets/* are
//     public; every other /admin/* path goes through the normal auth
//     path, so an unauthenticated GET /admin/favicon.svg is a 401
//     (verified against the TS server, which does the same).
//   - NOVAMEM_ADMIN_DASHBOARD=0 registers no routes at all, so /admin
//     falls through to the catch-all 404 envelope.
package httpapi

import (
	"embed"
	"io"
	"io/fs"
	"net/http"
	"strings"
)

//go:embed all:admin-ui
var adminUIFS embed.FS

// dashboardCSP is http.ts's setHeaders policy, byte-for-byte.
const dashboardCSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
	"font-src 'self' data:; script-src 'self'; connect-src 'self'; frame-ancestors 'none'"

// adminPublicURLs — http.ts's ADMIN_PUBLIC_URLS.
var adminPublicURLs = map[string]bool{"/admin": true, "/admin/": true, "/admin/index.html": true}

func (s *server) registerDashboard(mux *routeMux) {
	// The prefix is claimed even with the dashboard switched off. In the
	// TS server auth is a global `onRequest` hook, which Fastify also runs
	// for its 404 handler, so a non-public /admin path is answered 401 by
	// the hook before routing ever reports it missing — in both modes.
	// Go routes first and authenticates inside the handler, so the handler
	// has to exist for that ordering to survive.
	var root fs.FS
	if s.adminDashboard {
		sub, err := fs.Sub(adminUIFS, "admin-ui")
		if err != nil {
			s.log.Warn("admin dashboard assets unavailable", "err", err)
		} else {
			root = sub
		}
	}

	handler := func(w http.ResponseWriter, r *http.Request) {
		public := adminPublicURLs[r.URL.Path] || strings.HasPrefix(r.URL.Path, "/admin/assets/")
		if !public {
			// Same auth gate every other non-/v1 route gets.
			if _, ok := s.resolveCaller(w, r); !ok {
				return
			}
		}
		if root == nil {
			// Dashboard off: past the auth gate, nothing is mounted.
			sendNotFound(w, r)
			return
		}
		name := "index.html"
		if !adminPublicURLs[r.URL.Path] {
			name = strings.TrimPrefix(strings.TrimPrefix(r.URL.Path, "/admin"), "/")
		}
		f, err := root.Open(name)
		if err != nil {
			sendNotFound(w, r)
			return
		}
		defer func() { _ = f.Close() }()
		info, err := f.Stat()
		if err != nil || info.IsDir() {
			sendNotFound(w, r)
			return
		}
		w.Header().Set("Content-Security-Policy", dashboardCSP)
		setHardeningHeaders(w)
		// ServeContent picks the content type off the extension and
		// handles Range / If-Modified-Since. Embedded files have a zero
		// modtime, which it correctly omits rather than emitting epoch.
		http.ServeContent(w, r, info.Name(), info.ModTime(), f.(io.ReadSeeker))
	}

	mux.HandleFunc("GET /admin", handler)
	mux.HandleFunc("GET /admin/", handler)
}
