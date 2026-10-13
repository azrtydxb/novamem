// The redactor is the only thing standing between stored content and the
// extraction LLM, and it is regexes all the way down. Regexes fail by
// not matching, silently, so every rule gets its table: hits it must
// redact, prose it must leave alone, and the exact placeholder.
package engine

import (
	"regexp"
	"strings"
	"testing"
)

func TestRedactForExtraction(t *testing.T) {
	const longToken = "Ab3xY9kQ2mN8pR5tW7vZ4jL6hH1cB0dF"
	const longAlpha = "abcdefghijklmnopqrstuvwxyzABCDEF" // 32 letters, no digits

	for _, tc := range []struct {
		name string
		in   string
		want string
	}{
		// --- email ---
		{"plain email", "reach me at jane.doe@example.com please", "reach me at [EMAIL] please"},
		{"email with plus addressing", "p+watteel+1@sub.domain.co.uk", "[EMAIL]"},
		{"two emails in one line", "a@b.io and c@d.org", "[EMAIL] and [EMAIL]"},
		// An @ without a TLD is not an address; leave it.
		{"at-sign without a domain tld", "who? user@host, that's who", "who? user@host, that's who"},
		{"no email", "the quick brown fox", "the quick brown fox"},

		// --- IPv4 ---
		{"plain ipv4", "server at 192.168.10.100 down", "server at [IP] down"},
		{"ipv4 with prefix length", "10.0.0.5/32", "[IP]/32"},
		{"loopback", "bind 127.0.0.1", "bind [IP]"},
		// Out-of-range octets are not addresses.
		{"version-like numbers kept", "version 1.2.300.4 shipped", "version 1.2.300.4 shipped"},
		{"five octets kept", "1.2.3.4.5", "1.2.3.4.5"},

		// --- phone, international ---
		{"intl compact", "call +31612345678 today", "call [PHONE] today"},
		{"intl spaced", "call +31 6 1234 5678", "call [PHONE]"},
		{"intl dotted", "call +31.6.1234.5678", "call [PHONE]"},
		{"intl with parens", "+1 (555) 123-4567", "[PHONE]"},
		// A leading + with too few digits is not a phone number.
		{"plus with few digits kept", "c++17 is 5 years old", "c++17 is 5 years old"},

		// --- phone, local ---
		{"local dashed", "phone 555-123-4567", "phone [PHONE]"},
		{"local spaced", "phone 555 123 4567", "phone [PHONE]"},
		{"local parenthesised", "phone (555) 123-4567", "phone [PHONE]"},
		// No separator: an order id or a timestamp, not a phone.
		{"bare ten digits kept", "order 5551234567", "order 5551234567"},

		// --- secrets ---
		{"openai-style key", "key sk-abcdefghijklmnop1234567890", "key [SECRET]"},
		{"novamem token", "token nm_Ab3xY9kQ2mN8", "token [SECRET]"},
		{"bearer header", "Authorization: Bearer " + longToken, "Authorization: [SECRET]"},
		{"bare 32-char token", "digest " + longToken, "digest [SECRET]"},
		{"uuid is token-shaped", "id 7b3a9c4e2f8d1a6b5c0e9f8d7a6b5c4e", "id [SECRET]"},
		// 32 letters with no digit is a word run, not a credential.
		{"alphabet-only run kept", longAlpha + " still words", longAlpha + " still words"},
		// Shorter than 32: ordinary identifiers survive.
		{"short identifier kept", "build 2026-10-10-release", "build 2026-10-10-release"},
		{"ulid-like id kept", "entry 01J9XK3M5N7Q9R1S3T5V7W9XYZ", "entry 01J9XK3M5N7Q9R1S3T5V7W9XYZ"},

		// --- interaction between rules ---
		{"email is redacted before its long local part can look like a token",
			"from " + strings.Repeat("a1b2c3d4e5f6", 4) + "@example.com", "from [EMAIL]"},
		{"ipv4 wins over the phone rules", "node 192.168.1.100 and phone 555-123-4567",
			"node [IP] and phone [PHONE]"},
		{"combination", "mail jane@x.io, +31 6 1234 5678, sk-" + longToken + ", 10.0.0.1",
			"mail [EMAIL], [PHONE], [SECRET], [IP]"},

		// --- determinism and passthrough ---
		{"empty", "", ""},
		{"unchanged prose keeps punctuation", "hello, world! (twice)", "hello, world! (twice)"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := redactForExtraction(tc.in)
			if got != tc.want {
				t.Errorf("redactForExtraction(%q)\n  = %q\nwant %q", tc.in, got, tc.want)
			}
			// The property the whole feature rests on: redaction is a
			// pure function, so a second pass is a fixed point.
			if again := redactForExtraction(got); again != got {
				t.Errorf("not idempotent: %q -> %q", got, again)
			}
		})
	}
}

// A case-sensitive miss is a leak; a case-insensitive hit on prose is a
// false positive. Pin which case the credential rules accept.
func TestRedactorPrefixCaseSensitivity(t *testing.T) {
	for _, tc := range []struct {
		in   string
		want string
	}{
		{"sk-abcdef123456", "[SECRET]"},
		{"nm_abcdef123456", "[SECRET]"},
		{"SK-abcdef123456", "SK-abcdef123456"},
		{"NM_abcdef123456", "NM_abcdef123456"},
		{"bearer abcdefghijklmnop", "bearer abcdefghijklmnop"},
		{"Bearer abcdefghijklmnop", "[SECRET]"},
	} {
		if got := redactForExtraction(tc.in); got != tc.want {
			t.Errorf("redactForExtraction(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// The extension point: an appended rule runs after the built-ins, and a
// caller appending it gets its behaviour without touching the engine.
func TestExtraRedactorExtensionPoint(t *testing.T) {
	saved := extraRedactors
	t.Cleanup(func() { extraRedactors = saved })
	extraRedactors = append(extraRedactors, redactionRule{
		name: "account-number",
		re:   regexp.MustCompile(`acct-[0-9]{6}`),
		ph:   "[ACCOUNT]",
	})
	got := redactForExtraction("acct-123456 and jane@example.com")
	if got != "[ACCOUNT] and [EMAIL]" {
		t.Fatalf("extension rule not applied last-in-chain: %q", got)
	}
}
