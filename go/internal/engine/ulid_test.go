package engine

import (
	"regexp"
	"strings"
	"testing"
	"time"
)

var ulidRe = regexp.MustCompile(`^[0-9A-HJKMNP-TV-Z]{26}$`)

func TestULIDShape(t *testing.T) {
	id := NewULID()
	if !ulidRe.MatchString(id) {
		t.Fatalf("not a Crockford-base32 ULID: %q", id)
	}
}

func TestULIDTimestampEncoding(t *testing.T) {
	// Known vector: the ulid spec's epoch encoding. At t=0 the time part
	// is all zeros.
	id := ulidAt(time.UnixMilli(0))
	if !strings.HasPrefix(id, "0000000000") {
		t.Fatalf("epoch ULID time prefix wrong: %q", id)
	}
	// Time ordering: ids minted a millisecond apart sort by prefix.
	a := ulidAt(time.UnixMilli(1_000_000))
	b := ulidAt(time.UnixMilli(2_000_000))
	if !(a[:10] < b[:10]) {
		t.Fatalf("time prefixes not ordered: %q vs %q", a[:10], b[:10])
	}
}

func TestULIDUniqueness(t *testing.T) {
	seen := make(map[string]bool, 10_000)
	for i := 0; i < 10_000; i++ {
		id := NewULID()
		if seen[id] {
			t.Fatalf("duplicate ULID: %q", id)
		}
		seen[id] = true
	}
}
