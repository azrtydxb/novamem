// OAuth 2.0 Protected Resource Metadata (RFC 9728) and the
// `WWW-Authenticate` challenge that points at it.
//
// MCP's authorization framework is OPTIONAL, but an implementation that
// does authorize over an HTTP transport SHOULD conform to it — and
// inside it: "MCP servers MUST implement OAuth 2.0 Protected Resource
// Metadata (RFC9728). MCP clients MUST use OAuth 2.0 Protected Resource
// Metadata for authorization server discovery."
//
// novamem authorizes over HTTP, so that applies to us. Before this, an
// unauthenticated MCP request got a bare 401 with no `WWW-Authenticate`
// header at all, and `/.well-known/oauth-protected-resource` was a 404:
// a spec-conforming client had nothing to discover its way in with, and
// no way to tell "you need a token" from "this endpoint is broken".
//
// What this does NOT claim: novamem is not an OAuth 2.1 authorization
// server. It issues its own `nm_…` bearers from the dashboard and Better
// Auth session credentials, and validates them directly. The metadata
// document describes the resource honestly — what it is, which token
// types it takes, and where a human goes to get one — rather than
// advertising an authorization server that does not exist. A client that
// insists on a full OAuth flow will discover that there is none to run,
// which is the truth and is discoverable, instead of a silent 401.
package httpapi

import (
	"encoding/json"
	"net/http"
	"strings"
)

// protectedResourceMetadataPath is fixed by RFC 9728 §3 for a resource
// identifier with no path component, which is what novamem's base URL
// is.
const protectedResourceMetadataPath = "/.well-known/oauth-protected-resource"

func (s *server) registerOAuthMetadata(mux *routeMux) {
	mux.HandleFunc("GET "+protectedResourceMetadataPath, func(w http.ResponseWriter, r *http.Request) {
		setHardeningHeaders(w)
		// Discovery has to work before the client holds a credential —
		// that is the whole point of it — so this is public, like
		// /openapi.json and /api-docs.
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "public, max-age=3600")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(s.protectedResourceMetadata(r))
	})
}

// protectedResourceMetadata is the RFC 9728 document. `resource` is the
// only required member; the rest is what an agent or an operator needs
// to actually get in.
func (s *server) protectedResourceMetadata(r *http.Request) map[string]any {
	res := s.resourceIdentifier(r)
	return map[string]any{
		"resource": res,
		// RFC 9728 §2: how tokens may be presented. novamem reads the
		// Authorization header only — never a query parameter, which the
		// MCP spec also forbids outright.
		"bearer_methods_supported": []string{"header"},
		"resource_name":            "novamem",
		"resource_documentation":   "https://azrtydxb.github.io/novamem/docs/api/",
		// Deliberately absent: `authorization_servers`. novamem is not
		// fronted by an OAuth 2.1 authorization server, and naming one
		// that cannot issue tokens for this resource would send clients
		// into a flow that dead-ends. Tokens come from the dashboard's
		// API Tokens page; `resource_documentation` says so.
	}
}

// resourceIdentifier is the canonical URI of this MCP server, per RFC
// 8707 §2: scheme and authority, no fragment, no trailing slash. The
// configured base URL wins; the request's own Host is the fallback for a
// deployment that never set one.
func (s *server) resourceIdentifier(r *http.Request) string {
	if b := strings.TrimRight(s.baseURL(), "/"); b != "" {
		return b
	}
	scheme := "http"
	if r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
		scheme = "https"
	}
	return scheme + "://" + r.Host
}

// challengeHeader is the RFC 6750 §3 `WWW-Authenticate` value carrying
// the `resource_metadata` pointer the MCP spec's discovery flow starts
// from. No `scope`: novamem's tokens are not scoped, so claiming a scope
// a client could request would be a lie it might act on.
func (s *server) challengeHeader(r *http.Request) string {
	return `Bearer resource_metadata="` + s.resourceIdentifier(r) + protectedResourceMetadataPath + `"`
}
