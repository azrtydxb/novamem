// Modern-era MCP: revision 2026-07-28 (ADR 0006).
//
// The modern era removed the `initialize` handshake, protocol-level
// sessions, the standalone GET stream, resumability and `ping`. Every
// request declares its own protocol version in `params._meta`, mirrors
// selected body fields into HTTP headers, and is served on its own —
// there is no connection state to carry. `server/discover` replaces the
// handshake as the way a client learns what a server speaks.
//
// This file is additive: the legacy handshake in transport.go is
// untouched, and each POST picks its era per the spec's dual-era rules
// (an `initialize` selects legacy; per-request modern metadata selects
// modern).
package mcp

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
)

const (
	// _meta keys defined by the spec. The prefix is mandatory and
	// reserved for the protocol itself.
	metaProtocolVersion = "io.modelcontextprotocol/protocolVersion"
	metaServerInfo      = "io.modelcontextprotocol/serverInfo"

	// Error codes from the range the spec reserves for itself
	// (-32020..-32099). -32000..-32019 stays implementation-defined,
	// which is what the legacy guard bodies use.
	codeHeaderMismatch             = -32020
	codeUnsupportedProtocolVersion = -32022

	discoverMethod = "server/discover"

	// resultTypeComplete marks an ordinary result. The other value,
	// "input_required", belongs to multi-round-trip requests — this
	// server never needs client input mid-call, so it never emits one.
	resultTypeComplete = "complete"

	// tools/list is a compile-time constant array, identical for every
	// caller, so it is cacheable and public. One hour is a hint, not a
	// promise; `listChanged: false` already says the list is frozen.
	toolsListTTLMs      = 3_600_000
	toolsListCacheScope = "public"

	// The spec's encoding for header values that cannot be carried as
	// plain ASCII.
	b64SentinelPrefix = "=?base64?"
	b64SentinelSuffix = "?="
)

// modernParams is the slice of a request body that the modern era reads.
type modernParams struct {
	Name      string                     `json:"name"`
	Arguments map[string]any             `json:"arguments"`
	Meta      map[string]json.RawMessage `json:"_meta"`
}

// declaredVersion is the protocol version this request declares, or ""
// when it declares none.
func (p modernParams) declaredVersion() string {
	raw, ok := p.Meta[metaProtocolVersion]
	if !ok {
		return ""
	}
	var v string
	if json.Unmarshal(raw, &v) != nil {
		return ""
	}
	return v
}

// classifyEra parses a POST body and reports whether it belongs to the
// modern era. Per the spec's dual-era rules an `initialize` selects
// legacy semantics, while per-request modern metadata selects modern;
// `server/discover` exists only in the modern era, so it selects modern
// on its own (and is then held to the modern header requirements, which
// is how a client learns what it got wrong).
func classifyEra(headerVersion string, body []byte) (*rpcRequest, modernParams, bool) {
	var req rpcRequest
	var p modernParams
	if json.Unmarshal(body, &req) != nil {
		return nil, p, false // malformed: let the legacy path emit -32700
	}
	if len(req.Params) > 0 {
		_ = json.Unmarshal(req.Params, &p)
	}
	switch {
	case req.Method == "initialize":
		return &req, p, false
	case req.Method == discoverMethod:
		return &req, p, true
	case isModernVersion(p.declaredVersion()):
		return &req, p, true
	case isModernVersion(headerVersion):
		return &req, p, true
	}
	return &req, p, false
}

// serveModern handles one modern-era POST. It never touches the session
// registries: the revision has no session concept, and the caller's
// identity comes from the bearer on this very request.
func (s *Server) serveModern(w http.ResponseWriter, r *http.Request, userID string,
	req *rpcRequest, p modernParams) {

	// Header/body agreement. Intermediaries may route or rate-limit on
	// the mirrored headers while this server executes the body, so a
	// disagreement is a security problem rather than an inconsistency.
	if msg := checkModernHeaders(r, req, p); msg != "" {
		writeModernErr(w, http.StatusBadRequest, req.ID, codeHeaderMismatch, msg, nil)
		return
	}
	if v := p.declaredVersion(); !isModernVersion(v) {
		// Reached only when the declared version is absent or non-modern
		// but something else routed us here.
		writeUnsupportedVersionRPC(w, req.ID, v)
		return
	}
	if len(req.ID) == 0 {
		// Notification: accepted, nothing to answer. The core revision
		// defines no client-to-server notifications over HTTP, but the
		// transport mechanics are specified, so honour them.
		w.WriteHeader(http.StatusAccepted)
		return
	}

	switch req.Method {
	case discoverMethod:
		writeJSON(w, http.StatusOK, okResponse(req.ID, s.discoverResult()))
	case "tools/list":
		writeJSON(w, http.StatusOK, okResponse(req.ID, rpcObj{
			{"resultType", resultTypeComplete},
			{"tools", ToolDefinitions()},
			{"ttlMs", toolsListTTLMs},
			{"cacheScope", toolsListCacheScope},
			{"_meta", s.serverInfoMeta()},
		}))
	case "tools/call":
		if p.Name == "" {
			writeJSON(w, http.StatusOK, errResponse(req.ID, -32602, "Invalid params"))
			return
		}
		res := s.callTool(r.Context(), userID, p.Name, p.Arguments)
		out := rpcObj{{"resultType", resultTypeComplete}, {"content", res.Content}}
		if res.IsError {
			out = append(out, rpcKV{"isError", true})
		}
		out = append(out, rpcKV{"_meta", s.serverInfoMeta()})
		writeJSON(w, http.StatusOK, okResponse(req.ID, out))
	default:
		// The modern era requires 404 for an unimplemented method, with
		// the JSON-RPC body distinguishing it from a 404 served by
		// something that is not an MCP endpoint at all. `ping`,
		// `logging/setLevel` and the resource/prompt surfaces land here.
		writeJSON(w, http.StatusNotFound, errResponse(req.ID, -32601, "Method not found"))
	}
}

