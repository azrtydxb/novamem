package mcp

import (
	"net/http"
	"strings"
	"testing"
	"time"
)

const testCookieSecret = "adr0005-session-id-secret-0123456789" // gitleaks:allow — test key material, not a live secret

func TestSessionIDMintVerify(t *testing.T) {
	key := deriveSessionKey(testCookieSecret)
	now := time.Now()
	id := mintSessionID(key, "user-a", now)

	if !verifySessionID(key, "user-a", id, now) {
		t.Fatal("a freshly minted id did not verify for its own user")
	}
	// The tag binds the user: this is what stops one caller asserting
	// another's session id (ADR 0005 security review).
	if verifySessionID(key, "user-b", id, now) {
		t.Error("id minted for user-a verified for user-b")
	}
	if verifySessionID(deriveSessionKey("a-completely-different-secret"), "user-a", id, now) {
		t.Error("id verified under the wrong deployment key")
	}
	if verifySessionID(nil, "user-a", id, now) {
		t.Error("id verified with no key configured")
	}
	if !strings.Contains(id, ".") {
		t.Fatalf("id %q is not payload.tag shaped", id)
	}
}

func TestSessionIDRejectsTamperedAndStale(t *testing.T) {
	key := deriveSessionKey(testCookieSecret)
	now := time.Now()
	id := mintSessionID(key, "user-a", now)
	payload, tag, _ := strings.Cut(id, ".")

	for name, bad := range map[string]string{
		"no separator":   payload + tag,
		"empty":          "",
		"tag only":       "." + tag,
		"payload only":   payload + ".",
		"flipped tag":    payload + "." + flipLast(tag),
		"flipped nonce":  flipLast(payload) + "." + tag,
		"not base64":     "!!!.###",
		"short payload":  sessionIDEnc.EncodeToString([]byte("tooshort")) + "." + tag,
		"legacy uuid id": newSessionID(),
		// Non-canonical base64: the last tag character's unused bits
		// changed. Strict decoding must reject it rather than treat it
		// as a second valid spelling of the same id.
		"non-canonical tag": payload + "." + noncanonical(tag),
	} {
		if verifySessionID(key, "user-a", bad, now) {
			t.Errorf("%s: %q verified", name, bad)
		}
	}

	// issuedAt is inside the signed payload, so age is enforced without
	// the server remembering anything.
	old := mintSessionID(key, "user-a", now.Add(-sessionIDMaxAge-time.Minute))
	if verifySessionID(key, "user-a", old, now) {
		t.Error("an id older than sessionIDMaxAge was accepted")
	}
	if !verifySessionID(key, "user-a", mintSessionID(key, "user-a", now.Add(-sessionIDMaxAge+time.Minute)), now) {
		t.Error("an id inside sessionIDMaxAge was rejected")
	}
	// A future issuedAt must not buy extra lifetime.
	if verifySessionID(key, "user-a", mintSessionID(key, "user-a", now.Add(2*sessionIDMaxAge)), now) {
		t.Error("an id issued far in the future was accepted")
	}
}

// flipLast flips a bit in the decoded bytes rather than in the base64
// text: the last character of a 22-char tag carries only two
// significant bits, so editing the text can re-encode to identical
// bytes and legitimately still verify.
// noncanonical returns the same tag bytes spelled with non-zero unused
// trailing bits.
func noncanonical(tag string) string {
	alphabet := "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
	last := tag[len(tag)-1]
	i := strings.IndexByte(alphabet, last)
	// Same top 2 bits, different low 4 — identical decoded bytes under a
	// lenient decoder.
	return tag[:len(tag)-1] + string(alphabet[(i&0x30)|((i+1)&0x0f)])
}

func flipLast(s string) string {
	b, err := sessionIDEnc.DecodeString(s)
	if err != nil || len(b) == 0 {
		return "not-base64!"
	}
	b[len(b)-1] ^= 0x01
	return sessionIDEnc.EncodeToString(b)
}

