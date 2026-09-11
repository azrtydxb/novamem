package mcp

import (
	"strings"
	"testing"
)

func TestCheckOrigin(t *testing.T) {
	tests := []struct {
		name    string
		origin  string
		allowed []string
		wantOK  bool
	}{
		{"missing origin passes", "", nil, true},
		{"missing origin passes with allowlist", "", []string{"http://a"}, true},
		{"allowlisted passes", "http://localhost:5173", []string{"http://localhost:5173"}, true},
		{"wildcard passes anything", "https://evil.example.com", []string{"*"}, true},
		{"unlisted rejected", "https://evil.example.com", []string{"http://localhost:5173"}, false},
		{"empty allowlist rejects any origin", "http://localhost:5173", []string{}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reason := CheckOrigin(tt.origin, tt.allowed)
			if (reason == "") != tt.wantOK {
				t.Fatalf("CheckOrigin(%q, %v) = %q, wantOK=%v", tt.origin, tt.allowed, reason, tt.wantOK)
			}
			if !tt.wantOK && !strings.Contains(reason, "not in allowlist") {
				t.Fatalf("rejection reason %q missing contract text", reason)
			}
		})
	}
}

func TestCheckProtocolVersion(t *testing.T) {
	for _, v := range SupportedProtocolVersions {
		if reason := CheckProtocolVersion(v); reason != "" {
			t.Fatalf("supported version %q rejected: %s", v, reason)
		}
	}
	if reason := CheckProtocolVersion(""); reason != "" {
		t.Fatalf("missing header must pass, got %q", reason)
	}
	reason := CheckProtocolVersion("1999-01-01")
	if reason == "" {
		t.Fatal("unsupported version must be rejected")
	}
	// The message enumerates the supported surface, both eras.
	want := "unsupported MCP-Protocol-Version '1999-01-01' — server speaks 2024-11-05, 2025-06-18, 2025-11-25, 2026-07-28"
	if reason != want {
		t.Fatalf("message drifted:\n got  %s\n want %s", reason, want)
	}
}

// The advertised surface is a promise, so pin it: every entry has to be
// a revision this server actually implements.
func TestSupportedVersionListPinned(t *testing.T) {
	if got := strings.Join(SupportedProtocolVersions, ", "); got != "2024-11-05, 2025-06-18, 2025-11-25, 2026-07-28" {
		t.Fatalf("advertised version surface changed: %s", got)
	}
	// 2025-03-26 is the one revision requiring receipt of JSON-RPC
	// batches, which this server does not implement. Advertising it
	// would be a false claim (ADR 0006).
	if supportedProtocolVersion("2025-03-26") {
		t.Error("2025-03-26 must not be advertised while batches are unsupported")
	}
	for _, v := range LegacyProtocolVersions {
		if isModernVersion(v) {
			t.Errorf("%s is in both era lists", v)
		}
	}
	if latestLegacyVersion() != "2025-11-25" {
		t.Errorf("latestLegacyVersion() = %s", latestLegacyVersion())
	}
}
