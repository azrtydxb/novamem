// Better Auth's jwt plugin, natively: GET /api/auth/jwks and
// GET /api/auth/token, plus the `set-auth-jwt` header get-session
// carries.
//
// The key material lives in the `jwks` table Better Auth owns, so a
// database written by either server is readable by the other:
//
//   - publicKey  — a plain JWK JSON document.
//   - privateKey — JSON.stringify(hex) where hex is the private JWK
//     document sealed with XChaCha20-Poly1305 under SHA-256(secret),
//     nonce-prefixed (@noble/ciphers `managedNonce`). That is
//     better-auth's `symmetricEncrypt` for a plain string secret;
//     the versioned `$ba$…` envelope only appears when the deployment
//     configures a key ring, which novamem does not.
//
// Algorithm is EdDSA/Ed25519 — better-auth's default, and this
// deployment passes no `jwks.keyPairConfig`.
package httpapi

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"golang.org/x/crypto/chacha20poly1305"

	"github.com/azrtydxb/novamem/go/internal/auth"
	"github.com/azrtydxb/novamem/go/internal/warmstore"
)

// jwtTTL — auth-betterauth.ts jwt({ jwt: { expirationTime: "15m" } }).
const jwtTTL = 15 * time.Minute

// jwkDoc is the Ed25519 JWK shape better-auth stores (jose exportJWK).
type jwkDoc struct {
	Crv string `json:"crv"`
	D   string `json:"d,omitempty"`
	X   string `json:"x"`
	Kty string `json:"kty"`
}

// baDecryptSecret derives better-auth's symmetric key: SHA-256 over the
// UTF-8 secret.
func baDecryptSecret(secret string) []byte {
	sum := sha256.Sum256([]byte(secret))
	return sum[:]
}

func baSymmetricDecrypt(secret, hexData string) (string, error) {
	raw, err := hex.DecodeString(hexData)
	if err != nil {
		return "", err
	}
	aead, err := chacha20poly1305.NewX(baDecryptSecret(secret))
	if err != nil {
		return "", err
	}
	if len(raw) < aead.NonceSize() {
		return "", errors.New("jwks: ciphertext shorter than nonce")
	}
	out, err := aead.Open(nil, raw[:aead.NonceSize()], raw[aead.NonceSize():], nil)
	return string(out), err
}

func baSymmetricEncrypt(secret, plaintext string) (string, error) {
	aead, err := chacha20poly1305.NewX(baDecryptSecret(secret))
	if err != nil {
		return "", err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	return hex.EncodeToString(aead.Seal(nonce, nonce, []byte(plaintext), nil)), nil
}

// signingKey returns the newest key pair, generating and storing one the
// first time (better-auth's sign path does the same).
func (s *server) signingKey(r *http.Request) (kid string, key ed25519.PrivateKey, err error) {
	keys, err := s.warm.AllJWKs(r.Context())
	if err != nil {
		return "", nil, err
	}
	if len(keys) == 0 {
		k, err := s.createJWK(r)
		if err != nil {
			return "", nil, err
		}
		keys = []warmstore.JWK{*k}
	}
	var wrapped string
	if err := json.Unmarshal([]byte(keys[0].PrivateKey), &wrapped); err != nil {
		// disablePrivateKeyEncryption stores the document bare.
		wrapped = ""
	}
	doc := keys[0].PrivateKey
	if wrapped != "" {
		if doc, err = baSymmetricDecrypt(s.cookieSecret, wrapped); err != nil {
			return "", nil, err
		}
	}
	var jwk jwkDoc
	if err := json.Unmarshal([]byte(doc), &jwk); err != nil {
		return "", nil, err
	}
	seed, err := base64.RawURLEncoding.DecodeString(jwk.D)
	if err != nil {
		return "", nil, err
	}
	if len(seed) != ed25519.SeedSize {
		return "", nil, errors.New("jwks: private key is not Ed25519")
	}
	return keys[0].ID, ed25519.NewKeyFromSeed(seed), nil
}

func (s *server) createJWK(r *http.Request) (*warmstore.JWK, error) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	b64 := base64.RawURLEncoding.EncodeToString
	pubDoc, err := json.Marshal(jwkDoc{Crv: "Ed25519", X: b64(pub), Kty: "OKP"})
	if err != nil {
		return nil, err
	}
	privDoc, err := json.Marshal(jwkDoc{Crv: "Ed25519", D: b64(priv.Seed()), X: b64(pub), Kty: "OKP"})
	if err != nil {
		return nil, err
	}
	sealed, err := baSymmetricEncrypt(s.cookieSecret, string(privDoc))
	if err != nil {
		return nil, err
	}
	stored, err := json.Marshal(sealed)
	if err != nil {
		return nil, err
	}
	k := &warmstore.JWK{ID: auth.NewID(), PublicKey: string(pubDoc), PrivateKey: string(stored)}
	if err := s.warm.InsertJWK(r.Context(), k.ID, k.PublicKey, k.PrivateKey); err != nil {
		return nil, err
	}
	return k, nil
}

