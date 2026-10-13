package conformance

// Service-key administration and the on-behalf-of (OBO) token flow it
// enables — ADR 0011, server side in go/internal/auth/obo.go and
// go/internal/httpapi/servicekeys.go. The JWT is minted here with the
// standard library only: header {alg:EdDSA, kid}, claims {sub, org, aud,
// iat, exp}, signed with a throwaway Ed25519 key whose public half is
// registered through the admin route.

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// mintOBO signs an on-behalf-of JWT.
func mintOBO(t *testing.T, priv ed25519.PrivateKey, kid, org, sub string, ttl time.Duration) string {
	t.Helper()
	b64 := base64.RawURLEncoding.EncodeToString
	hdr, err := json.Marshal(map[string]any{"alg": "EdDSA", "kid": kid})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	pl, err := json.Marshal(map[string]any{
		"sub": sub, "org": org, "aud": "novamem",
		"iat": now.Unix(), "exp": now.Add(ttl).Unix(),
	})
	if err != nil {
		t.Fatal(err)
	}
	signing := b64(hdr) + "." + b64(pl)
	return signing + "." + b64(ed25519.Sign(priv, []byte(signing)))
}

func TestServiceKeysAndOnBehalfOfTokens(t *testing.T) {
	adminPlaneTarget(t)
	ns := NS()
	// Unique org and subject; never "default". NS() is [A-Za-z0-9-] safe.
	org := "conf-obo-" + strings.ToLower(ns)
	if len(org) > 64 {
		org = org[:64]
	}
	sub := "conf-svc-user"

	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	pubB64 := base64.RawURLEncoding.EncodeToString(pub)

	// Registration validation: the default org is refused.
	bad := AdminAPI(t, "/v1/admin/service-keys", Opts{Body: map[string]any{
		"name": "conf-" + ns, "organizationId": "default", "publicKey": pubB64,
	}})
	if bad.Status != 400 {
		t.Fatalf("service key bound to default org status = %d, want 400", bad.Status)
	}

	// Register.
	created := AdminAPI(t, "/v1/admin/service-keys", Opts{Body: map[string]any{
		"name": "conf-" + ns, "organizationId": org, "publicKey": pubB64,
	}})
	if created.Status != 201 {
		t.Fatalf("create service key status = %d, want 201: %v", created.Status, created.Body)
	}
	key := created.MustValidate(t, ServiceKey)
	kid := key["id"].(string)
	revoked := false
	t.Cleanup(func() {
		if !revoked {
			_, _ = apiE("/v1/admin/service-keys/"+kid, Opts{Method: "DELETE", Token: ptr(loadEnv().AdminToken)})
		}
	})
	if key["organizationId"] != org {
		t.Fatalf("organizationId = %v, want %s", key["organizationId"], org)
	}
	if key["publicKey"] != pubB64 {
		t.Fatalf("publicKey = %v, want %s", key["publicKey"], pubB64)
	}
	if key["revokedAt"] != nil {
		t.Fatalf("revokedAt = %v, want null", key["revokedAt"])
	}

	// List.
	list := AdminAPI(t, "/v1/admin/service-keys", Opts{})
	if list.Status != 200 {
		t.Fatalf("list service keys status = %d, want 200", list.Status)
	}
	listed := list.MustValidate(t, ServiceKeyListResponse)
	found := false
	for _, k := range listed["keys"].([]any) {
		if k.(map[string]any)["id"] == kid {
			found = true
		}
	}
	if !found {
		t.Fatalf("registered key %s missing from list", kid)
	}

	// Mint and use the OBO token.
	jwt := mintOBO(t, priv, kid, org, sub, 5*time.Minute)
	obo := ptr(jwt)
	sourceRef := "conf-obo-ref-" + ns
	content := "conf-obo probe " + ns + ": the staging cluster ingress certificate is renewed every ninetieth day"
	rem := API(t, "/v1/remember", Opts{Token: obo, Body: map[string]any{
		"content": content, "namespace": ns, "sourceRefs": []any{sourceRef},
	}})
	if rem.Status != 201 {
		t.Fatalf("OBO remember status = %d, want 201: %v", rem.Status, rem.Body)
	}
	entryID, _ := rem.MustValidate(t, RememberResponse)["id"].(string)
	if entryID == "" {
		t.Fatalf("OBO remember rejected: %v", rem.Body)
	}
	t.Cleanup(func() {
		// Backstop; a no-op once the test has forgotten the entry.
		_, _ = apiE("/v1/forget", Opts{Token: obo, Body: map[string]any{"sourceRef": sourceRef}})
	})

	deadline := time.Now().Add(45 * time.Second)
	seen := false
	for time.Now().Before(deadline) && !seen {
		s := API(t, "/v1/search", Opts{Token: obo, Body: map[string]any{
			"query": "staging ingress certificate renewal", "namespace": ns, "k": 10,
		}})
		if s.Status != 200 {
			t.Fatalf("OBO search status = %d, want 200: %v", s.Status, s.Body)
		}
		for _, e := range searchResults(t, s) {
			if e["id"] == entryID {
				seen = true
			}
		}
		if !seen {
			time.Sleep(time.Second)
		}
	}
	if !seen {
		t.Fatalf("OBO search did not return entry %s within 45s", entryID)
	}

	// An OBO token cannot reach the admin plane.
	denied := API(t, "/v1/admin/service-keys", Opts{Token: obo})
	if denied.Status != 403 {
		t.Fatalf("OBO GET /v1/admin/service-keys status = %d, want 403", denied.Status)
	}

	// Forget by source reference.
	fg := API(t, "/v1/forget", Opts{Token: obo, Body: map[string]any{"sourceRef": sourceRef}})
	if fg.Status != 200 {
		t.Fatalf("OBO forget by sourceRef status = %d, want 200: %v", fg.Status, fg.Body)
	}
	fgBody := fg.MustValidate(t, ForgetBySourceResponse)
	if fgBody["sourceRef"] != sourceRef {
		t.Fatalf("forget sourceRef = %v, want %s", fgBody["sourceRef"], sourceRef)
	}
	gone := false
	for _, id := range fgBody["ids"].([]any) {
		if id == entryID {
			gone = true
		}
	}
	if !gone || fgBody["count"].(float64) < 1 {
		t.Fatalf("forget by sourceRef did not delete %s: %v", entryID, fgBody)
	}

	// Revoke: the same JWT stops verifying immediately.
	rv := AdminAPI(t, "/v1/admin/service-keys/"+kid, Opts{Method: "DELETE"})
	if rv.Status != 200 {
		t.Fatalf("revoke service key status = %d, want 200: %v", rv.Status, rv.Body)
	}
	revoked = true
	if rv.MustValidate(t, ServiceKeyRevokeResponse)["revoked"] != true {
		t.Fatalf("revoked = %v, want true", rv.Body)
	}
	after := API(t, "/v1/search", Opts{Token: obo, Body: map[string]any{"query": "staging", "namespace": ns}})
	if after.Status != 401 {
		t.Fatalf("OBO search after revoke status = %d, want 401", after.Status)
	}
	again := AdminAPI(t, "/v1/admin/service-keys/"+kid, Opts{Method: "DELETE"})
	if again.Status != 404 {
		t.Fatalf("second revoke status = %d, want 404", again.Status)
	}

	// The list still shows the key, now revoked.
	list2 := AdminAPI(t, "/v1/admin/service-keys", Opts{})
	for _, k := range list2.MustValidate(t, ServiceKeyListResponse)["keys"].([]any) {
		m := k.(map[string]any)
		if m["id"] == kid && m["revokedAt"] == nil {
			t.Fatalf("key %s listed without revokedAt after revoke", kid)
		}
	}
}
