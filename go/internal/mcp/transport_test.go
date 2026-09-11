package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
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

const initBody = `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}`

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
	if initResp.Result.ProtocolVersion != "2025-06-18" {
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
	// An unsupported version answers with the spec's
	// UnsupportedProtocolVersionError, listing what to retry with: a
	// dual-era client keys its retry-vs-downgrade decision off this code.
	rec = post(t, h, initBody, map[string]string{"Mcp-Protocol-Version": "1999-01-01"})
	if rec.Code != http.StatusBadRequest ||
		!bytes.Contains(rec.Body.Bytes(), []byte(`"code":-32022`)) ||
		!bytes.Contains(rec.Body.Bytes(), []byte(`"requested":"1999-01-01"`)) ||
		!bytes.Contains(rec.Body.Bytes(), []byte(`"supported":["2024-11-05"`)) {
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
