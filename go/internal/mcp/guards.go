// Per-request spec guards for the HTTP transports: Origin validation
// (DNS-rebinding defence; 403) and protocol-version negotiation. Both
// are MUSTs in every revision this server speaks.
package mcp

import (
	"fmt"
	"net/http"
	"strings"
)

// The revisions this server speaks, oldest first — the guard message and
// the UnsupportedProtocolVersionError's `supported` list join them in
// this order.
//
// The list spans two eras (ADR 0006). Legacy revisions open a session
// with an `initialize` handshake; modern revisions carry version,
// identity and capabilities as per-request `_meta` and are served
// statelessly. This server is dual-era: it serves both on one endpoint
// and picks per request.
//
// 2025-03-26 is deliberately absent. It is the one revision that
// requires implementations to *receive* JSON-RPC batches, which this
// server does not do, so advertising it would be a false claim.
// Batching was removed again in 2025-06-18, and 2024-11-05 never
// required it. Clients predating the MCP-Protocol-Version header
// (introduced 2025-06-18) are unaffected: they send no header, and a
// headerless request is still served.
var (
	LegacyProtocolVersions = []string{"2024-11-05", "2025-06-18", "2025-11-25"}
	ModernProtocolVersions = []string{"2026-07-28"}

	SupportedProtocolVersions = append(
		append([]string{}, LegacyProtocolVersions...), ModernProtocolVersions...)
)

func supportedProtocolVersion(v string) bool {
	for _, s := range SupportedProtocolVersions {
		if s == v {
			return true
		}
	}
	return false
}

func isModernVersion(v string) bool {
	for _, s := range ModernProtocolVersions {
		if s == v {
			return true
		}
	}
	return false
}

// latestLegacyVersion is what an `initialize` handshake falls back to
// when the client asks for a revision we do not speak. It must never be
// a modern version: a legacy client told "2026-07-28" would be handed a
// revision that has no handshake to conduct.
func latestLegacyVersion() string {
	return LegacyProtocolVersions[len(LegacyProtocolVersions)-1]
}

// CheckOrigin returns "" when the request passes (no Origin header /
// wildcard / allowlisted), else the rejection reason. Never compare
// Origin to Host — Host is attacker-controlled under DNS rebinding.
func CheckOrigin(origin string, allowedOrigins []string) string {
	if origin == "" {
		return ""
	}
	for _, a := range allowedOrigins {
		if a == "*" || a == origin {
			return ""
		}
	}
	return fmt.Sprintf("origin '%s' not in allowlist", origin)
}

// CheckProtocolVersion returns "" when the request passes (missing
// header / known version), else the rejection reason.
func CheckProtocolVersion(value string) string {
	if value == "" || supportedProtocolVersion(value) {
		return ""
	}
	return fmt.Sprintf("unsupported MCP-Protocol-Version '%s' — server speaks %s",
		value, strings.Join(SupportedProtocolVersions, ", "))
}

// applyGuards writes the guard error bodies and returns false when the
// caller should bail out.
func (s *Server) applyGuards(w http.ResponseWriter, r *http.Request) bool {
	if reason := CheckOrigin(r.Header.Get("Origin"), s.allowedOrigins); reason != "" {
		s.log.Warn("mcp-guard: "+reason, "origin", r.Header.Get("Origin"), "host", r.Host)
		writeRPCGuardErr(w, http.StatusForbidden, "Forbidden: "+reason)
		return false
	}
	if reason := CheckProtocolVersion(r.Header.Get("Mcp-Protocol-Version")); reason != "" {
		s.log.Warn("mcp-guard: " + reason)
		writeUnsupportedVersion(w, r.Header.Get("Mcp-Protocol-Version"))
		return false
	}
	return true
}

// writeUnsupportedVersion emits the spec's UnsupportedProtocolVersionError
// with the list a client should retry from.
//
// The code matters beyond diagnostics: a dual-era client treats a
// recognized modern error as "this server is modern, retry with one of
// its versions" and anything else as "fall back to the initialize
// handshake". Returning the specified code is therefore what stops a
// modern client from needlessly downgrading.
func writeUnsupportedVersion(w http.ResponseWriter, requested string) {
	writeJSON(w, http.StatusBadRequest, rpcObj{
		{"jsonrpc", "2.0"},
		{"id", nil},
		{"error", rpcObj{
			{"code", codeUnsupportedProtocolVersion},
			{"message", "Unsupported protocol version"},
			{"data", rpcObj{
				{"supported", SupportedProtocolVersions},
				{"requested", requested},
			}},
		}},
	})
}

func writeRPCGuardErr(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, rpcErrEnvelope(-32000, message))
}
