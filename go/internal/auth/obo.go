// On-behalf-of (OBO) service tokens (ADR 0011).
//
// A service holds an Ed25519 private key; an admin registered the public
// half, bound to one organization. The service mints a short-lived
// EdDSA JWT per call (or per few calls) and presents it as the bearer.
// NovaMem stores only the public key, so a database leak yields nothing
// that can mint.
//
//	header  {"alg":"EdDSA","kid":"<service key id>"}
//	claims  {"sub":"<user>","org":"<org>","aud":"novamem","iat":N,"exp":N}
//
// Verification is pure (no I/O beyond the injected key lookup) so it is
// unit-testable without a database.
package auth

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/azrtydxb/novamem/go/internal/tenant"
)

const (
	// OBOAudience is the required `aud` claim.
	OBOAudience = "novamem"
	// OBOMaxLifetime caps exp-iat. A token minted for longer is rejected
	// outright rather than clamped: the cap is what bounds the damage of
	// a leaked token.
	OBOMaxLifetime = 15 * time.Minute
	// OBOClockSkew is the leeway applied to exp and to a future iat.
	OBOClockSkew = 30 * time.Second
)

// ErrInvalidOBOToken is wrapped by every verification failure that means
// "this credential is not acceptable". Callers answer 401 without
// revealing which check failed; the wrapped reason is for logs and tests.
var ErrInvalidOBOToken = errors.New("invalid on-behalf-of token")

func invalid(format string, a ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalidOBOToken, fmt.Sprintf(format, a...))
}

// LooksLikeOBOToken reports whether a bearer is shaped like a JWT and is
// therefore not an `nm_` user token. It is only a router: a true result
// still has to verify.
func LooksLikeOBOToken(token string) bool {
	return !strings.HasPrefix(token, "nm_") && strings.Count(token, ".") == 2
}

// ServiceKey is what verification needs to know about a registered key.
type ServiceKey struct {
	ID        string
	OrgID     string
	PublicKey ed25519.PublicKey
	Revoked   bool
}

// KeyLookup resolves a kid. It returns (nil, nil) for an unknown kid; a
// non-nil error means the lookup itself failed (and is not a 401).
type KeyLookup func(ctx context.Context, kid string) (*ServiceKey, error)

// OBOClaims is a verified token.
type OBOClaims struct {
	KeyID string
	Org   string
	Sub   string
}

// UserID is the composite internal identity for these claims.
func (c OBOClaims) UserID() string { return tenant.UserID(c.Org, c.Sub) }

type oboHeader struct {
	Alg string `json:"alg"`
	Kid string `json:"kid"`
}

type oboPayload struct {
	Sub string          `json:"sub"`
	Org string          `json:"org"`
	Aud json.RawMessage `json:"aud"`
	Iat *int64          `json:"iat"`
	Exp *int64          `json:"exp"`
}

func audienceOK(raw json.RawMessage) bool {
	var one string
	if json.Unmarshal(raw, &one) == nil {
		return one == OBOAudience
	}
	var many []string
	if json.Unmarshal(raw, &many) == nil {
		for _, a := range many {
			if a == OBOAudience {
				return true
			}
		}
	}
	return false
}

