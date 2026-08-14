// Package auth carries the crypto primitives the user auth mode needs,
// all of them chosen to be byte-compatible with what Better Auth (and
// our own warm store) already wrote to Postgres — cutover must not
// require a re-login or a token re-issue.
//
// Formats verified against a live row / a live sign-in on the bench
// Postgres before this package was written:
//
//   - account.password = "<salt-hex>:<key-hex>", 16-byte salt, 64-byte
//     key. The key is scrypt(NFKC(password), salt-as-ASCII-hex-string,
//     N=16384, r=16, p=1, dkLen=64) — Better Auth's defaults
//     (better-auth/src/crypto/password.ts via @noble/hashes). NOTE the
//     salt is fed to scrypt as the 32 ASCII characters of the hex
//     string, NOT as the 16 decoded bytes.
//   - cookie nm.session_token = "<session.token>.<sig>" where sig is
//     standard base64 (padding kept, then URL-encoded in the cookie) of
//     HMAC-SHA256(cookieSecret, session.token) — better-call's
//     signed-cookie format.
package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/scrypt"
	"golang.org/x/text/unicode/norm"
)

// Better Auth's scrypt parameters. r=16 is unusual (32 MiB per verify)
// but it is what the stored hashes were produced with.
const (
	scryptN      = 16384
	scryptR      = 16
	scryptP      = 1
	scryptKeyLen = 64
)

// VerifyPassword checks a plaintext against Better Auth's stored
// "salt:key" hash. Constant-time on the key comparison; false on any
// malformed hash.
func VerifyPassword(stored, password string) bool {
	salt, wantHex, found := strings.Cut(stored, ":")
	if !found || salt == "" || wantHex == "" {
		return false
	}
	want, err := hex.DecodeString(wantHex)
	if err != nil {
		return false
	}
	got, err := scrypt.Key([]byte(norm.NFKC.String(password)), []byte(salt),
		scryptN, scryptR, scryptP, scryptKeyLen)
	if err != nil {
		return false
	}
	return subtle.ConstantTimeCompare(got, want) == 1
}

// HashPassword produces a hash in Better Auth's stored format so an
// account provisioned by this server signs in against the TypeScript
// server too: a 16-byte random salt rendered as hex, then
// scrypt(NFKC(password), <that 32-char hex string>, N, r, p, dkLen),
// joined "<salthex>:<keyhex>". Same parameters VerifyPassword checks.
func HashPassword(password string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	saltHex := hex.EncodeToString(salt)
	key, err := scrypt.Key([]byte(norm.NFKC.String(password)), []byte(saltHex),
		scryptN, scryptR, scryptP, scryptKeyLen)
	if err != nil {
		return "", err
	}
	return saltHex + ":" + hex.EncodeToString(key), nil
}

// SignCookie returns better-call's signed-cookie value for a session token.
func SignCookie(secret, value string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(value))
	return value + "." + base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

// VerifyCookie recovers the session token from a signed cookie value,
// or ("", false) when the signature doesn't check out.
func VerifyCookie(secret, signed string) (string, bool) {
	i := strings.LastIndex(signed, ".")
	if i < 0 {
		return "", false
	}
	value := signed[:i]
	if !hmac.Equal([]byte(SignCookie(secret, value)), []byte(signed)) {
		return "", false
	}
	return value, true
}

// randomString mirrors Better Auth's id alphabet (alphanumeric, 32
// chars) so rows the Go server writes are indistinguishable from rows
// the TS server wrote.
const idAlphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

func NewID() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err) // crypto/rand failing is unrecoverable
	}
	for i, v := range b {
		b[i] = idAlphabet[int(v)%len(idAlphabet)]
	}
	return string(b)
}

// NewBearerToken mints an `nm_…` token (warm-store/index.ts
// generateBearerToken: 32 random bytes, base64url, no padding).
func NewBearerToken() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return "nm_" + base64.RawURLEncoding.EncodeToString(b)
}

// HashToken is the at-rest form of a bearer token (sha256 hex).
func HashToken(plaintext string) string {
	sum := sha256.Sum256([]byte(plaintext))
	return hex.EncodeToString(sum[:])
}

// ─── Per-account attempt limiter ───────────────────────────────────────
// http.ts: 5 failures per key inside a 15-minute window → 429 with
// Retry-After until the window expires.

const (
	failMax      = 5
	failWindow   = 15 * time.Minute
	failMapLimit = 1024
)

type failEntry struct {
	count   int
	resetAt time.Time
}

type Limiter struct {
	mu sync.Mutex
	m  map[string]failEntry
}

func NewLimiter() *Limiter { return &Limiter{m: map[string]failEntry{}} }

// Locked reports the retry-after seconds when the key is over the
// threshold, or 0 to proceed.
func (l *Limiter) Locked(key string) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	e, ok := l.m[key]
	now := time.Now()
	if !ok || !e.resetAt.After(now) {
		delete(l.m, key)
		return 0
	}
	if e.count < failMax {
		return 0
	}
	if s := int(e.resetAt.Sub(now).Seconds()) + 1; s > 1 {
		return s
	}
	return 1
}

func (l *Limiter) RecordFailure(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	if len(l.m) >= failMapLimit {
		for k, v := range l.m {
			if !v.resetAt.After(now) {
				delete(l.m, k)
			}
		}
	}
	e, ok := l.m[key]
	if !ok || !e.resetAt.After(now) {
		l.m[key] = failEntry{count: 1, resetAt: now.Add(failWindow)}
		return
	}
	e.count++
	l.m[key] = e
}

func (l *Limiter) Clear(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.m, key)
}
