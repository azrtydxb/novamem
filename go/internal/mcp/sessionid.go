package mcp

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"strings"
	"time"
)

// Streamable session ids are stateless and self-authenticating so that
// any replica can serve any request (ADR 0005). A streamable session
// holds no server state — handleMessage reads only sess.userID, which
// the auth middleware re-derives from the bearer on every request — so
// the registry entry exists purely for idle reaping and the per-user
// cap. An id therefore carries its own proof of who it belongs to:
//
//	id  = base64url(nonce16 || issuedAtMs8) "." base64url(tag16)
//	tag = HMAC-SHA256(key, nonce16 || issuedAtMs8 || userID)[:16]
//
// A replica that has never seen an id recomputes the tag from the
// *caller's own* authenticated userID. Binding the tag to the user is
// what makes assertion safe: an id cannot be minted for, or replayed
// as, anyone else, so it can never be used to displace another user's
// session (see the ADR's security review).
const (
	// sessionIDKeyLabel domain-separates the signing subkey from cookie
	// signing, so the same NOVAMEM_COOKIE_SECRET cannot produce a value
	// valid in both places.
	sessionIDKeyLabel = "novamem/mcp-session-id/v1"

	// sessionIDMaxAge bounds how long an id stays adoptable. Defence in
	// depth only: an id grants nothing without a live bearer for the
	// same user, so revoking the token is the real control.
	sessionIDMaxAge = 24 * time.Hour

	sessionIDNonceLen   = 16
	sessionIDPayloadLen = sessionIDNonceLen + 8 // nonce || issuedAtMs
	sessionIDTagLen     = 16
)

// Strict() rejects non-canonical encodings. Without it the trailing
// unused bits of the last base64 character are ignored, so several
// distinct id strings decode to the same bytes and all verify — an id
// would not have one canonical spelling.
var sessionIDEnc = base64.RawURLEncoding.Strict()

// deriveSessionKey returns the signing subkey for session ids, or nil
// when no secret is configured (auth_mode=none). A nil key disables
// minting signed ids and, with it, cross-replica adoption.
func deriveSessionKey(cookieSecret string) []byte {
	if cookieSecret == "" {
		return nil
	}
	m := hmac.New(sha256.New, []byte(cookieSecret))
	m.Write([]byte(sessionIDKeyLabel))
	return m.Sum(nil)
}

func sessionIDTag(key, payload []byte, userID string) []byte {
	m := hmac.New(sha256.New, key)
	m.Write(payload)
	m.Write([]byte(userID))
	return m.Sum(nil)[:sessionIDTagLen]
}

// mintSessionID issues a signed id bound to userID. With a nil key it
// falls back to an unverifiable random id (today's behaviour).
func mintSessionID(key []byte, userID string, now time.Time) string {
	if key == nil {
		return newSessionID()
	}
	payload := make([]byte, sessionIDPayloadLen)
	if _, err := rand.Read(payload[:sessionIDNonceLen]); err != nil {
		panic(err) // crypto/rand failure is unrecoverable
	}
	binary.BigEndian.PutUint64(payload[sessionIDNonceLen:], uint64(now.UnixMilli()))
	return sessionIDEnc.EncodeToString(payload) + "." +
		sessionIDEnc.EncodeToString(sessionIDTag(key, payload, userID))
}

// verifySessionID reports whether id is one this deployment minted for
// userID and is still within sessionIDMaxAge. It is the whole basis for
// adopting a session a replica has never seen, so it fails closed: no
// key, wrong shape, wrong user, tampered payload, or too old → false.
func verifySessionID(key []byte, userID, id string, now time.Time) bool {
	if key == nil {
		return false
	}
	rawPayload, rawTag, found := strings.Cut(id, ".")
	if !found {
		return false
	}
	payload, err := sessionIDEnc.DecodeString(rawPayload)
	if err != nil || len(payload) != sessionIDPayloadLen {
		return false
	}
	tag, err := sessionIDEnc.DecodeString(rawTag)
	if err != nil || len(tag) != sessionIDTagLen {
		return false
	}
	if !hmac.Equal(tag, sessionIDTag(key, payload, userID)) {
		return false
	}
	issued := time.UnixMilli(int64(binary.BigEndian.Uint64(payload[sessionIDNonceLen:])))
	// Reject the future too: a clock-skewed or crafted issuedAt must not
	// buy an id a lifetime beyond the cap.
	if now.Sub(issued) > sessionIDMaxAge || issued.After(now.Add(sessionIDMaxAge)) {
		return false
	}
	return true
}
