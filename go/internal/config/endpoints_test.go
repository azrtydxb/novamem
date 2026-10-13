package config

import (
	"context"
	"errors"
	"net"
	"strings"
	"testing"
)

type staticResolver struct {
	addrs []net.IPAddr
	err   error
}

func (r staticResolver) LookupIPAddr(_ context.Context, _ string) ([]net.IPAddr, error) {
	return r.addrs, r.err
}

func TestValidateEndpointURL(t *testing.T) {
	tests := []struct {
		name, raw string
		resolver  staticResolver
		allow     bool
		wantErr   string
	}{
		{name: "https public", raw: "https://api.example.com/v1", resolver: staticResolver{}},
		{name: "private IPv4", raw: "http://192.168.10.125:4000", resolver: staticResolver{}},
		{name: "private IPv6", raw: "http://[fd00::1]:4000", resolver: staticResolver{}},
		{name: "loopback IPv4", raw: "http://127.0.0.1:4000", resolver: staticResolver{}},
		{name: "loopback IPv6", raw: "http://[::1]:4000", resolver: staticResolver{}},
		{name: "private DNS", raw: "http://qdrant.novamem.svc", resolver: staticResolver{addrs: []net.IPAddr{{IP: net.ParseIP("10.0.0.2")}}}},
		{name: "public DNS", raw: "http://api.example.com", resolver: staticResolver{addrs: []net.IPAddr{{IP: net.ParseIP("203.0.113.10")}}}, wantErr: "uses HTTP with a public host"},
		{name: "mixed DNS", raw: "http://api.example.com", resolver: staticResolver{addrs: []net.IPAddr{{IP: net.ParseIP("10.0.0.2")}, {IP: net.ParseIP("203.0.113.10")}}}, wantErr: "uses HTTP with a public host"},
		{name: "DNS failure", raw: "http://api.example.com", resolver: staticResolver{err: errors.New("offline")}, wantErr: "could not be resolved"},
		{name: "empty DNS answer", raw: "http://api.example.com", resolver: staticResolver{}, wantErr: "resolved to no addresses"},
		{name: "explicit escape hatch", raw: "http://api.example.com", resolver: staticResolver{err: errors.New("offline")}, allow: true},
		{name: "empty", raw: "", resolver: staticResolver{}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateEndpointURL("NOVAMEM_TEST_ENDPOINT", tt.raw, tt.allow, tt.resolver)
			if tt.wantErr == "" && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if tt.wantErr != "" && (err == nil || !strings.Contains(err.Error(), tt.wantErr)) {
				t.Fatalf("error = %v, want substring %q", err, tt.wantErr)
			}
		})
	}
}

func TestAuthNoneRequiresOptInGuard(t *testing.T) {
	_, err := loadWith(t, map[string]string{"NOVAMEM_AUTH_MODE": "none", "NOVAMEM_REQUIRE_AUTH": "1"})
	if err == nil || !strings.Contains(err.Error(), "NOVAMEM_REQUIRE_AUTH=1") {
		t.Fatalf("Load() error = %v, want auth guard refusal", err)
	}
	if _, err := loadWith(t, map[string]string{"NOVAMEM_AUTH_MODE": "none"}); err != nil {
		t.Fatalf("auth.mode=none without the opt-in guard should remain available: %v", err)
	}
}
