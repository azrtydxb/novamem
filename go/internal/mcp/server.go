package mcp

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"
)

// CallFunc dispatches a tools/call onto the engine. Return
// ErrUnknownTool (possibly wrapped) for names outside the surface; any
// other error becomes "error: <msg>" isError content — never a
// protocol-level failure.
type CallFunc func(ctx context.Context, userID, name string, args map[string]any) (any, error)

// Defaults mirroring routes/mcp-streamable.ts + mcp-sse.ts.
const (
	defaultMaxSessionsPerUser = 10
	defaultIdleTimeout        = 30 * time.Minute
	defaultReapInterval       = 60 * time.Second
)

// Options configures a Server. Zero values take the TS defaults; the
// timeouts are overridable so tests can drive the reaper quickly.
type Options struct {
	Log            *slog.Logger
	Instructions   string
	AllowedOrigins []string
	Call           CallFunc

	MaxSessionsPerUser int
	IdleTimeout        time.Duration
	ReapInterval       time.Duration
}

// Server hosts both transports over shared JSON-RPC handling. One
// instance per process; the httpapi layer wires its routes to
// ServeStreamable / ServeSSE / ServeMessages after running auth.
type Server struct {
	log            *slog.Logger
	instructions   string
	allowedOrigins []string
	call           CallFunc
	maxPerUser     int

	streamable *registry
	sse        *registry
	stop       chan struct{}
	stopOnce   sync.Once
}

func NewServer(opts Options) *Server {
	if opts.MaxSessionsPerUser == 0 {
		opts.MaxSessionsPerUser = defaultMaxSessionsPerUser
	}
	if opts.IdleTimeout == 0 {
		opts.IdleTimeout = defaultIdleTimeout
	}
	if opts.ReapInterval == 0 {
		opts.ReapInterval = defaultReapInterval
	}
	s := &Server{
		log:            opts.Log,
		instructions:   opts.Instructions,
		allowedOrigins: opts.AllowedOrigins,
		call:           opts.Call,
		maxPerUser:     opts.MaxSessionsPerUser,
		streamable:     newRegistry(opts.IdleTimeout),
		sse:            newRegistry(opts.IdleTimeout),
		stop:           make(chan struct{}),
	}
	go s.reapLoop(opts.ReapInterval)
	return s
}

// Close stops the idle reaper and closes every live session.
func (s *Server) Close() {
	s.stopOnce.Do(func() { close(s.stop) })
	s.streamable.closeAll()
	s.sse.closeAll()
}

func (s *Server) reapLoop(interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-s.stop:
			return
		case <-t.C:
			for _, sess := range s.streamable.reapIdle() {
				s.log.Info("mcp-streamable: idle session reaped", "sessionId", sess.id, "userId", sess.userID)
			}
			for _, sess := range s.sse.reapIdle() {
				s.log.Info("mcp-sse: idle session reaped", "sessionId", sess.id, "userId", sess.userID)
			}
		}
	}
}

// ─── Sessions ──────────────────────────────────────────────────────────

type session struct {
	id     string
	userID string
	// lastActivity is unix ms, guarded by the registry mutex.
	lastActivity time.Time
	// out carries SSE `message` frames from POST /mcp/messages to the
	// stream goroutine. Nil for streamable sessions (responses are
	// synchronous there).
	out chan []byte
	// done closes when the session is removed (reaper / DELETE / server
	// shutdown) so a blocked stream goroutine exits.
	done      chan struct{}
	closeOnce sync.Once
}

func (sess *session) close() {
	sess.closeOnce.Do(func() { close(sess.done) })
}

type registry struct {
	mu          sync.Mutex
	sessions    map[string]*session
	idleTimeout time.Duration
}

func newRegistry(idleTimeout time.Duration) *registry {
	return &registry{sessions: map[string]*session{}, idleTimeout: idleTimeout}
}

func (r *registry) add(sess *session) {
	r.mu.Lock()
	defer r.mu.Unlock()
	sess.lastActivity = time.Now()
	r.sessions[sess.id] = sess
}

func (r *registry) get(id string) *session {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.sessions[id]
}

func (r *registry) touch(id string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if s := r.sessions[id]; s != nil {
		s.lastActivity = time.Now()
	}
}

func (r *registry) remove(id string) {
	r.mu.Lock()
	sess := r.sessions[id]
	delete(r.sessions, id)
	r.mu.Unlock()
	if sess != nil {
		sess.close()
	}
}