// checkModernHeaders returns "" when the mirrored headers are present
// and agree with the body, else the mismatch to report.
func checkModernHeaders(r *http.Request, req *rpcRequest, p modernParams) string {
	hdrVersion := r.Header.Get("Mcp-Protocol-Version")
	if hdrVersion == "" {
		return "missing required header MCP-Protocol-Version"
	}
	declared := p.declaredVersion()
	if declared == "" {
		return "missing required _meta field " + metaProtocolVersion
	}
	if hdrVersion != declared {
		return "MCP-Protocol-Version header value '" + hdrVersion +
			"' does not match body value '" + declared + "'"
	}
	hdrMethod := r.Header.Get("Mcp-Method")
	if hdrMethod == "" {
		return "missing required header Mcp-Method"
	}
	if hdrMethod != req.Method {
		return "Mcp-Method header value '" + hdrMethod +
			"' does not match body value '" + req.Method + "'"
	}
	if req.Method == "tools/call" {
		raw := r.Header.Get("Mcp-Name")
		if raw == "" {
			return "missing required header Mcp-Name"
		}
		name, ok := decodeHeaderSentinel(raw)
		if !ok {
			return "Mcp-Name header value is not valid " + b64SentinelPrefix + " encoding"
		}
		if name != p.Name {
			return "Mcp-Name header value '" + name +
				"' does not match body value '" + p.Name + "'"
		}
	}
	return ""
}

// decodeHeaderSentinel undoes the spec's =?base64?…?= header encoding,
// used for values that cannot travel as plain ASCII. Values not in that
// form are returned as-is.
func decodeHeaderSentinel(v string) (string, bool) {
	if !strings.HasPrefix(v, b64SentinelPrefix) || !strings.HasSuffix(v, b64SentinelSuffix) {
		return v, true
	}
	inner := v[len(b64SentinelPrefix) : len(v)-len(b64SentinelSuffix)]
	b, err := base64.StdEncoding.DecodeString(inner)
	if err != nil {
		return "", false
	}
	return string(b), true
}

// discoverResult answers server/discover: what this server speaks, what
// it can do, and who it is. Both eras' versions are advertised — a
// dual-era server that hid its legacy revisions would strand clients
// that can only speak them.
func (s *Server) discoverResult() rpcObj {
	return rpcObj{
		{"resultType", resultTypeComplete},
		{"supportedVersions", SupportedProtocolVersions},
		{"capabilities", rpcObj{{"tools", rpcObj{{"listChanged", false}}}}},
		{"instructions", s.instructions},
		{"ttlMs", toolsListTTLMs},
		{"cacheScope", toolsListCacheScope},
		{"_meta", s.serverInfoMeta()},
	}
}

func (s *Server) serverInfoMeta() rpcObj {
	return rpcObj{{metaServerInfo, rpcObj{
		{"name", serverName}, {"version", serverVersion}}}}
}

// writeModernErr emits a JSON-RPC error in the spec's field order.
func writeModernErr(w http.ResponseWriter, status int, id json.RawMessage,
	code int, message string, data any) {

	e := rpcObj{{"code", code}, {"message", message}}
	if data != nil {
		e = append(e, rpcKV{"data", data})
	}
	var idVal any
	if len(id) > 0 {
		idVal = id
	}
	writeJSON(w, status, rpcObj{{"jsonrpc", "2.0"}, {"id", idVal}, {"error", e}})
}

// writeUnsupportedVersionRPC is writeUnsupportedVersion for a request
// whose id is known, so the client can correlate the rejection.
func writeUnsupportedVersionRPC(w http.ResponseWriter, id json.RawMessage, requested string) {
	writeModernErr(w, http.StatusBadRequest, id,
		codeUnsupportedProtocolVersion, "Unsupported protocol version",
		rpcObj{{"supported", SupportedProtocolVersions}, {"requested", requested}})
}
