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
	// The message enumerates the supported surface (mcp-spec-guards.ts).
	want := "unsupported MCP-Protocol-Version '1999-01-01' — server speaks 2024-11-05, 2025-03-26, 2025-06-18, 2025-11-25"
	if reason != want {
		t.Fatalf("message drifted:\n got  %s\n want %s", reason, want)
	}
}

func TestSupportedVersionListPinned(t *testing.T) {
	if len(SupportedProtocolVersions) != 4 {
		t.Fatalf("supported version surface changed: %v — update mcp-spec-guards.ts in lockstep", SupportedProtocolVersions)
	}
}
