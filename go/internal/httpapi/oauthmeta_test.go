package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The MCP authorization flow begins with an unauthenticated request
// answering 401 and a `WWW-Authenticate` header naming where the
// resource metadata lives. Before this, the 401 carried no challenge at
// all, so a conforming client could not distinguish "present a token"
// from "this endpoint is broken", and had nowhere to look for how to get
// one.
func TestUnauthorizedCarriesTheResourceMetadataChallenge(t *testing.T) {
	h := newTestServer(t, "user", "")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("POST", "/mcp", strings.NewReader("{}")))

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	challenge := rec.Header().Get("WWW-Authenticate")
	if challenge == "" {
		t.Fatal("no WWW-Authenticate header — the discovery flow has no starting point")
	}
	if !strings.HasPrefix(challenge, "Bearer ") {
		t.Errorf("challenge %q does not use the Bearer scheme", challenge)
	}
	if !strings.Contains(challenge, `resource_metadata="`) ||
		!strings.Contains(challenge, protectedResourceMetadataPath) {
		t.Errorf("challenge %q does not point at the metadata document", challenge)
	}
}

// RFC 9728: the document is served at a well-known path, is public, and
// carries `resource` — the only required member — matching the identifier
// it was fetched from.
func TestProtectedResourceMetadataIsPublicAndWellFormed(t *testing.T) {
	h := newTestServer(t, "user", "")
	rec := httptest.NewRecorder()
	// No Authorization header: discovery must work before the caller
	// holds a credential, which is the entire point of it.
	h.ServeHTTP(rec, httptest.NewRequest("GET", protectedResourceMetadataPath, nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 — discovery must not itself require a token", rec.Code)
	}
	var doc map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &doc); err != nil {
		t.Fatalf("body is not JSON: %v\n%s", err, rec.Body)
	}
	res, _ := doc["resource"].(string)
	if res == "" {
		t.Fatal("`resource` is the one REQUIRED member of the document")
	}
	if strings.HasSuffix(res, "/") {
		t.Errorf("resource identifier %q has a trailing slash — RFC 8707 canonical form has none", res)
	}
	if !strings.Contains(res, "://") {
		t.Errorf("resource identifier %q is not an absolute URI", res)
	}
	if strings.Contains(res, "#") {
		t.Errorf("resource identifier %q contains a fragment, which RFC 8707 forbids", res)
	}

	// Deliberately absent rather than wrong: novamem mints its own
	// bearers and fronts no authorization server, so naming one would
	// send clients into a flow that dead-ends.
	if _, ok := doc["authorization_servers"]; ok {
		t.Error("authorization_servers is present — novamem has none to name")
	}
}

// The challenge must point at the same identifier the document reports,
// or a client that follows the pointer lands somewhere the document does
// not describe.
func TestChallengeAndMetadataAgreeOnTheResource(t *testing.T) {
	h := newTestServer(t, "user", "")

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("POST", "/mcp", strings.NewReader("{}")))
	challenge := rec.Header().Get("WWW-Authenticate")

	docRec := httptest.NewRecorder()
	h.ServeHTTP(docRec, httptest.NewRequest("GET", protectedResourceMetadataPath, nil))
	var doc map[string]any
	if err := json.Unmarshal(docRec.Body.Bytes(), &doc); err != nil {
		t.Fatal(err)
	}
	res, _ := doc["resource"].(string)

	if want := res + protectedResourceMetadataPath; !strings.Contains(challenge, want) {
		t.Errorf("challenge %q does not carry %q", challenge, want)
	}
}
