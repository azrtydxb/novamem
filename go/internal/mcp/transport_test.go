package mcp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"
)

func testServer(t *testing.T, opts Options) *Server {
	t.Helper()
	if opts.Log == nil {
		opts.Log = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	if opts.Call == nil {
		opts.Call = func(_ context.Context, userID, name string, _ map[string]any) (any, error) {
			switch name {
			case "memory_stats":
				return map[string]any{"totalWarm": 0, "user": userID}, nil
			case "boom":
				return nil, fmt.Errorf("kaput")
			default:
				return nil, ErrUnknownTool
			}
		}
	}
	s := NewServer(opts)
	t.Cleanup(s.Close)
	return s
}

func streamableHandler(s *Server, userID string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.ServeStreamable(w, r, userID)
	})
}

func post(t *testing.T, h http.Handler, body string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(body))
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

const initBody = `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}`

func openSession(t *testing.T, h http.Handler) string {
	t.Helper()
	rec := post(t, h, initBody, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("initialize: %d %s", rec.Code, rec.Body)
	}
	sid := rec.Header().Get("Mcp-Session-Id")
	if sid == "" {
		t.Fatal("no Mcp-Session-Id header on initialize response")
	}
	return sid
}

func TestStreamableInitializeAndToolsList(t *testing.T) {
	s := testServer(t, Options{Instructions: "test instructions"})
	h := streamableHandler(s, "public")

	rec := post(t, h, initBody, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("initialize: %d %s", rec.Code, rec.Body)
	}
	var initResp struct {
		Result struct {
			ProtocolVersion string         `json:"protocolVersion"`
			Capabilities    map[string]any `json:"capabilities"`
			ServerInfo      struct {
				Name string `json:"name"`
			} `json:"serverInfo"`
			Instructions string `json:"instructions"`
		} `json:"result"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &initResp); err != nil {
		t.Fatal(err)
	}
	if initResp.Result.ProtocolVersion != "2025-03-26" {
		t.Fatalf("requested supported version must be echoed, got %q", initResp.Result.ProtocolVersion)
	}
	if initResp.Result.ServerInfo.Name != "novamem" {
		t.Fatalf("serverInfo.name = %q", initResp.Result.ServerInfo.Name)
	}
	if initResp.Result.Instructions != "test instructions" {
		t.Fatal("instructions not surfaced on initialize")
	}
	sid := rec.Header().Get("Mcp-Session-Id")

	// notifications/initialized → 202, no body.
	rec = post(t, h, `{"jsonrpc":"2.0","method":"notifications/initialized"}`, map[string]string{"Mcp-Session-Id": sid})
	if rec.Code != http.StatusAccepted {
		t.Fatalf("notification: %d", rec.Code)
	}

	rec = post(t, h, `{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`, map[string]string{"Mcp-Session-Id": sid})
	var listResp struct {
		Result struct {
			Tools []struct {
				Name        string         `json:"name"`
				InputSchema map[string]any `json:"inputSchema"`
			} `json:"tools"`
		} `json:"result"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &listResp); err != nil {
		t.Fatal(err)
	}
	if len(listResp.Result.Tools) != 21 {
		t.Fatalf("tools/list returned %d tools", len(listResp.Result.Tools))
	}

	// tools/call round-trip through the stub dispatcher.
	rec = post(t, h, `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"memory_stats","arguments":{}}}`, map[string]string{"Mcp-Session-Id": sid})
	var callResp struct {
		Result struct {
			Content []struct{ Type, Text string } `json:"content"`
			IsError bool                          `json:"isError"`
		} `json:"result"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &callResp); err != nil {
		t.Fatal(err)
	}
	if callResp.Result.IsError || !strings.Contains(callResp.Result.Content[0].Text, `"user":"public"`) {
		t.Fatalf("tools/call result: %s", rec.Body)
	}

	// Unknown tool and dispatcher error are tool-level isError content,
	// never protocol failures.
	rec = post(t, h, `{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"memory_nonexistent","arguments":{}}}`, map[string]string{"Mcp-Session-Id": sid})
	if !bytes.Contains(rec.Body.Bytes(), []byte("unknown tool: memory_nonexistent")) || !bytes.Contains(rec.Body.Bytes(), []byte(`"isError":true`)) {
		t.Fatalf("unknown tool: %s", rec.Body)
	}
	rec = post(t, h, `{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"boom","arguments":{}}}`, map[string]string{"Mcp-Session-Id": sid})
	if !bytes.Contains(rec.Body.Bytes(), []byte("error: kaput")) {
		t.Fatalf("tool error: %s", rec.Body)
	}

	// ping answers an empty result; unknown request method → -32601.
	rec = post(t, h, `{"jsonrpc":"2.0","id":6,"method":"ping"}`, map[string]string{"Mcp-Session-Id": sid})
	if !bytes.Contains(rec.Body.Bytes(), []byte(`"result":{}`)) {
		t.Fatalf("ping: %s", rec.Body)
	}
	rec = post(t, h, `{"jsonrpc":"2.0","id":7,"method":"bogus/method"}`, map[string]string{"Mcp-Session-Id": sid})
	if !bytes.Contains(rec.Body.Bytes(), []byte(`-32601`)) {
		t.Fatalf("unknown method: %s", rec.Body)
	}
}

func TestStreamableSessionErrors(t *testing.T) {
	s := testServer(t, Options{})
	h := streamableHandler(s, "public")

	// Non-initialize POST without a session id → the TS 400 shape.
	rec := post(t, h, `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`, nil)
	if rec.Code != http.StatusBadRequest || !bytes.Contains(rec.Body.Bytes(), []byte("missing Mcp-Session-Id")) {
		t.Fatalf("missing session: %d %s", rec.Code, rec.Body)
	}

	// Unknown session id → 404 {"error":"unknown sessionId"}.
	rec = post(t, h, `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`, map[string]string{"Mcp-Session-Id": "nope"})
	if rec.Code != http.StatusNotFound || !bytes.Contains(rec.Body.Bytes(), []byte(`"unknown sessionId"`)) {
		t.Fatalf("unknown session: %d %s", rec.Code, rec.Body)
	}

	// Another authenticated user driving a leaked session id → 403.
	sid := openSession(t, h)
	other := streamableHandler(s, "intruder")
	rec = post(t, other, `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`, map[string]string{"Mcp-Session-Id": sid})
	if rec.Code != http.StatusForbidden || !bytes.Contains(rec.Body.Bytes(), []byte(`"session belongs to another user"`)) {
		t.Fatalf("ownership: %d %s", rec.Code, rec.Body)
	}

	// DELETE terminates; the id is gone afterwards.
	req := httptest.NewRequest(http.MethodDelete, "/mcp", nil)
	req.Header.Set("Mcp-Session-Id", sid)
	del := httptest.NewRecorder()
	h.ServeHTTP(del, req)
	if del.Code != http.StatusOK {
		t.Fatalf("delete: %d", del.Code)
	}
	rec = post(t, h, `{"jsonrpc":"2.0","id":3,"method":"tools/list"}`, map[string]string{"Mcp-Session-Id": sid})
	if rec.Code != http.StatusNotFound {
		t.Fatalf("post-delete: %d", rec.Code)
	}
}

func TestStreamableSessionCap(t *testing.T) {
	s := testServer(t, Options{MaxSessionsPerUser: 3})
	h := streamableHandler(s, "public")
	for i := 0; i < 3; i++ {
		openSession(t, h)
	}
	rec := post(t, h, initBody, nil)
	if rec.Code != http.StatusTooManyRequests ||
		!bytes.Contains(rec.Body.Bytes(), []byte("too many concurrent MCP sessions for this user")) {
		t.Fatalf("cap: %d %s", rec.Code, rec.Body)
	}
	// A different user still gets a session — the cap is per-user.
	openSession(t, streamableHandler(s, "someone-else"))
}

func TestStreamableGuards(t *testing.T) {
	s := testServer(t, Options{AllowedOrigins: []string{"http://localhost:5173"}})
	h := streamableHandler(s, "public")

	rec := post(t, h, initBody, map[string]string{"Origin": "https://evil.example.com"})
	if rec.Code != http.StatusForbidden || !bytes.Contains(rec.Body.Bytes(), []byte("Forbidden:")) {
		t.Fatalf("origin guard: %d %s", rec.Code, rec.Body)
	}
	rec = post(t, h, initBody, map[string]string{"Mcp-Protocol-Version": "1999-01-01"})
	if rec.Code != http.StatusBadRequest || !bytes.Contains(rec.Body.Bytes(), []byte("unsupported MCP-Protocol-Version")) {
		t.Fatalf("version guard: %d %s", rec.Code, rec.Body)
	}
	// Allowlisted origin + supported version pass.
	rec = post(t, h, initBody, map[string]string{"Origin": "http://localhost:5173", "Mcp-Protocol-Version": "2025-06-18"})
	if rec.Code != http.StatusOK {
		t.Fatalf("guards must pass: %d %s", rec.Code, rec.Body)
	}
}

func TestStreamableIdleReap(t *testing.T) {
	s := testServer(t, Options{IdleTimeout: 20 * time.Millisecond, ReapInterval: 10 * time.Millisecond})
	h := streamableHandler(s, "public")
	sid := openSession(t, h)
	deadline := time.Now().Add(2 * time.Second)
	for {
		rec := post(t, h, `{"jsonrpc":"2.0","id":2,"method":"ping"}`, map[string]string{"Mcp-Session-Id": sid})
		if rec.Code == http.StatusNotFound {
			return // reaped
		}
		if time.Now().After(deadline) {
			t.Fatalf("session never reaped (last status %d)", rec.Code)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestSSERoundTrip(t *testing.T) {
	t.Setenv("NOVAMEM_SSE_KEEPALIVE_MS", "50")
	s := testServer(t, Options{})
	mux := http.NewServeMux()
	mux.HandleFunc("GET /mcp/sse", func(w http.ResponseWriter, r *http.Request) { s.ServeSSE(w, r, "public") })
	mux.HandleFunc("POST /mcp/messages", func(w http.ResponseWriter, r *http.Request) {
		user := r.Header.Get("X-Test-User")
		if user == "" {
			user = "public"
		}
		s.ServeMessages(w, r, user)
	})
	ts := httptest.NewServer(mux)
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/mcp/sse")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK || resp.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatalf("sse open: %d %s", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
	reader := bufio.NewReader(resp.Body)

	readFrame := func() (event, data string) {
		t.Helper()
		for {
			line, err := reader.ReadString('\n')
			if err != nil {
				t.Fatalf("stream read: %v", err)
			}
			line = strings.TrimRight(line, "\n")
			switch {
			case strings.HasPrefix(line, "event: "):
				event = line[len("event: "):]
			case strings.HasPrefix(line, "data: "):
				data += line[len("data: "):]
			case line == "" && (event != "" || data != ""):
				return event, data
			}
			// Comment keepalives (`: ping`) fall through and are skipped.
		}
	}

	event, data := readFrame()
	if event != "endpoint" {
		t.Fatalf("first frame %q %q", event, data)
	}
	m := regexp.MustCompile(`sessionId=([A-Za-z0-9-]+)`).FindStringSubmatch(data)
	if m == nil {
		t.Fatalf("endpoint frame carries no sessionId: %q", data)
	}
	sessionID := m[1]

	postMsg := func(user, body string) *http.Response {
		t.Helper()
		req, _ := http.NewRequest(http.MethodPost, ts.URL+"/mcp/messages?sessionId="+sessionID, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if user != "" {
			req.Header.Set("X-Test-User", user)
		}
		r, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return r
	}

	// Ownership: a different authenticated user is rejected with the TS
	// error body before any processing.
	r := postMsg("intruder", initBody)
	b, _ := io.ReadAll(r.Body)
	r.Body.Close()
	if r.StatusCode != http.StatusForbidden || !bytes.Contains(b, []byte(`"session belongs to another user"`)) {
		t.Fatalf("sse ownership: %d %s", r.StatusCode, b)
	}

	// initialize → 202 ack; result arrives on the stream.
	r = postMsg("", initBody)
	io.Copy(io.Discard, r.Body) //nolint:errcheck
	r.Body.Close()
	if r.StatusCode != http.StatusAccepted {
		t.Fatalf("sse post: %d", r.StatusCode)
	}
	event, data = readFrame()
	if event != "message" || !strings.Contains(data, `"protocolVersion"`) {
		t.Fatalf("initialize response frame: %q %q", event, data)
	}

	// tools/list round-trips with the full surface.
	r = postMsg("", `{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`)
	io.Copy(io.Discard, r.Body) //nolint:errcheck
	r.Body.Close()
	_, data = readFrame()
	var listResp struct {
		Result struct {
			Tools []struct {
				Name string `json:"name"`
			} `json:"tools"`
		} `json:"result"`
	}
	if err := json.Unmarshal([]byte(data), &listResp); err != nil {
		t.Fatalf("tools/list frame: %v (%q)", err, data)
	}
	if len(listResp.Result.Tools) != 21 {
		t.Fatalf("sse tools/list: %d tools", len(listResp.Result.Tools))
	}

	// Unknown / missing session error shapes.
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/mcp/messages?sessionId=nope", strings.NewReader(initBody))
	r, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	b, _ = io.ReadAll(r.Body)
	r.Body.Close()
	if r.StatusCode != http.StatusNotFound || !bytes.Contains(b, []byte(`"unknown sessionId"`)) {
		t.Fatalf("sse unknown session: %d %s", r.StatusCode, b)
	}
	req, _ = http.NewRequest(http.MethodPost, ts.URL+"/mcp/messages", strings.NewReader(initBody))
	r, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	b, _ = io.ReadAll(r.Body)
	r.Body.Close()
	if r.StatusCode != http.StatusBadRequest || !bytes.Contains(b, []byte(`"missing sessionId"`)) {
		t.Fatalf("sse missing session: %d %s", r.StatusCode, b)
	}
}

func TestSSESessionCap(t *testing.T) {
	s := testServer(t, Options{MaxSessionsPerUser: 1})
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.ServeSSE(w, r, "public")
	}))
	defer ts.Close()

	first, err := http.Get(ts.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Body.Close()
	// Read the endpoint frame so the session is fully open.
	buf := make([]byte, 64)
	if _, err := first.Body.Read(buf); err != nil {
		t.Fatal(err)
	}

	second, err := http.Get(ts.URL)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(second.Body)
	second.Body.Close()
	if second.StatusCode != http.StatusTooManyRequests ||
		!bytes.Contains(b, []byte("too many concurrent SSE sessions for this user")) {
		t.Fatalf("sse cap: %d %s", second.StatusCode, b)
	}
}
