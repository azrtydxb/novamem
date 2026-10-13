package novamem

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"
)

func decodeJWT(t *testing.T, tok string) (hdr, claims map[string]any, signing string, sig []byte) {
	t.Helper()
	parts := strings.Split(tok, ".")
	if len(parts) != 3 {
		t.Fatalf("not a JWT: %q", tok)
	}
	dec := func(s string) map[string]any {
		raw, err := base64.RawURLEncoding.DecodeString(s)
		if err != nil {
			t.Fatal(err)
		}
		var m map[string]any
		if err := json.Unmarshal(raw, &m); err != nil {
			t.Fatal(err)
		}
		return m
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		t.Fatal(err)
	}
	return dec(parts[0]), dec(parts[1]), parts[0] + "." + parts[1], sig
}

func TestMintOBOToken(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	tok, err := MintOBOToken(priv, "kid1", "acme", "alice", 10*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	hdr, claims, signing, sig := decodeJWT(t, tok)
	if hdr["alg"] != "EdDSA" || hdr["kid"] != "kid1" {
		t.Fatalf("header %v", hdr)
	}
	if claims["sub"] != "alice" || claims["org"] != "acme" || claims["aud"] != "novamem" {
		t.Fatalf("claims %v", claims)
	}
	if exp, iat := claims["exp"].(float64), claims["iat"].(float64); exp-iat != 600 {
		t.Fatalf("lifetime %v", exp-iat)
	}
	if !ed25519.Verify(pub, []byte(signing), sig) {
		t.Fatal("signature does not verify")
	}
	for name, args := range map[string][]any{
		"zero ttl":  {priv, "k", "o", "s", time.Duration(0)},
		"over cap":  {priv, "k", "o", "s", 16 * time.Minute},
		"empty sub": {priv, "k", "o", "", time.Minute},
		"short key": {ed25519.PrivateKey("x"), "k", "o", "s", time.Minute},
	} {
		if _, err := MintOBOToken(args[0].(ed25519.PrivateKey), args[1].(string), args[2].(string), args[3].(string), args[4].(time.Duration)); err == nil {
			t.Errorf("%s: want error", name)
		}
	}
}

func TestOBOTokenSourceSendsAndRefreshes(t *testing.T) {
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	src, err := NewOBOTokenSource(priv, "kid1", "acme", "alice", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	a, _ := src(context.Background())
	b, _ := src(context.Background())
	if a != b {
		t.Fatal("token should be reused while fresh")
	}
	var got string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Get("Authorization")
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []any{}})
	}))
	t.Cleanup(ts.Close)
	srv := ts.URL
	ad, err := NewAdmin(Config{BaseURL: srv, TokenSource: src})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ad.ListServiceKeys(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got != "Bearer "+a {
		t.Fatalf("Authorization = %q", got)
	}
	if _, err := New(Config{BaseURL: srv}); err == nil {
		t.Fatal("New without Token or TokenSource must still fail")
	}
}

func TestAdminServiceKeys(t *testing.T) {
	pub, _, _ := ed25519.GenerateKey(rand.Reader)
	var seen []string
	a := newTestAdmin(t, func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.Method+" "+r.URL.Path)
		switch r.Method {
		case http.MethodPost:
			var body map[string]string
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["publicKey"] != base64.RawURLEncoding.EncodeToString(pub) || body["organizationId"] != "acme" {
				t.Errorf("body %v", body)
			}
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(ServiceKey{ID: "k1", Name: body["name"], OrganizationID: "acme"})
		case http.MethodGet:
			_ = json.NewEncoder(w).Encode(map[string]any{"keys": []ServiceKey{{ID: "k1"}}})
		default:
			_ = json.NewEncoder(w).Encode(map[string]bool{"revoked": true})
		}
	})
	ctx := context.Background()
	k, err := a.RegisterServiceKey(ctx, "atlas", "acme", pub)
	if err != nil || k.ID != "k1" {
		t.Fatalf("Register: %v %+v", err, k)
	}
	if ks, err := a.ListServiceKeys(ctx); err != nil || len(ks) != 1 {
		t.Fatalf("List: %v %v", err, ks)
	}
	if err := a.RevokeServiceKey(ctx, "k1"); err != nil {
		t.Fatal(err)
	}
	want := []string{"POST /v1/admin/service-keys", "GET /v1/admin/service-keys", "DELETE /v1/admin/service-keys/k1"}
	if !reflect.DeepEqual(seen, want) {
		t.Fatalf("requests %v", seen)
	}
	if _, err := a.RegisterServiceKey(ctx, "x", "acme", pub[:5]); err == nil {
		t.Fatal("want local validation error")
	}
}
