package novamem

// On-behalf-of tokens (server ADR 0011).
//
// A service that acts for its own users — Kuvryn Atlas is the first — does
// not hold a NovaMem token per user. An admin registers the service's
// Ed25519 PUBLIC key once (Admin.RegisterServiceKey), bound to one
// organization, and the service then signs a short-lived JWT per user. The
// JWT is the bearer; nothing else about the wire changes.
//
// NovaMem scopes everything the token touches to (organization, subject): an
// entry written for org A / alice is invisible to org A / bob and to every
// token of org B. Projects, accounts, token management and the admin
// surface are not available to these tokens.

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/url"
	"sync"
	"time"
)

const (
	// OBOAudience is the `aud` claim the server requires.
	OBOAudience = "novamem"
	// OBOMaxTTL is the longest lifetime the server accepts (exp - iat).
	OBOMaxTTL = 15 * time.Minute
)

// MintOBOToken signs an on-behalf-of JWT. kid is the id Admin.RegisterServiceKey
// returned; org must be the organization that key is bound to; sub is the
// end user the call acts for. ttl must be positive and at most [OBOMaxTTL]
// (the server rejects longer tokens outright rather than clamping them).
func MintOBOToken(priv ed25519.PrivateKey, kid, org, sub string, ttl time.Duration) (string, error) {
	return mintOBOToken(priv, kid, org, sub, time.Now(), ttl)
}

func mintOBOToken(priv ed25519.PrivateKey, kid, org, sub string, now time.Time, ttl time.Duration) (string, error) {
	switch {
	case len(priv) != ed25519.PrivateKeySize:
		return "", errors.New("novamem: private key is not an Ed25519 key")
	case kid == "" || org == "" || sub == "":
		return "", errors.New("novamem: kid, org and sub are required")
	case ttl <= 0 || ttl > OBOMaxTTL:
		return "", errors.New("novamem: ttl must be positive and at most 15 minutes")
	}
	hdr, err := json.Marshal(map[string]string{"alg": "EdDSA", "kid": kid})
	if err != nil {
		return "", err
	}
	claims, err := json.Marshal(map[string]any{
		"sub": sub, "org": org, "aud": OBOAudience,
		"iat": now.Unix(), "exp": now.Add(ttl).Unix(),
	})
	if err != nil {
		return "", err
	}
	b64 := base64.RawURLEncoding.EncodeToString
	signing := b64(hdr) + "." + b64(claims)
	return signing + "." + b64(ed25519.Sign(priv, []byte(signing))), nil
}

// NewOBOTokenSource returns a [Config.TokenSource] that mints a token for one
// (org, sub) and reuses it until it is close to expiry. Use one Client per
// subject: a Client acts as exactly one user.
func NewOBOTokenSource(priv ed25519.PrivateKey, kid, org, sub string, ttl time.Duration) (func(context.Context) (string, error), error) {
	// Fail at wiring time, not on the first call.
	if _, err := MintOBOToken(priv, kid, org, sub, ttl); err != nil {
		return nil, err
	}
	var (
		mu      sync.Mutex
		cached  string
		expires time.Time
	)
	return func(context.Context) (string, error) {
		mu.Lock()
		defer mu.Unlock()
		// Refresh with a fifth of the lifetime left, so a request in flight
		// never carries a token that expires under it.
		if cached != "" && time.Until(expires) > ttl/5 {
			return cached, nil
		}
		now := time.Now()
		tok, err := mintOBOToken(priv, kid, org, sub, now, ttl)
		if err != nil {
			return "", err
		}
		cached, expires = tok, now.Add(ttl)
		return cached, nil
	}, nil
}

// ServiceKey is one registered service key.
type ServiceKey struct {
	// ID is the `kid` to put in the JWT header.
	ID             string  `json:"id"`
	Name           string  `json:"name"`
	OrganizationID string  `json:"organizationId"`
	PublicKey      string  `json:"publicKey"`
	CreatedAt      string  `json:"createdAt"`
	RevokedAt      *string `json:"revokedAt"`
}

// RegisterServiceKey registers a service's Ed25519 public key, bound to ONE
// organization, and returns it with the id to use as `kid`. NovaMem stores
// only the public key. The organization "default" is refused (400): it holds
// every real user's data, and a service key bound to it could act as any of
// them.
func (a *Admin) RegisterServiceKey(ctx context.Context, name, organizationID string, pub ed25519.PublicKey) (ServiceKey, error) {
	var out ServiceKey
	if name == "" || organizationID == "" {
		return out, &Error{Op: "register-service-key", Message: "name and organizationID are required"}
	}
	if len(pub) != ed25519.PublicKeySize {
		return out, &Error{Op: "register-service-key", Message: "pub is not an Ed25519 public key"}
	}
	body := struct {
		Name           string `json:"name"`
		OrganizationID string `json:"organizationId"`
		PublicKey      string `json:"publicKey"`
	}{name, organizationID, base64.RawURLEncoding.EncodeToString(pub)}
	err := a.c.do(ctx, "register-service-key", "POST", "/v1/admin/service-keys", body, &out)
	return out, err
}

// ListServiceKeys returns every registered key, revoked ones included.
func (a *Admin) ListServiceKeys(ctx context.Context) ([]ServiceKey, error) {
	var out struct {
		Keys []ServiceKey `json:"keys"`
	}
	err := a.c.do(ctx, "list-service-keys", "GET", "/v1/admin/service-keys", nil, &out)
	return out.Keys, err
}

// RevokeServiceKey revokes a key; tokens it signed stop verifying at once.
// Revoking an unknown or already-revoked key is a 404 *Error.
func (a *Admin) RevokeServiceKey(ctx context.Context, id string) error {
	if id == "" {
		return &Error{Op: "revoke-service-key", Message: "id is required"}
	}
	return a.c.do(ctx, "revoke-service-key", "DELETE", "/v1/admin/service-keys/"+url.PathEscape(id), nil, nil)
}
