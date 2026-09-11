// The Streamable HTTP transport: one endpoint, POST to open a session on
// initialize, `Mcp-Session-Id` on subsequent requests, a GET stream held
// open with keepalives, DELETE to terminate, and an idle reaper behind
// all of it. Status codes and error-body strings are contract.
//
// The HTTP+SSE pair from revision 2024-11-05 (`GET /mcp/sse` +
// `POST /mcp/messages?sessionId=`) used to live here too. It is
// Deprecated in the spec and removed — see ADR 0007.
package mcp

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/azrtydxb/novamem/go/internal/config"
)

// maxBodyBytes matches the TS server's global 2MB body limit.
const maxBodyBytes = 2 * 1024 * 1024

// keepaliveInterval — the comment-frame cadence on the streamable GET
// stream, comfortably under undici's 5-minute body-read timeout.
// Overridable per-process via NOVAMEM_SSE_KEEPALIVE_MS, read at
// session-open time like the TS resolveKeepaliveMs.
//
// The default and the parse rule come from the config registry rather
// than living here: a bare os.Getenv would be a variable with no
// declared default and no row in the generated environment reference,
// which is how a knob ends up undocumented.
func keepaliveInterval() time.Duration {
	return time.Duration(config.KeepaliveInterval()) * time.Millisecond
}

// rpcObj preserves key order the way a TS object literal does;
// encoding/json sorts map keys, which made JSON-RPC envelopes read
// {error,id,jsonrpc} against TS's {jsonrpc,error,id}.
type rpcObj []rpcKV

type rpcKV struct {
	K string
	V any
}

func (o rpcObj) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, e := range o {
		if i > 0 {
			b.WriteByte(',')
		}
		k, err := json.Marshal(e.K)
		if err != nil {
			return nil, err
		}
		b.Write(k)
		b.WriteByte(':')
		v, err := json.Marshal(e.V)
		if err != nil {
			return nil, err
		}
		b.Write(v)
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

// rpcErrEnvelope is the {jsonrpc,error,id} envelope in TS key order.
func rpcErrEnvelope(code int, message string) rpcObj {
	return rpcObj{
		{"jsonrpc", "2.0"},
		{"error", rpcObj{{"code", code}, {"message", message}}},
		{"id", nil},
	}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	b, err := json.Marshal(body)
	if err != nil {
		status = http.StatusInternalServerError
		b = []byte(`{"error":"internal server error"}`)
	}
	h := w.Header()
	h.Set("Content-Type", "application/json; charset=utf-8")
	// Same hardening headers the TS server's global hook stamps on every
	// response (http.ts / issue #47).
	h.Set("X-Frame-Options", "DENY")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "no-referrer")
	w.WriteHeader(status)
	_, _ = w.Write(b)
}

func readBody(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBodyBytes))
	if err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			writeJSON(w, http.StatusRequestEntityTooLarge, map[string]any{"error": "request body is too large"})
			return nil, false
		}
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "could not read request body"})
		return nil, false
	}
	return body, true
}

func isInitializeRequest(body []byte) bool {
	var m struct {
		Method string `json:"method"`
	}
	return json.Unmarshal(body, &m) == nil && m.Method == "initialize"
}

func sseHeaders(w http.ResponseWriter) {
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("Connection", "keep-alive")
	// "When initiating an SSE stream, servers SHOULD include the
	// X-Accel-Buffering: no header" — without it nginx (which fronts
	// every deployment of this we run) accumulates frames in a buffer
	// and the stream stops being a stream.
	h.Set("X-Accel-Buffering", "no")
	h.Set("X-Frame-Options", "DENY")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "no-referrer")
}

// ─── Streamable HTTP (/mcp) ────────────────────────────────────────────

// ServeStreamable handles POST/GET/DELETE /mcp for the authenticated
// userID. Responses to POSTed requests are plain application/json (the
// spec's single-response mode — clients accept either that or an SSE
// upgrade, and we never have server-initiated messages to interleave).
func (s *Server) ServeStreamable(w http.ResponseWriter, r *http.Request, userID string) {
	if !s.applyGuards(w, r) {
		return
	}

	// Dual-era routing (ADR 0006). The body is read once here and handed
	// to whichever era claims it; GET and DELETE are legacy-only and
	// carry none.
	var body []byte
	if r.Method == http.MethodPost {
		var ok bool
		if body, ok = readBody(w, r); !ok {
			return
		}
		if req, p, modern := classifyEra(r.Header.Get("Mcp-Protocol-Version"), body); modern {
			s.serveModern(w, r, userID, req, p)
			return
		}
	}
	s.serveLegacyStreamable(w, r, userID, body)
}