// VerifyOBOToken checks a token against the registered keys. Checks, in
// order: structure, alg == EdDSA, known and unrevoked kid, signature,
// aud, expiry (with skew), lifetime cap, org == the key's bound org, and
// the charset of sub and org. A key bound to the default organization is
// refused here as well as at registration.
func VerifyOBOToken(ctx context.Context, token string, now time.Time, lookup KeyLookup) (*OBOClaims, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, invalid("not a three-part JWT")
	}
	dec := base64.RawURLEncoding
	hb, err := dec.DecodeString(parts[0])
	if err != nil {
		return nil, invalid("header encoding")
	}
	var h oboHeader
	if err := json.Unmarshal(hb, &h); err != nil {
		return nil, invalid("header JSON")
	}
	if h.Alg != "EdDSA" {
		return nil, invalid("alg %q", h.Alg)
	}
	if h.Kid == "" {
		return nil, invalid("missing kid")
	}
	key, err := lookup(ctx, h.Kid)
	if err != nil {
		return nil, err
	}
	if key == nil {
		return nil, invalid("unknown kid")
	}
	if key.Revoked {
		return nil, invalid("revoked kid")
	}
	if len(key.PublicKey) != ed25519.PublicKeySize {
		return nil, invalid("malformed registered key")
	}
	sig, err := dec.DecodeString(parts[2])
	if err != nil || len(sig) != ed25519.SignatureSize {
		return nil, invalid("signature encoding")
	}
	if !ed25519.Verify(key.PublicKey, []byte(parts[0]+"."+parts[1]), sig) {
		return nil, invalid("bad signature")
	}

	pb, err := dec.DecodeString(parts[1])
	if err != nil {
		return nil, invalid("payload encoding")
	}
	var p oboPayload
	if err := json.Unmarshal(pb, &p); err != nil {
		return nil, invalid("payload JSON")
	}
	if !audienceOK(p.Aud) {
		return nil, invalid("aud")
	}
	if p.Iat == nil || p.Exp == nil {
		return nil, invalid("missing iat/exp")
	}
	iat, exp := time.Unix(*p.Iat, 0), time.Unix(*p.Exp, 0)
	if now.After(exp.Add(OBOClockSkew)) {
		return nil, invalid("expired")
	}
	if iat.After(now.Add(OBOClockSkew)) {
		return nil, invalid("issued in the future")
	}
	if !exp.After(iat) {
		return nil, invalid("exp not after iat")
	}
	if exp.Sub(iat) > OBOMaxLifetime {
		return nil, invalid("lifetime %s exceeds %s", exp.Sub(iat), OBOMaxLifetime)
	}
	if key.OrgID == tenant.DefaultOrg || !tenant.ValidOrg(key.OrgID) {
		return nil, invalid("key bound to a disallowed org")
	}
	if p.Org != key.OrgID {
		return nil, invalid("org does not match the key's organization")
	}
	if !tenant.ValidSub(p.Sub) {
		return nil, invalid("sub charset or length")
	}
	return &OBOClaims{KeyID: h.Kid, Org: p.Org, Sub: p.Sub}, nil
}

// MintOBOToken signs a token. The server never mints (that is the point);
// this exists for tests, and mirrors what the Go client ships.
func MintOBOToken(priv ed25519.PrivateKey, kid, org, sub string, iat time.Time, ttl time.Duration) (string, error) {
	hdr, err := json.Marshal(oboHeader{Alg: "EdDSA", Kid: kid})
	if err != nil {
		return "", err
	}
	pl, err := json.Marshal(map[string]any{
		"sub": sub, "org": org, "aud": OBOAudience,
		"iat": iat.Unix(), "exp": iat.Add(ttl).Unix(),
	})
	if err != nil {
		return "", err
	}
	b64 := base64.RawURLEncoding.EncodeToString
	signing := b64(hdr) + "." + b64(pl)
	return signing + "." + b64(ed25519.Sign(priv, []byte(signing))), nil
}

// DecodeServicePublicKey parses the registered form: the raw 32-byte
// Ed25519 key, base64url without padding (padding and std alphabet are
// tolerated).
func DecodeServicePublicKey(s string) (ed25519.PublicKey, error) {
	s = strings.TrimRight(strings.TrimSpace(s), "=")
	s = strings.NewReplacer("+", "-", "/", "_").Replace(s)
	raw, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return nil, fmt.Errorf("public key is not base64: %w", err)
	}
	if len(raw) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("public key must be %d bytes, got %d", ed25519.PublicKeySize, len(raw))
	}
	return ed25519.PublicKey(raw), nil
}

// EncodeServicePublicKey is the inverse of DecodeServicePublicKey.
func EncodeServicePublicKey(k ed25519.PublicKey) string {
	return base64.RawURLEncoding.EncodeToString(k)
}
