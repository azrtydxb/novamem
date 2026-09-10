package auth

import (
	"strings"
	"testing"
)

// Golden vectors captured from the live bench deployment before this
// package existed: a Better Auth account row written by the TypeScript
// server, and the session cookie that server handed back on sign-in. If
// either format assumption drifts, these fail — which is the whole point
// (a drift means every existing password or session breaks at cutover).
const (
	tsPassword = "Slice5-Bench-Pass!"
	tsHash     = "f65970f32c94865525be24884b5106e2:" +
		"09dbfc80bce5106a4ad04995349393129665b8d7fefd62f4b223149261bb929b" +
		"7af4e089816db0485c1b2103a6b15ab863ee05969ded2a486b5a2e1330e08981"

	tsCookieSecret = "conformance-slice5-cookie-secret-0123456789" // gitleaks:allow — golden test vector, not a live secret
	tsSessionToken = "ySeO74P1FwlxrMcDsCXTG8pY2wWmMLWm"            // gitleaks:allow — golden test vector, not a live secret
	tsSignedCookie = tsSessionToken + ".ziJbBC1afNAz8xD9JpLeb17J6HmAoGxYIhmcVCYYdyo="
)

func TestVerifyPasswordAgainstBetterAuthHash(t *testing.T) {
	if !VerifyPassword(tsHash, tsPassword) {
		t.Fatal("Better Auth scrypt hash did not verify — password compatibility broken")
	}
	if VerifyPassword(tsHash, tsPassword+"x") {
		t.Fatal("wrong password verified")
	}
	for _, malformed := range []string{"", "nocolon", ":", "abc:zznothex"} {
		if VerifyPassword(malformed, tsPassword) {
			t.Fatalf("malformed hash %q verified", malformed)
		}
	}
}

func TestCookieSignature(t *testing.T) {
	if got := SignCookie(tsCookieSecret, tsSessionToken); got != tsSignedCookie {
		t.Fatalf("cookie signature mismatch:\n got %q\nwant %q", got, tsSignedCookie)
	}
	tok, ok := VerifyCookie(tsCookieSecret, tsSignedCookie)
	if !ok || tok != tsSessionToken {
		t.Fatalf("VerifyCookie(%q) = %q, %v", tsSignedCookie, tok, ok)
	}
	if _, ok := VerifyCookie("another-secret-entirely", tsSignedCookie); ok {
		t.Fatal("cookie verified under the wrong secret")
	}
	if _, ok := VerifyCookie(tsCookieSecret, tsSessionToken); ok {
		t.Fatal("unsigned cookie verified")
	}
}

func TestLimiterLocksAfterFiveFailures(t *testing.T) {
	l := NewLimiter()
	for i := 0; i < failMax-1; i++ {
		l.RecordFailure("k")
		if got := l.Locked("k"); got != 0 {
			t.Fatalf("locked after %d failures (want lock only at %d)", i+1, failMax)
		}
	}
	l.RecordFailure("k")
	if l.Locked("k") <= 0 {
		t.Fatal("not locked after the threshold")
	}
	if l.Locked("other") != 0 {
		t.Fatal("lock leaked across keys")
	}
	l.Clear("k")
	if l.Locked("k") != 0 {
		t.Fatal("Clear did not release the lock")
	}
}

// A hash this package produces must verify with the same parameters the
// TypeScript server (Better Auth) uses — that round-trip is the whole
// point of provisioning users natively.
func TestHashPasswordRoundTrip(t *testing.T) {
	stored, err := HashPassword("Go-Provisioned-Pass!9")
	if err != nil {
		t.Fatal(err)
	}
	salt, key, found := strings.Cut(stored, ":")
	if !found || len(salt) != 32 || len(key) != 128 {
		t.Fatalf("hash shape = %q, want 32-hex-char salt + 128-hex-char key", stored)
	}
	if !VerifyPassword(stored, "Go-Provisioned-Pass!9") {
		t.Error("VerifyPassword rejected a hash HashPassword produced")
	}
	if VerifyPassword(stored, "wrong") {
		t.Error("VerifyPassword accepted the wrong password")
	}
}