// The regression this whole change exists for: initialize on one replica,
// use the session on another. Two Servers sharing a cookie secret are
// exactly two pods behind a round-robin load balancer.
func TestStreamableSessionCrossesReplicas(t *testing.T) {
	podA := testServer(t, Options{CookieSecret: testCookieSecret})
	podB := testServer(t, Options{CookieSecret: testCookieSecret})

	sid := openSession(t, streamableHandler(podA, "user-a"))
	if sid == "" {
		t.Fatal("no session id returned")
	}

	// 20 calls to the replica that never saw the initialize.
	hB := streamableHandler(podB, "user-a")
	for i := 0; i < 20; i++ {
		rec := post(t, hB, `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`,
			map[string]string{"Mcp-Session-Id": sid})
		if rec.Code != http.StatusOK {
			t.Fatalf("call %d to the other replica: got %d, want 200\n%s", i+1, rec.Code, rec.Body)
		}
	}
	if got := podB.streamable.countForUser("user-a"); got != 1 {
		t.Errorf("podB holds %d sessions for the user, want 1 adopted once and reused", got)
	}
}

func TestStreamableSessionRejectedByForeignDeployment(t *testing.T) {
	mine := testServer(t, Options{CookieSecret: testCookieSecret})
	theirs := testServer(t, Options{CookieSecret: "some-other-deployments-secret"})

	sid := openSession(t, streamableHandler(mine, "user-a"))
	rec := post(t, streamableHandler(theirs, "user-a"), `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`,
		map[string]string{"Mcp-Session-Id": sid})
	if rec.Code != http.StatusNotFound {
		t.Fatalf("got %d, want 404 — an id from another deployment must not be adopted", rec.Code)
	}
}

// Adoption must not let one user take over another's session id: that
// would 403 the rightful owner off the replica (ADR 0005 security review).
func TestAdoptionDoesNotLetAnotherUserClaimASession(t *testing.T) {
	podA := testServer(t, Options{CookieSecret: testCookieSecret})
	podB := testServer(t, Options{CookieSecret: testCookieSecret})

	sid := openSession(t, streamableHandler(podA, "victim"))

	rec := post(t, streamableHandler(podB, "attacker"), `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`,
		map[string]string{"Mcp-Session-Id": sid})
	if rec.Code != http.StatusNotFound {
		t.Fatalf("attacker asserting the victim's id on a fresh replica: got %d, want 404", rec.Code)
	}
	if n := podB.streamable.countForUser("attacker"); n != 0 {
		t.Fatalf("the attacker's assertion created %d session(s) on podB", n)
	}
	// The victim can still use their own session on that replica.
	if rec := post(t, streamableHandler(podB, "victim"), `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`,
		map[string]string{"Mcp-Session-Id": sid}); rec.Code != http.StatusOK {
		t.Fatalf("victim locked out of podB: got %d, want 200\n%s", rec.Code, rec.Body)
	}
}

// With no secret (auth_mode=none) behaviour is unchanged: ids stay
// process-local and an unknown id is still a 404.
func TestWithoutCookieSecretSessionsStayProcessLocal(t *testing.T) {
	podA := testServer(t, Options{})
	podB := testServer(t, Options{})

	sid := openSession(t, streamableHandler(podA, "user-a"))
	rec := post(t, streamableHandler(podB, "user-a"), `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`,
		map[string]string{"Mcp-Session-Id": sid})
	if rec.Code != http.StatusNotFound {
		t.Fatalf("got %d, want 404 (unsigned ids must not be adoptable)", rec.Code)
	}
}

// The per-user cap still bounds one replica's map when every session
// arrives by adoption rather than by initialize.
func TestAdoptionRespectsPerUserCap(t *testing.T) {
	key := deriveSessionKey(testCookieSecret)
	pod := testServer(t, Options{CookieSecret: testCookieSecret, MaxSessionsPerUser: 2})
	h := streamableHandler(pod, "user-a")

	for i := 0; i < 2; i++ {
		id := mintSessionID(key, "user-a", time.Now())
		if rec := post(t, h, `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`,
			map[string]string{"Mcp-Session-Id": id}); rec.Code != http.StatusOK {
			t.Fatalf("adopt %d: got %d, want 200", i+1, rec.Code)
		}
	}
	id := mintSessionID(key, "user-a", time.Now())
	if rec := post(t, h, `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`,
		map[string]string{"Mcp-Session-Id": id}); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("third adopt: got %d, want 429", rec.Code)
	}
}
