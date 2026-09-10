package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// fakeStreamable imitates the server's streamable transport surface:
// initialize mints a session id, later POSTs require it, notifications
// get 202, and DELETE tears the session down.
func fakeStreamable(t *testing.T, deleted *atomic.Bool) http.HandlerFunc {
	t.Helper()
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			if r.Header.Get("Mcp-Session-Id") == "sess-1" {
				deleted.Store(true)
			}
			w.WriteHeader(http.StatusOK)
			return
		}
		body, _ := io.ReadAll(r.Body)
		var msg struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
		}
		if err := json.Unmarshal(body, &msg); err != nil {
			t.Errorf("non-JSON body reached server: %q", body)
		}
		if msg.Method == "initialize" {
			w.Header().Set("Mcp-Session-Id", "sess-1")
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":` + string(msg.ID) + `,"result":{"serverInfo":{"name":"novamem"}}}`))
			return
		}
		if len(msg.ID) == 0 { // notification
			w.WriteHeader(http.StatusAccepted)
			return
		}
		if r.Header.Get("Mcp-Session-Id") != "sess-1" {
			t.Errorf("request %s lacked the session header", msg.Method)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":` + string(msg.ID) + `,"result":{"tools":[]}}`))
	}
}

func TestBridgeHandshakeSessionAndTeardown(t *testing.T) {
	var deleted atomic.Bool
	srv := httptest.NewServer(fakeStreamable(t, &deleted))
	defer srv.Close()

	var out bytes.Buffer
	b := &bridge{endpoint: srv.URL, client: srv.Client(), out: &out}
	in := strings.Join([]string{
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`,
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`,
	}, "\n") + "\n"
	// All three lines arrive at once — the bridge must serialize until
	// initialize's response mints the session id, or tools/list races
	// ahead and is rejected for a missing Mcp-Session-Id.
	if err := b.run(strings.NewReader(in)); err != nil {
		t.Fatal(err)
	}

	lines := nonEmptyLines(out.String())
	if len(lines) != 2 {
		t.Fatalf("got %d output lines, want 2 (initialize + tools/list; notification is silent):\n%s", len(lines), out.String())
	}
	for _, l := range lines {
		var env struct {
			ID     json.RawMessage `json:"id"`
			Result json.RawMessage `json:"result"`
		}
		if err := json.Unmarshal([]byte(l), &env); err != nil || len(env.Result) == 0 {
			t.Fatalf("output line is not a JSON-RPC result: %q", l)
		}
	}
	if !deleted.Load() {
		t.Fatal("EOF did not DELETE the session")
	}
}

func TestBridgeAnswersTransportFailureWithRPCError(t *testing.T) {
	var out bytes.Buffer
	b := &bridge{
		endpoint: "http://127.0.0.1:1/mcp", // nothing listens here
		client:   &http.Client{Timeout: 2 * time.Second},
		out:      &out,
	}
	if err := b.run(strings.NewReader(`{"jsonrpc":"2.0","id":7,"method":"tools/list"}` + "\n")); err != nil {
		t.Fatal(err)
	}
	lines := nonEmptyLines(out.String())
	if len(lines) != 1 {
		t.Fatalf("want exactly one error envelope, got: %q", out.String())
	}
	var env struct {
		ID    int `json:"id"`
		Error struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal([]byte(lines[0]), &env); err != nil {
		t.Fatal(err)
	}
	if env.ID != 7 || env.Error.Code != -32603 {
		t.Fatalf("error envelope = %+v, want id 7 code -32603", env)
	}
}

func TestSSEDataExtraction(t *testing.T) {
	body := []byte("event: message\ndata: {\"a\":1}\n\ndata: {\"b\":\ndata: 2}\n\n")
	got := sseData(body)
	if len(got) != 2 || string(got[0]) != `{"a":1}` || string(got[1]) != `{"b":2}` {
		t.Fatalf("sseData = %q", got)
	}
}

func nonEmptyLines(s string) []string {
	var out []string
	for _, l := range strings.Split(s, "\n") {
		if strings.TrimSpace(l) != "" {
			out = append(out, l)
		}
	}
	return out
}
