// Per-request spec guards for the HTTP transports. Transcribed from
// routes/mcp-spec-guards.ts — two MUSTs from the MCP 2025-11-25 spec:
// Origin validation (DNS-rebinding defence; 403) and the
// MCP-Protocol-Version header (unsupported → 400; missing allowed).
package mcp

import (
	"fmt"
	"net/http"
	"strings"
)

// SupportedProtocolVersions — the exact list from mcp-spec-guards.ts,
// in insertion order (the 400 message joins them in this order).
var SupportedProtocolVersions = []string{
	"2024-11-05",
	"2025-03-26",
	"2025-06-18",
	"2025-11-25",
}

func supportedProtocolVersion(v string) bool {
	for _, s := range SupportedProtocolVersions {
		if s == v {
			return true
		}
	}
	return false
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

// applyGuards writes the TS guard error bodies (JSON-RPC-shaped, id
// null) and returns false when the caller should bail out.
func (s *Server) applyGuards(w http.ResponseWriter, r *http.Request) bool {
	if reason := CheckOrigin(r.Header.Get("Origin"), s.allowedOrigins); reason != "" {
		s.log.Warn("mcp-guard: "+reason, "origin", r.Header.Get("Origin"), "host", r.Host)
		writeRPCGuardErr(w, http.StatusForbidden, "Forbidden: "+reason)
		return false
	}
	if reason := CheckProtocolVersion(r.Header.Get("Mcp-Protocol-Version")); reason != "" {
		writeRPCGuardErr(w, http.StatusBadRequest, "Bad Request: "+reason)
		return false
	}
	return true
}

func writeRPCGuardErr(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, rpcErrEnvelope(-32000, message))
}