// serveLegacyStreamable is the initialize-handshake era: a session is
// minted by `initialize`, carried in Mcp-Session-Id, and torn down by
// DELETE. body is the already-read POST body, nil for GET/DELETE.
func (s *Server) serveLegacyStreamable(w http.ResponseWriter, r *http.Request,
	userID string, body []byte) {

	sessionID := r.Header.Get("Mcp-Session-Id")

	if sessionID == "" {
		// Only POST initialize may omit the session header.
		if r.Method != http.MethodPost {
			s.missingSession(w)
			return
		}
		if !isInitializeRequest(body) {
			s.missingSession(w)
			return
		}
		sess, ok := s.streamable.addOrGet(&session{
			id:     mintSessionID(s.sessionKey, userID, time.Now()),
			userID: userID, done: make(chan struct{})}, s.maxPerUser)
		if !ok {
			s.log.Warn("mcp-streamable: per-user session cap exceeded", "userId", userID, "cap", s.maxPerUser)
			writeJSON(w, http.StatusTooManyRequests, map[string]any{
				"error": "too many concurrent MCP sessions for this user"})
			return
		}
		s.log.Info("mcp-streamable: session opened", "sessionId", sess.id, "userId", userID)
		resp := s.handleMessage(r.Context(), sess, body)
		w.Header().Set("Mcp-Session-Id", sess.id)
		writeJSON(w, http.StatusOK, resp)
		return
	}

	sess := s.streamable.get(sessionID)
	if sess == nil {
		// A session this replica never minted may still be one this
		// deployment issued to this caller — that is what the signature
		// proves (ADR 0005). Adopting it is what lets any replica serve
		// any request; an id that does not verify for the caller gets
		// the same 404 as before, so it can never displace anyone.
		if !verifySessionID(s.sessionKey, userID, sessionID, time.Now()) {
			writeJSON(w, http.StatusNotFound, map[string]any{"error": "unknown sessionId"})
			return
		}
		adopted, ok := s.streamable.addOrGet(
			&session{id: sessionID, userID: userID, done: make(chan struct{})}, s.maxPerUser)
		if !ok {
			s.log.Warn("mcp-streamable: per-user session cap exceeded on adopt",
				"userId", userID, "cap", s.maxPerUser)
			writeJSON(w, http.StatusTooManyRequests, map[string]any{
				"error": "too many concurrent MCP sessions for this user"})
			return
		}
		sess = adopted
		s.log.Info("mcp-streamable: session adopted", "sessionId", sessionID, "userId", userID)
	}
	if sess.userID != userID {
		s.log.Warn("mcp-streamable: rejected request from non-owner",
			"sessionId", sessionID, "sessionOwner", sess.userID, "caller", userID)
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "session belongs to another user"})
		return
	}
	s.streamable.touch(sessionID)

	switch r.Method {
	case http.MethodPost:
		resp := s.handleMessage(r.Context(), sess, body)
		if resp == nil {
			// Notification: acknowledged, nothing to return.
			w.WriteHeader(http.StatusAccepted)
			return
		}
		writeJSON(w, http.StatusOK, resp)
	case http.MethodGet:
		// Server→client channel. We never push server-initiated messages,
		// so the stream only carries keepalives until either side closes.
		sseHeaders(w)
		w.WriteHeader(http.StatusOK)
		flush(w)
		s.keepaliveLoop(w, r, sess)
	case http.MethodDelete:
		s.streamable.remove(sessionID)
		s.log.Info("mcp-streamable: session closed", "sessionId", sessionID)
		w.WriteHeader(http.StatusOK)
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (s *Server) missingSession(w http.ResponseWriter) {
	writeJSON(w, http.StatusBadRequest, rpcErrEnvelope(-32000,
		"Bad Request: missing Mcp-Session-Id (only POST initialize may omit it)"))
}

// keepaliveLoop holds the streamable GET stream open with `: ping`
// comment frames until the client disconnects or the session is closed
// (reaper / shutdown).
//
// It used to relay outgoing frames too, for the legacy HTTP+SSE
// transport. That transport is gone (ADR 0007) and the streamable GET
// stream carries no server-initiated messages — the server emits no
// notifications and declares `listChanged: false` — so the loop is
// keepalive only.
func (s *Server) keepaliveLoop(w http.ResponseWriter, r *http.Request, sess *session) {
	ticker := time.NewTicker(keepaliveInterval())
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-sess.done:
			return
		case <-ticker.C:
			// `: ping` — the canonical SSE comment frame; clients ignore it
			// but the bytes reset their body-read timers.
			_, _ = io.WriteString(w, ": ping\n\n")
			flush(w)
		}
	}
}

func flush(w http.ResponseWriter) {
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
}
