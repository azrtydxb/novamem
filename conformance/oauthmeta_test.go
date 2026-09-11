package conformance

// OAuth 2.0 Protected Resource Metadata (RFC 9728) and the
// `WWW-Authenticate` challenge that points at it — the start of MCP's
// authorization discovery flow.
//
// This is a live probe because the failure it guards is a deployment
// failure, not a handler one: the challenge has to survive whatever sits
// in front of the server. An ingress that strips `WWW-Authenticate` on a
// 401, or a proxy that answers /.well-known itself, leaves a conforming
// client with nothing to discover — and the handler unit tests would
// still pass.

import (
	"regexp"
	"strings"
	"testing"
)

// resourceMetadataParam pulls the quoted `resource_metadata` value out of
// a WWW-Authenticate challenge. A substring check would pass on a
// different URL that merely embeds the expected one — in a query string,
// or as a prefix of a longer path — so the value is extracted and
// compared whole.
var resourceMetadataParam = regexp.MustCompile(`resource_metadata="([^"]*)"`)

func TestProtectedResourceMetadata(t *testing.T) {
	e := Target(t)

	t.Run("an unauthenticated request answers 401 with a resource_metadata challenge", func(t *testing.T) {
		// `none` is a real deployment mode and deliberately lets /mcp
		// through, so there is no 401 to carry a challenge. The document
		// below is still served there — discovery is mode-independent.
		SkipUnless(t, "user", "bearer")
		r := API(t, "/mcp", Opts{Method: "POST", Token: NoAuth, Body: map[string]any{}})
		if r.Status != 401 {
			t.Fatalf("status = %d, want 401", r.Status)
		}
		challenge := r.Headers.Get("www-authenticate")
		if challenge == "" {
			t.Fatal("no WWW-Authenticate header — a conforming client has no way in, " +
				"and cannot tell 'present a token' from 'this endpoint is broken'")
		}
		if !strings.HasPrefix(challenge, "Bearer ") {
			t.Errorf("challenge %q does not use the Bearer scheme", challenge)
		}
		if resourceMetadataParam.FindStringSubmatch(challenge) == nil {
			t.Errorf("challenge %q carries no resource_metadata pointer", challenge)
		}
	})

	t.Run("the metadata document is public and well formed", func(t *testing.T) {
		// Discovery must work before the caller holds a credential.
		r := API(t, "/.well-known/oauth-protected-resource", Opts{Token: NoAuth})
		if r.Status != 200 {
			t.Fatalf("status = %d, want 200 — discovery must not itself require a token", r.Status)
		}
		doc := r.Obj(t)
		res, _ := doc["resource"].(string)
		if res == "" {
			t.Fatal("`resource` is the one REQUIRED member of the document")
		}
		if !strings.Contains(res, "://") || strings.HasSuffix(res, "/") || strings.Contains(res, "#") {
			t.Errorf("resource %q is not an RFC 8707 canonical URI", res)
		}
		// Absent on purpose: novamem mints its own bearers and fronts no
		// authorization server, so naming one would send clients into a
		// flow that dead-ends.
		if _, ok := doc["authorization_servers"]; ok {
			t.Error("authorization_servers is present — novamem has none to name")
		}
	})

	t.Run("the challenge points at the document this deployment serves", func(t *testing.T) {
		SkipUnless(t, "user", "bearer")
		challenge := API(t, "/mcp", Opts{Method: "POST", Token: NoAuth, Body: map[string]any{}}).
			Headers.Get("www-authenticate")
		res, _ := API(t, "/.well-known/oauth-protected-resource", Opts{Token: NoAuth}).
			Obj(t)["resource"].(string)

		m := resourceMetadataParam.FindStringSubmatch(challenge)
		if m == nil {
			t.Fatalf("challenge %q carries no resource_metadata pointer", challenge)
		}
		// Whole value, not a substring: a URL that merely embeds the
		// expected one would still send a client somewhere else.
		if want := res + "/.well-known/oauth-protected-resource"; m[1] != want {
			t.Errorf("resource_metadata = %q, want %q", m[1], want)
		}
		// And the identifier is this deployment, not a baked-in default.
		if !strings.Contains(e.URL, strings.TrimPrefix(strings.TrimPrefix(res, "https://"), "http://")) {
			t.Errorf("resource %q does not describe the target %q", res, e.URL)
		}
	})
}