// baseURL is the `iss`/`aud` better-auth stamps on every JWT — its
// `baseURL` option, which main.go puts first in TrustedOrigins.
func (s *server) baseURL() string {
	if len(s.trustedOrigins) > 0 {
		return s.trustedOrigins[0]
	}
	return ""
}

// signUserJWT reproduces getJwtToken: the user document as the payload,
// plus iat / sub / exp / iss / aud in better-auth's own key order.
func (s *server) signUserJWT(r *http.Request, u *warmstore.BAUser) (string, error) {
	kid, key, err := s.signingKey(r)
	if err != nil {
		return "", err
	}
	now := time.Now()
	header, err := json.Marshal(map[string]string{"alg": "EdDSA", "kid": kid})
	if err != nil {
		return "", err
	}
	// json.Marshal on a map sorts keys, which would scramble better-auth's
	// order; build the object by hand from the already-ordered user doc.
	userJSON, err := json.Marshal(u)
	if err != nil {
		return "", err
	}
	iss := jsonString(s.baseURL())
	id := jsonString(u.ID)
	var payload strings.Builder
	payload.WriteString(`{"iat":`)
	payload.WriteString(itoa64(now.Unix()))
	payload.WriteByte(',')
	payload.Write(userJSON[1 : len(userJSON)-1]) // strip the braces
	payload.WriteString(`,"sub":`)
	payload.WriteString(id)
	payload.WriteString(`,"exp":`)
	payload.WriteString(itoa64(now.Add(jwtTTL).Unix()))
	payload.WriteString(`,"iss":`)
	payload.WriteString(iss)
	payload.WriteString(`,"aud":`)
	payload.WriteString(iss)
	payload.WriteByte('}')

	b64 := base64.RawURLEncoding.EncodeToString
	signing := b64(header) + "." + b64([]byte(payload.String()))
	return signing + "." + b64(ed25519.Sign(key, []byte(signing))), nil
}

// jsonString is json.Marshal for a string, without the error return —
// encoding a string can only fail on invalid UTF-8, which Postgres text
// columns cannot hold.
func jsonString(v string) string {
	b, err := marshalJS(v)
	if err != nil {
		return `""`
	}
	return string(b)
}

func itoa64(n int64) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

// GET /api/auth/jwks — the public key set. Unauthenticated by design.
func (s *server) handleBAJWKS(w http.ResponseWriter, r *http.Request) {
	keys, err := s.warm.AllJWKs(r.Context())
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	if len(keys) == 0 {
		k, err := s.createJWK(r)
		if err != nil {
			s.sendEngineErr(w, r, err)
			return
		}
		keys = []warmstore.JWK{*k}
	}
	// `{alg, crv, ...publicKey, kid}` — alg and crv are declared first so
	// the spread lands crv in position 2, exactly as upstream renders it.
	var out strings.Builder
	out.WriteString(`{"keys":[`)
	for i, k := range keys {
		var pub jwkDoc
		if err := json.Unmarshal([]byte(k.PublicKey), &pub); err != nil {
			s.sendEngineErr(w, r, err)
			return
		}
		if i > 0 {
			out.WriteByte(',')
		}
		out.WriteString(`{"alg":"EdDSA","crv":` + jsonString(pub.Crv) +
			`,"x":` + jsonString(pub.X) +
			`,"kty":` + jsonString(pub.Kty) +
			`,"kid":` + jsonString(k.ID) + `}`)
	}
	out.WriteString(`]}`)
	writeJSON(w, http.StatusOK, []byte(out.String()))
}

// GET /api/auth/token — a fresh JWT for the current session.
func (s *server) handleBAToken(w http.ResponseWriter, r *http.Request) {
	u := s.sessionUser(r)
	if u == nil {
		baErr(w, http.StatusUnauthorized, "UNAUTHORIZED", "Unauthorized")
		return
	}
	doc, err := s.warm.GetBAUser(r.Context(), u.ID)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	if doc == nil {
		baErr(w, http.StatusUnauthorized, "UNAUTHORIZED", "Unauthorized")
		return
	}
	token, err := s.signUserJWT(r, doc)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	writeJSONValue(w, http.StatusOK, map[string]any{"token": token})
}