func (r *registry) countForUser(userID string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for _, s := range r.sessions {
		if s.userID == userID {
			n++
		}
	}
	return n
}

func (r *registry) reapIdle() []*session {
	cutoff := time.Now().Add(-r.idleTimeout)
	r.mu.Lock()
	var reaped []*session
	for id, s := range r.sessions {
		if s.lastActivity.Before(cutoff) {
			delete(r.sessions, id)
			reaped = append(reaped, s)
		}
	}
	r.mu.Unlock()
	for _, s := range reaped {
		s.close()
	}
	return reaped
}

func (r *registry) closeAll() {
	r.mu.Lock()
	all := make([]*session, 0, len(r.sessions))
	for id, s := range r.sessions {
		all = append(all, s)
		delete(r.sessions, id)
	}
	r.mu.Unlock()
	for _, s := range all {
		s.close()
	}
}

// newSessionID — a v4-style random UUID (crypto/rand; no dependency).
func newSessionID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err) // crypto/rand failure is unrecoverable
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// ─── JSON-RPC ──────────────────────────────────────────────────────────

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

func errResponse(id json.RawMessage, code int, message string) *rpcResponse {
	if id == nil {
		id = json.RawMessage("null")
	}
	return &rpcResponse{JSONRPC: "2.0", ID: id, Error: &rpcError{Code: code, Message: message}}
}

func okResponse(id json.RawMessage, result any) *rpcResponse {
	return &rpcResponse{JSONRPC: "2.0", ID: id, Result: result}
}

type toolContent struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type toolCallResult struct {
	Content []toolContent `json:"content"`
	IsError bool          `json:"isError,omitempty"`
}

func textResult(text string, isError bool) toolCallResult {
	return toolCallResult{Content: []toolContent{{Type: "text", Text: text}}, IsError: isError}
}

// handleMessage processes one JSON-RPC message on a session. Returns
// nil for notifications (and for unknown notification methods).
func (s *Server) handleMessage(ctx context.Context, sess *session, raw []byte) *rpcResponse {
	var req rpcRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		return errResponse(nil, -32700, "Parse error")
	}
	isNotification := len(req.ID) == 0

	switch req.Method {
	case "initialize":
		var p struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		_ = json.Unmarshal(req.Params, &p)
		version := p.ProtocolVersion
		if !supportedProtocolVersion(version) {
			// Spec: an unsupported requested version is answered with the
			// server's latest supported version, not an error.
			version = SupportedProtocolVersions[len(SupportedProtocolVersions)-1]
		}
		return okResponse(req.ID, map[string]any{
			"protocolVersion": version,
			// listChanged: false — the tool list is static for the process
			// lifetime, exactly like mcp.ts declares.
			"capabilities": map[string]any{"tools": map[string]any{"listChanged": false}},
			"serverInfo":   map[string]any{"name": "novamem", "version": "0.1.0"},
			"instructions": s.instructions,
		})
	case "ping":
		return okResponse(req.ID, map[string]any{})
	case "tools/list":
		return okResponse(req.ID, map[string]any{"tools": ToolDefinitions()})
	case "tools/call":
		var p struct {
			Name      string         `json:"name"`
			Arguments map[string]any `json:"arguments"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil || p.Name == "" {
			return errResponse(req.ID, -32602, "Invalid params")
		}
		return okResponse(req.ID, s.callTool(ctx, sess.userID, p.Name, p.Arguments))
	default:
		if isNotification {
			// notifications/initialized, notifications/cancelled, …: nothing
			// to do, nothing to answer.
			return nil
		}
		return errResponse(req.ID, -32601, "Method not found")
	}
}

// callTool runs the injected dispatcher and shapes the result exactly
// like mcp.ts: JSON.stringify(result) as text content on success;
// "unknown tool: X" / "error: <msg>" as isError content on failure.
func (s *Server) callTool(ctx context.Context, userID, name string, args map[string]any) toolCallResult {
	if args == nil {
		args = map[string]any{}
	}
	result, err := s.call(ctx, userID, name, args)
	switch {
	case err == nil:
		text, mErr := json.Marshal(result)
		if mErr != nil {
			s.log.Error("mcp: tool result marshal failed", "tool", name, "err", mErr)
			return textResult("error: internal serialization failure", true)
		}
		return textResult(string(text), false)
	case errors.Is(err, ErrUnknownTool):
		return textResult(fmt.Sprintf("unknown tool: %s", name), true)
	default:
		return textResult(fmt.Sprintf("error: %s", err.Error()), true)
	}
}
