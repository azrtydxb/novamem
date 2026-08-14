// The two HTTP transports. Wire behavior transcribed from
// routes/mcp-streamable.ts (single-endpoint Streamable HTTP: POST new
// sessions on initialize, session header Mcp-Session-Id, GET SSE
// channel, DELETE terminate) and routes/mcp-sse.ts (legacy pair:
// GET /mcp/sse endpoint-frame handshake, POST /mcp/messages?sessionId=
// answering 202 with responses on the stream, keepalive pings, idle
// reaper). Status codes and error-body strings are contract.
package mcp

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strconv"
	"time"
)

// maxBodyBytes matches the TS server's global 2MB body limit.
const maxBodyBytes = 2 * 1024 * 1024

// defaultKeepalive — mcp-sse.ts DEFAULT_KEEPALIVE_INTERVAL_MS (25 s,
// comfortably under undici's 5-minute body-read timeout). Overridable
// per-process via NOVAMEM_SSE_KEEPALIVE_MS, read at session-open time
// like the TS resolveKeepaliveMs.
const defaultKeepalive = 25 * time.Second

func keepaliveInterval() time.Duration {
	raw := os.Getenv("NOVAMEM_SSE_KEEPALIVE_MS")
	if n, err := strconv.Atoi(raw); err == nil && n > 0 {
		return time.Duration(n) * time.Millisecond
	}
	return defaultKeepalive
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
	sessionID := r.Header.Get("Mcp-Session-Id")

	if sessionID == "" {
		// Only POST initialize may omit the session header.
		if r.Method != http.MethodPost {
			s.missingSession(w)
			return
		}
		body, ok := readBody(w, r)
		if !ok {
			return
		}
		if !isInitializeRequest(body) {
			s.missingSession(w)
			return
		}
		if s.streamable.countForUser(userID) >= s.maxPerUser {
			s.log.Warn("mcp-streamable: per-user session cap exceeded", "userId", userID, "cap", s.maxPerUser)
			writeJSON(w, http.StatusTooManyRequests, map[string]any{
				"error": "too many concurrent MCP sessions for this user"})
			return
		}
		sess := &session{id: newSessionID(), userID: userID, done: make(chan struct{})}
		s.streamable.add(sess)
		s.log.Info("mcp-streamable: session opened", "sessionId", sess.id, "userId", userID)
		resp := s.handleMessage(r.Context(), sess, body)
		w.Header().Set("Mcp-Session-Id", sess.id)
		writeJSON(w, http.StatusOK, resp)
		return
	}

	sess := s.streamable.get(sessionID)
	if sess == nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "unknown sessionId"})
		return
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
		body, ok := readBody(w, r)
		if !ok {
			return
		}
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
		s.keepaliveLoop(w, r, sess, nil)
	case http.MethodDelete:
		s.streamable.remove(sessionID)
		s.log.Info("mcp-streamable: session closed", "sessionId", sessionID)
		w.WriteHeader(http.StatusOK)
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (s *Server) missingSession(w http.ResponseWriter) {
	writeJSON(w, http.StatusBadRequest, map[string]any{
		"jsonrpc": "2.0",
		"error": map[string]any{
			"code":    -32000,
			"message": "Bad Request: missing Mcp-Session-Id (only POST initialize may omit it)",
		},
		"id": nil,
	})
}

// ─── Legacy SSE (/mcp/sse + /mcp/messages) ─────────────────────────────

// ServeSSE handles GET /mcp/sse: opens the stream, sends the `endpoint`
// frame carrying the sessionId, then relays JSON-RPC responses (posted
// via /mcp/messages) as `message` frames, with keepalive comment pings.
func (s *Server) ServeSSE(w http.ResponseWriter, r *http.Request, userID string) {
	if !s.applyGuards(w, r) {
		return
	}
	if s.sse.countForUser(userID) >= s.maxPerUser {
		s.log.Warn("mcp-sse: per-user session cap exceeded", "userId", userID, "cap", s.maxPerUser)
		writeJSON(w, http.StatusTooManyRequests, map[string]any{
			"error": "too many concurrent SSE sessions for this user"})
		return
	}
	sess := &session{
		id:     newSessionID(),
		userID: userID,
		out:    make(chan []byte, 64),
		done:   make(chan struct{}),
	}
	s.sse.add(sess)
	s.log.Info("mcp-sse: session opened", "sessionId", sess.id, "userId", userID)

	sseHeaders(w)
	w.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(w, "event: endpoint\ndata: /mcp/messages?sessionId="+sess.id+"\n\n")
	flush(w)
	s.keepaliveLoop(w, r, sess, sess.out)
	s.sse.remove(sess.id)
	s.log.Info("mcp-sse: session closed", "sessionId", sess.id)
}

// keepaliveLoop pumps outgoing frames + `: ping` keepalives until the
// client disconnects or the session is closed (reaper / shutdown).
func (s *Server) keepaliveLoop(w http.ResponseWriter, r *http.Request, sess *session, out <-chan []byte) {
	ticker := time.NewTicker(keepaliveInterval())
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-sess.done:
			return
		case msg, ok := <-out:
			if !ok {
				return
			}
			_, _ = io.WriteString(w, "event: message\ndata: "+string(msg)+"\n\n")
			flush(w)
		case <-ticker.C:
			// `: ping` — the canonical SSE comment frame; clients ignore it
			// but the bytes reset their body-read timers.
			_, _ = io.WriteString(w, ": ping\n\n")
			flush(w)
		}
	}
}

// ServeMessages handles POST /mcp/messages?sessionId=…: authenticates
// the caller against the session owner, processes the JSON-RPC message,
// queues any response onto the SSE stream, and acks with 202.
func (s *Server) ServeMessages(w http.ResponseWriter, r *http.Request, userID string) {
	if !s.applyGuards(w, r) {
		return
	}
	sessionID := r.URL.Query().Get("sessionId")
	if sessionID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "missing sessionId"})
		return
	}
	sess := s.sse.get(sessionID)
	if sess == nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "unknown sessionId"})
		return
	}
	// Bind message posts to the session owner (issue #57): the sessionId
	// travels in the query string and leaks far more easily than an
	// Authorization header.
	if sess.userID != userID {
		s.log.Warn("mcp-sse: rejected POST /mcp/messages from non-owner",
			"sessionId", sessionID, "sessionOwner", sess.userID, "caller", userID)
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "session belongs to another user"})
		return
	}
	s.sse.touch(sessionID)
	body, ok := readBody(w, r)
	if !ok {
		return
	}
	resp := s.handleMessage(r.Context(), sess, body)
	if resp != nil {
		if b, err := json.Marshal(resp); err == nil {
			select {
			case sess.out <- b:
			default:
				// ponytail: bounded queue, drop-on-stall — a client that
				// stopped reading its stream for 64 responses is gone; block
				// here and a dead consumer wedges the POST path instead.
				s.log.Warn("mcp-sse: outgoing queue full, response dropped", "sessionId", sessionID)
			}
		}
	}
	w.WriteHeader(http.StatusAccepted)
	_, _ = io.WriteString(w, "Accepted")
}

func flush(w http.ResponseWriter) {
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
}
