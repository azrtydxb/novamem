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
	"strings"
	"testing"
)

func TestProtectedResourceMetadata(t *testing.T) {
	e := Target(t)

	t.Run("an unauthenticated request answers 401 with a resource_metadata challenge", func(t *testing.T) {
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
		if !strings.Contains(challenge, `resource_metadata="`) {
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
		challenge := API(t, "/mcp", Opts{Method: "POST", Token: NoAuth, Body: map[string]any{}}).
			Headers.Get("www-authenticate")
		res, _ := API(t, "/.well-known/oauth-protected-resource", Opts{Token: NoAuth}).
			Obj(t)["resource"].(string)

		want := res + "/.well-known/oauth-protected-resource"
		if !strings.Contains(challenge, want) {
			t.Errorf("challenge %q does not carry %q", challenge, want)
		}
		// And the identifier is this deployment, not a baked-in default.
		if !strings.Contains(e.URL, strings.TrimPrefix(strings.TrimPrefix(res, "https://"), "http://")) {
			t.Errorf("resource %q does not describe the target %q", res, e.URL)
		}
	})
}
