package auth

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"strings"
	"testing"
	"time"
)

func oboKey(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return pub, priv
}

func TestVerifyOBOToken(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	pub, priv := oboKey(t)
	_, otherPriv := oboKey(t)
	keys := map[string]*ServiceKey{
		"k1":   {ID: "k1", OrgID: "acme", PublicKey: pub},
		"rev":  {ID: "rev", OrgID: "acme", PublicKey: pub, Revoked: true},
		"dflt": {ID: "dflt", OrgID: "default", PublicKey: pub},
	}
	lookup := func(_ context.Context, kid string) (*ServiceKey, error) { return keys[kid], nil }

	mint := func(priv ed25519.PrivateKey, kid, org, sub string, iat time.Time, ttl time.Duration) string {
		tok, err := MintOBOToken(priv, kid, org, sub, iat, ttl)
		if err != nil {
			t.Fatal(err)
		}
		return tok
	}
	// resign swaps the payload and signs it properly with priv, for
	// claims the minter would not produce.
	resign := func(header, payload string) string {
		b64 := base64.RawURLEncoding.EncodeToString
		signing := b64([]byte(header)) + "." + b64([]byte(payload))
		return signing + "." + b64(ed25519.Sign(priv, []byte(signing)))
	}

	cases := []struct {
		name  string
		token string
		ok    bool
	}{
		{"valid", mint(priv, "k1", "acme", "alice", now, 5*time.Minute), true},
		{"max lifetime ok", mint(priv, "k1", "acme", "alice", now, 15*time.Minute), true},
		{"bad signature", mint(otherPriv, "k1", "acme", "alice", now, time.Minute), false},
		{"unknown kid", mint(priv, "nope", "acme", "alice", now, time.Minute), false},
		{"revoked kid", mint(priv, "rev", "acme", "alice", now, time.Minute), false},
		{"default-org key", mint(priv, "dflt", "default", "alice", now, time.Minute), false},
		{"wrong org", mint(priv, "k1", "globex", "alice", now, time.Minute), false},
		{"expired", mint(priv, "k1", "acme", "alice", now.Add(-time.Hour), 10*time.Minute), false},
		{"within skew", mint(priv, "k1", "acme", "alice", now.Add(-10*time.Minute), 10*time.Minute+10*time.Second), true},
		{"lifetime too long", mint(priv, "k1", "acme", "alice", now, 16*time.Minute), false},
		{"iat in future", mint(priv, "k1", "acme", "alice", now.Add(time.Hour), time.Minute), false},
		{"bad sub charset", mint(priv, "k1", "acme", "al/ice", now, time.Minute), false},
		{"empty sub", mint(priv, "k1", "acme", "", now, time.Minute), false},
		{"long sub", mint(priv, "k1", "acme", strings.Repeat("a", 129), now, time.Minute), false},
		{"wrong alg", resign(`{"alg":"HS256","kid":"k1"}`, `{"sub":"a","org":"acme","aud":"novamem","iat":1800000000,"exp":1800000060}`), false},
		{"alg none", resign(`{"alg":"none","kid":"k1"}`, `{"sub":"a","org":"acme","aud":"novamem","iat":1800000000,"exp":1800000060}`), false},
		{"wrong aud", resign(`{"alg":"EdDSA","kid":"k1"}`, `{"sub":"a","org":"acme","aud":"other","iat":1800000000,"exp":1800000060}`), false},
		{"aud array", resign(`{"alg":"EdDSA","kid":"k1"}`, `{"sub":"a","org":"acme","aud":["x","novamem"],"iat":1800000000,"exp":1800000060}`), true},
		{"missing exp", resign(`{"alg":"EdDSA","kid":"k1"}`, `{"sub":"a","org":"acme","aud":"novamem","iat":1800000000}`), false},
		{"garbage", "a.b.c", false},
		{"two parts", "a.b", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			claims, err := VerifyOBOToken(context.Background(), tc.token, now, lookup)
			if tc.ok {
				if err != nil {
					t.Fatalf("want ok, got %v", err)
				}
				if claims.Org != "acme" {
					t.Fatalf("org = %q", claims.Org)
				}
				return
			}
			if !errors.Is(err, ErrInvalidOBOToken) {
				t.Fatalf("want ErrInvalidOBOToken, got %v", err)
			}
		})
	}

	t.Run("tampered payload", func(t *testing.T) {
		tok := mint(priv, "k1", "acme", "alice", now, time.Minute)
		parts := strings.Split(tok, ".")
		parts[1] = base64.RawURLEncoding.EncodeToString([]byte(`{"sub":"bob","org":"acme","aud":"novamem","iat":1800000000,"exp":1800000060}`))
		if _, err := VerifyOBOToken(context.Background(), strings.Join(parts, "."), now, lookup); !errors.Is(err, ErrInvalidOBOToken) {
			t.Fatalf("want rejection, got %v", err)
		}
	})
	t.Run("lookup failure is not a token error", func(t *testing.T) {
		boom := errors.New("db down")
		_, err := VerifyOBOToken(context.Background(), mint(priv, "k1", "acme", "a", now, time.Minute), now,
			func(context.Context, string) (*ServiceKey, error) { return nil, boom })
		if !errors.Is(err, boom) || errors.Is(err, ErrInvalidOBOToken) {
			t.Fatalf("got %v", err)
		}
	})
}

func TestLooksLikeOBOToken(t *testing.T) {
	for tok, want := range map[string]bool{"nm_abc.def.ghi": false, "a.b.c": true, "plain": false, "a.b": false} {
		if got := LooksLikeOBOToken(tok); got != want {
			t.Errorf("%q = %v", tok, got)
		}
	}
}
