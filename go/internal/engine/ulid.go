// ULID generation. The TS server uses the `ulid` npm package for entry
// ids; this is a stdlib transcription of the same format (26-char
// Crockford base32, 48-bit ms timestamp + 80-bit randomness). Per-process
// monotonicity within one millisecond is deliberately NOT reproduced —
// uniqueness is the requirement, and 80 random bits provide it.
package engine

import (
	"crypto/rand"
	"time"
)

const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

// NewULID returns a fresh ULID for the current time.
func NewULID() string {
	return ulidAt(time.Now())
}

func ulidAt(t time.Time) string {
	var b [16]byte
	ms := uint64(t.UnixMilli())
	b[0] = byte(ms >> 40)
	b[1] = byte(ms >> 32)
	b[2] = byte(ms >> 24)
	b[3] = byte(ms >> 16)
	b[4] = byte(ms >> 8)
	b[5] = byte(ms)
	if _, err := rand.Read(b[6:]); err != nil {
		// crypto/rand never fails on supported platforms; if it somehow
		// does, an id generator that returns garbage is worse than a crash.
		panic("ulid: crypto/rand failed: " + err.Error())
	}
	// 16 bytes = 128 bits → 26 base32 chars (the first encodes only 3 bits).
	var out [26]byte
	// Standard ULID bit layout: encode the 128-bit big-endian value in
	// 5-bit groups from the most significant end, left-padded to 130 bits.
	var hi, lo uint64
	for i := 0; i < 8; i++ {
		hi = hi<<8 | uint64(b[i])
		lo = lo<<8 | uint64(b[i+8])
	}
	for i := 25; i >= 0; i-- {
		out[i] = crockford[lo&31]
		lo = lo>>5 | (hi&31)<<59
		hi >>= 5
	}
	return string(out[:])
}
